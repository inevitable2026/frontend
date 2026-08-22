"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";

import { ChatAskBar } from "@/components/chat/chat-ask-bar";
import { ASSISTANT_LABEL, isActivePrompt, PROMPT_CARDS } from "@/components/chat/prompts";
import type { BoardActionOutput, BoardContext } from "@/lib/board/assistant-tools";

import { AssistantMessageView } from "./assistant-stream";
import type { BoardColumnId } from "./types";

/**
 * 보드 오른쪽에 서는 AI 사이드바. 기획안(`docs/plan-task-board.md` 1.1)대로 **보드를
 * 덮는다** — 왼쪽 폭이 줄지 않으므로 칸반 열 너비도 그대로다. 기준점은 `.board-shell`
 * 이 아니라 뷰포트인데, 보드가 화면보다 길어서 절대 위치로 두면 스크롤과 함께 밀려난다.
 *
 * 들어온 문장은 **하나도 화면에서 해석하지 않는다.** 전부 `/api/board/assistant` 로 가고,
 * 카드를 읽을지 고칠지 법령 원문을 찾을지는 모델이 도구를 부르며 정한다. 이 파일이 하는 일은
 * 셋이다.
 * - 보낼 때마다 **지금 화면의 보드 스냅샷**을 요청에 실어 준다. 도구가 볼 수 있는 보드는 그것뿐이다.
 * - 도구가 낸 지시(`applied: true`)를 받아 컨테이너의 손잡이를 부른다. 카드를 실제로 옮기는
 *   곳은 낙관적 갱신과 되돌리기를 쥔 컨테이너 한 자리뿐이다.
 * - 오간 말을 그린다.
 *
 * 여는 상태와 `Ctrl+K` · `Esc` 는 `task-board.tsx` 가 쥐고, 대화는 이 안에서 끝난다.
 */

/** 컨테이너가 넘겨주는 읽기 창구와 고치는 손잡이. */
export type BoardBridge = {
  /** 요청에 실어 보낼 화면 스냅샷. 도구는 이 값만 보고 카드를 고른다. */
  context: BoardContext;
  onMove: (itemId: string, to: BoardColumnId) => void;
  onApprove: (itemId: string) => void;
  onReject: (itemId: string, reason: string) => void;
  onFocusCard: (itemId: string) => void;
  onSelectDate: (date: string | null) => void;
};

