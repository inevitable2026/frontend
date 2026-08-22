"use client";

import { useState, type FormEvent } from "react";

import { isRecord, asText, parseEvent } from "./parse";
import type { ToolCall } from "./types";

/**
 * `/api/chat` 한 번의 왕복을 쥐는 훅. **호출부마다 상태가 따로 생긴다** — 챗봇 탭과
 * 보드의 AI 사이드바는 같은 라우트를 쓰지만 대화는 서로 섞이지 않는다.
 *
 * 라우트는 지금 완성된 JSON 을 한 번에 돌려주고, 스트림 분기는 서버가 흘려보내기
 * 시작할 때를 대비해 남겨 둔 것이다. 두 경로 모두 `parseEvent` 로 들어간다.
 */
export type LawChat = {
  question: string;
  setQuestion: (value: string) => void;
  lastQuestion: string;
  toolCalls: ToolCall[];
  answer: string;
  error: string;
  isSubmitting: boolean;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

async function readResponseError(response: Response): Promise<string> {
  const fallback = `요청에 실패했습니다. (${response.status})`;

  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return fallback;

    const nestedError = payload.error;
    const message = isRecord(nestedError)
      ? asText(nestedError.message)
      : asText(nestedError) ?? asText(payload.message);

    return message ? `${message} (${response.status})` : fallback;
  } catch {
    return fallback;
  }
}

export function useLawChat(): LawChat {
  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || isSubmitting) return;

    setLastQuestion(trimmedQuestion);
    setQuestion("");
    setToolCalls([]);
    setAnswer("");
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmedQuestion }),
      });

      if (!response.ok) throw new Error(await readResponseError(response));

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const payload: unknown = await response.json();
        const events = isRecord(payload) && Array.isArray(payload.events) ? payload.events : [payload];
        const results = events.map((item, index) => parseEvent(item, index));
        const receivedTools = results.flatMap((result) => result.tool ? [result.tool] : []);
        if (receivedTools.length) setToolCalls(receivedTools);
        const receivedAnswer = results.flatMap((result) => result.answer ? [result.answer] : []).join("");
        if (receivedAnswer) setAnswer(receivedAnswer);
        const receivedError = results.find((result) => result.error)?.error;
        if (receivedError) setError(receivedError);
        return;
      }

      if (!response.body) throw new Error("응답 본문을 읽을 수 없습니다.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventIndex = 0;

      const applyPayload = (serialized: string) => {
        if (!serialized.trim() || serialized === "[DONE]") return;
        try {
          const result = parseEvent(JSON.parse(serialized), eventIndex++);
          if (result.tool) {
            setToolCalls((current) => {
              const matchingIndex = current.findIndex((item) => item.id === result.tool?.id);
              if (matchingIndex === -1) return [...current, result.tool as ToolCall];
              return current.map((item, itemIndex) => itemIndex === matchingIndex ? { ...item, ...result.tool } : item);
            });
          }
          if (result.answer) setAnswer((current) => current + result.answer);
          if (result.error) setError(result.error);
        } catch {
          setAnswer((current) => current + serialized);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
          if (payload) applyPayload(payload);
        }
        if (done) break;
      }

      if (buffer.trim()) {
        const payload = buffer.startsWith("data:") ? buffer.slice(5).trim() : buffer.trim();
        applyPayload(payload);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "응답을 가져오지 못했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return { question, setQuestion, lastQuestion, toolCalls, answer, error, isSubmitting, submit };
}
