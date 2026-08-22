"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { asText, isRecord, parseEvent } from "./parse";
import type { ChatTurn, ToolCall } from "./types";

export type LawChat = {
  question: string;
  setQuestion: (value: string) => void;
  turns: ChatTurn[];
  pendingTurn: ChatTurn | null;
  error: string;
  isSubmitting: boolean;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  newConversation: () => void;
};

type ChatOptions = {
  siteId: string;
  conversationId: string | null;
  onConversationCreated: (conversationId: string) => void;
  onNewConversation: () => void;
};

function makeCommandId(): string {
  return crypto.randomUUID();
}

type ResponseFailure = Error & { conversationId?: string; turn?: ChatTurn };

async function readResponseError(response: Response): Promise<ResponseFailure> {
  const fallback = `요청에 실패했습니다. (${response.status})`;
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return new Error(fallback);
    const nestedError = payload.error;
    const message = isRecord(nestedError) ? asText(nestedError.message) : asText(nestedError) ?? asText(payload.message);
    const error = new Error(message ? `${message} (${response.status})` : fallback) as ResponseFailure;
    error.conversationId = asText(payload.conversationId);
    error.turn = turnFrom(payload.turn) ?? undefined;
    return error;
  } catch {
    return new Error(fallback);
  }
}

function toolCallsFrom(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const parsed = parseEvent({ type: "tool", ...(isRecord(item) ? item : {}) }, index).tool;
    return parsed ? [parsed] : [];
  });
}

function turnFrom(value: unknown): ChatTurn | null {
  if (!isRecord(value) || typeof value.question !== "string") return null;
  const status = asText(value.status) ?? "completed";
  return {
    id: asText(value.turnId ?? value.id) ?? "",
    commandId: asText(value.commandId) ?? "",
    conversationId: asText(value.conversationId) ?? "",
    seq: typeof value.sequence === "number" ? value.sequence : typeof value.seq === "number" ? value.seq : 0,
    question: value.question,
    answer: asText(value.assistantText ?? value.answer) ?? "",
    toolCalls: toolCallsFrom(value.toolCalls),
    error: asText(value.failureMessage ?? value.error) ?? "",
    status,
  };
}

/** Stored conversation hydration and one in-flight request are kept separate. */
export function useLawChat({ siteId, conversationId, onConversationCreated, onNewConversation }: ChatOptions): LawChat {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [pendingTurn, setPendingTurn] = useState<ChatTurn | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const epoch = useRef(0);
  const activeConversationId = useRef(conversationId);
  const canonicalizingConversation = useRef<{ siteId: string; conversationId: string } | null>(null);

  useEffect(() => {
    if (
      conversationId !== null
      && canonicalizingConversation.current?.siteId === siteId
      && canonicalizingConversation.current.conversationId === conversationId
      && activeConversationId.current === conversationId
    ) {
      canonicalizingConversation.current = null;
      return;
    }
    const requestEpoch = ++epoch.current;
    const controller = new AbortController();
    activeConversationId.current = conversationId;
    // This reset is the visible boundary between two URL-addressed resources;
    // doing it before the fetch prevents the previous conversation flashing.
    setTurns([]);
    setPendingTurn(null);
    setError("");
    setIsSubmitting(false);
    if (!conversationId) return () => controller.abort();

    void fetch(`/api/chat?siteId=${encodeURIComponent(siteId)}&conversationId=${encodeURIComponent(conversationId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw await readResponseError(response);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.turns)) throw new Error("저장된 대화 응답 형식이 올바르지 않습니다.");
        return payload.turns.map(turnFrom).filter((turn): turn is ChatTurn => turn !== null).sort((a, b) => a.seq - b.seq);
      })
      .then((loadedTurns) => {
        if (epoch.current === requestEpoch) setTurns(loadedTurns);
      })
      .catch((loadError) => {
        if (controller.signal.aborted || epoch.current !== requestEpoch) return;
        setError(loadError instanceof Error ? loadError.message : "저장된 대화를 불러오지 못했습니다.");
      });
    return () => controller.abort();
  }, [siteId, conversationId]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isSubmitting) return;

    const requestEpoch = epoch.current;
    const submittedConversationId = activeConversationId.current;
    const commandId = makeCommandId();
    const initial: ChatTurn = { id: commandId, commandId, conversationId: submittedConversationId ?? "", seq: Number.MAX_SAFE_INTEGER, question: trimmedQuestion, answer: "", toolCalls: [], error: "", status: "pending" };
    setQuestion("");
    setError("");
    setPendingTurn(initial);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, conversationId: submittedConversationId, commandId, question: trimmedQuestion }),
      });
      if (!response.ok) throw await readResponseError(response);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.conversationId !== "string") throw new Error("대화 식별자가 없는 응답입니다.");
      const events = Array.isArray(payload.events) ? payload.events : [];
      const results = events.map((item, index) => parseEvent(item, index));
      const saved = turnFrom(payload.turn);
      const completed: ChatTurn = saved ?? {
        ...initial,
        conversationId: payload.conversationId,
        toolCalls: results.flatMap((result) => result.tool ? [result.tool] : []),
        answer: results.flatMap((result) => result.answer ? [result.answer] : []).join(""),
        error: results.find((result) => result.error)?.error ?? "",
        status: "completed",
      };
      if (epoch.current !== requestEpoch) return;
      activeConversationId.current = payload.conversationId;
      setTurns((current) => [...current.filter((turn) => turn.commandId !== commandId), completed].sort((a, b) => a.seq - b.seq));
      setPendingTurn(null);
      if (!submittedConversationId) {
        canonicalizingConversation.current = { siteId, conversationId: payload.conversationId };
        onConversationCreated(payload.conversationId);
      }
    } catch (requestError) {
      if (epoch.current !== requestEpoch) return;
      const message = requestError instanceof Error ? requestError.message : "응답을 가져오지 못했습니다.";
      const failure = requestError as ResponseFailure;
      if (failure.turn) {
        if (failure.conversationId) activeConversationId.current = failure.conversationId;
        setTurns((current) => [...current.filter((turn) => turn.commandId !== failure.turn!.commandId), failure.turn!].sort((a, b) => a.seq - b.seq));
        setPendingTurn(null);
        if (!submittedConversationId && failure.conversationId) {
          canonicalizingConversation.current = { siteId, conversationId: failure.conversationId };
          onConversationCreated(failure.conversationId);
        }
      } else {
        setPendingTurn((current) => current ? { ...current, error: message, status: "error" } : current);
      }
      setError(message);
    } finally {
      if (epoch.current === requestEpoch) setIsSubmitting(false);
    }
  }

  function newConversation(): void {
    epoch.current += 1;
    activeConversationId.current = null;
    canonicalizingConversation.current = null;
    setQuestion("");
    setTurns([]);
    setPendingTurn(null);
    setError("");
    setIsSubmitting(false);
    onNewConversation();
  }

  return { question, setQuestion, turns, pendingTurn, error, isSubmitting, submit, newConversation };
}