/** 경로가 고정이라 그릴 때마다 새로 만들 이유가 없다. 보드 스냅샷은 보낼 때마다 따로 싣는다. */
const transport = new DefaultChatTransport({ api: "/api/board/assistant" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 도구 출력이 화면에 내리는 지시인지 본다. 실패 판정(`applied: false`)은 여기서 걸러진다. */
function asBoardAction(output: unknown): Extract<BoardActionOutput, { applied: true }> | null {
  if (!isRecord(output) || output.applied !== true || typeof output.action !== "string") return null;
  return output as unknown as Extract<BoardActionOutput, { applied: true }>;
}

export function AssistantPanel({
  open,
  onClose,
  board,
}: {
  open: boolean;
  onClose: () => void;
  board: BoardBridge;
}): JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const [input, setInput] = useState("");

  /**
   * 도구가 낸 지시를 뒤늦게 실행할 때 쓰는 창구. 지시는 효과 안에서 처리하는데, 그 사이
   * 카드가 움직여 손잡이가 새로 만들어졌을 수 있어 **그때의 최신 손잡이**를 잡아야 한다.
   */
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  });

  const { messages, sendMessage, status, error } = useChat({ transport });
  const isBusy = status === "submitted" || status === "streaming";

  /**
   * 열리면 입력줄로, 닫히면 축소 버튼으로 초점을 옮긴다. **다음 프레임에 옮기는 이유**는
   * 이 시점에 `visibility: hidden` 이 아직 계산값으로 남아 있어 `focus()` 가 거부되기
   * 때문이다. 첫 그림에서는 `wasOpen` 이 거짓이라 아무 데도 손대지 않는다.
   */
  useEffect(() => {
    const previouslyOpen = wasOpen.current;
    wasOpen.current = open;
    if (!open && !previouslyOpen) return;

    const frame = requestAnimationFrame(() => {
      if (open) {
        panelRef.current?.querySelector("textarea")?.focus();
        return;
      }
      document.querySelector<HTMLButtonElement>(".board-assistant-fab")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /**
   * 도구가 낸 지시를 화면에 옮긴다. 한 번 실행한 호출은 `toolCallId` 로 기억해 두는데,
   * 답이 흐르는 동안 이 효과가 여러 번 도는 데다 지시는 두 번 실행하면 안 되기 때문이다.
   */
  const appliedCallIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!part.type.startsWith("tool-")) continue;
        const tool = part as unknown as { toolCallId?: string; state?: string; output?: unknown };
        if (tool.state !== "output-available" || tool.toolCallId === undefined) continue;
        if (appliedCallIds.current.has(tool.toolCallId)) continue;

        const action = asBoardAction(tool.output);
        if (action === null) continue;
        appliedCallIds.current.add(tool.toolCallId);

        const bridge = boardRef.current;
        if (action.action === "move") {
          bridge.onMove(action.itemId, action.to);
          bridge.onFocusCard(action.itemId);
          continue;
        }
        if (action.action === "approve") {
          bridge.onApprove(action.itemId);
          continue;
        }
        if (action.action === "reject") {
          bridge.onReject(action.itemId, action.reason);
          continue;
        }
        bridge.onSelectDate(action.date);
      }
    }
  }, [messages]);

  /** 글자가 들어올 때마다 값이 바뀌는 표식. 이 값이 바뀌면 대화를 아래로 붙인다. */
  const revision = messages.map((message) => `${message.id}:${message.parts.length}`).join("|")
    + JSON.stringify(messages.at(-1)?.parts.at(-1) ?? null).length;

  useEffect(() => {
    const body = panelRef.current?.querySelector(".board-assistant-body");
    if (body instanceof HTMLElement) body.scrollTop = body.scrollHeight;
  }, [messages.length, revision]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const question = input.trim();
    if (question.length === 0 || isBusy) return;
    setInput("");
    // 지금 화면의 보드를 함께 보낸다. 서버의 보드 도구가 볼 수 있는 보드는 이 스냅샷뿐이다.
    void sendMessage({ text: question }, { body: { board: board.context } });
  }

  const waitingForFirstChunk = isBusy && messages.at(-1)?.role === "user";

  return (
    <aside
      aria-label="AI 도우미"
      className={open ? "board-assistant is-open" : "board-assistant"}
      id="board-assistant"
      ref={panelRef}
    >
      <header className="board-assistant-head">
        <div className="board-assistant-heading">
          <p className="board-assistant-eyebrow">AI 도우미</p>
          <p className="board-assistant-title">보드 조작 · 법령 확인</p>
        </div>
        <button
          aria-label="AI 도우미 닫기"
          className="board-assistant-close"
          onClick={onClose}
          type="button"
        >
          <span aria-hidden="true" />
        </button>
      </header>

      <div className="board-assistant-body">
        {messages.length === 0 ? <AssistantIntro onPick={setInput} /> : null}

        {messages.map((message, index) => {
          if (message.role === "user") {
            return (
              <p className="board-assistant-question" key={message.id}>
                {messageText(message)}
              </p>
            );
          }
          return (
            <AssistantMessageView
              assistantLabel={ASSISTANT_LABEL}
              isStreaming={index === messages.length - 1 && status === "streaming"}
              key={message.id}
              message={message}
            />
          );
        })}

        {waitingForFirstChunk ? (
          <p className="board-assistant-step is-running">
            <span className="board-assistant-shimmer">질문을 살펴보는 중…</span>
          </p>
        ) : null}

        {error === undefined ? null : (
          <p className="chat-error" role="alert">
            {error.message}
          </p>
        )}
      </div>

      <ChatAskBar
        className="board-assistant-ask"
        inputId="board-assistant-question"
        onChange={setInput}
        onSubmit={handleSubmit}
        placeholder="보드를 고치거나 법령을 물어보세요."
        statusMessage={
          error !== undefined
            ? `오류: ${error.message}`
            : status === "streaming"
              ? "답변이 도착하는 중입니다."
              : status === "submitted"
                ? "질문을 보내고 답변을 기다리는 중입니다."
                : ""
        }
        value={input}
      />
    </aside>
  );
}

/** 사용자 메시지에서 글만 뽑는다. */
function messageText(message: UIMessage | undefined): string {
  if (message === undefined) return "";
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** 처음 열었을 때의 안내. 무엇을 시킬 수 있는지 예문으로 보여 준다. */
function AssistantIntro({ onPick }: { onPick: (value: string) => void }): JSX.Element {
  return (
    <div className="board-assistant-intro">
      <p className="board-assistant-intro-copy">
        이 화면의 보드를 직접 읽고 고칩니다. 카드는 제목이나 조건 코드로 가리키면 됩니다.
      </p>

      <div className="board-assistant-prompts">
        {PROMPT_CARDS.map((card) => (
          <button
            aria-disabled={!isActivePrompt(card.label)}
            className={`board-assistant-prompt${isActivePrompt(card.label) ? " is-enabled" : ""}`}
            disabled={!isActivePrompt(card.label)}
            key={card.label}
            onClick={() => onPick(card.prompt)}
            type="button"
          >
            <Image alt="" height={20} src={card.icon} width={20} />
            <span>
              <strong>{card.label}</strong>
              <em>{card.prompt.replace("\n", " ")}</em>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 닫힌 상태의 축소 버튼. 오른쪽 아래에 서고 단축키를 같이 적는다. */
export function AssistantFab({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      aria-controls="board-assistant"
      aria-expanded={open}
      className={open ? "board-assistant-fab is-hidden" : "board-assistant-fab"}
      onClick={onOpen}
      tabIndex={open ? -1 : 0}
      type="button"
    >
      <Image alt="" height={20} src="/assets/messages-square.svg" width={20} />
      <span>AI 도우미</span>
      <kbd>Ctrl K</kbd>
    </button>
  );
}
