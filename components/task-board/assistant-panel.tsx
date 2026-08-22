"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";

import { ChatAskBar } from "@/components/chat/chat-ask-bar";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { ACTIVE_PROMPT_LABEL, ASSISTANT_LABEL, PROMPT_CARDS } from "@/components/chat/prompts";
import type { ToolCall } from "@/components/chat/types";
import { useLawChat } from "@/components/chat/use-law-chat";

import {
  COLUMN_LABELS,
  interpretBoardCommand,
  type BoardCommand,
  type BoardView,
  type CardRef,
} from "./assistant-commands";
import type { BoardColumnId } from "./types";

/**
 * 보드 오른쪽에 서는 AI 사이드바. 기획안(`docs/plan-task-board.md` 1.1)대로 **보드를
 * 덮는다** — 왼쪽 폭이 줄지 않으므로 칸반 열 너비도 그대로다. 기준점은 `.board-shell`
 * 이 아니라 뷰포트인데, 보드가 화면보다 길어서 절대 위치로 두면 스크롤과 함께 밀려난다.
 *
 * 들어온 문장은 **두 갈래**로 나뉜다.
 * - 보드에 관한 말이면 `assistant-commands.ts` 가 규칙으로 읽고 카드를 고친다.
 * - 그 밖의 말은 `/api/chat` 의 법령 에이전트로 넘어간다.
 *
 * 여는 상태와 `Ctrl+K` · `Esc` 는 `task-board.tsx` 가 쥐고, 대화는 이 안에서 끝난다.
 */

/** 컨테이너가 넘겨주는 읽기 창구와 고치는 손잡이. */
export type BoardBridge = {
  view: Omit<BoardView, "lastListed">;
  onMove: (itemId: string, to: BoardColumnId) => void;
  onApprove: (itemId: string) => void;
  onReject: (itemId: string, reason: string) => void;
  onFocusCard: (itemId: string) => void;
  onSelectDate: (date: string | null) => void;
};

type Entry =
  | {
      id: number;
      kind: "board";
      question: string;
      lines: string[];
      cards: CardRef[];
      /** `done` 은 보드를 실제로 고친 답, `ask` 는 되물음, `read` 는 읽기만 한 답이다. */
      tone: "read" | "done" | "ask";
    }
  | {
      id: number;
      kind: "law";
      question: string;
      /** 진행 중인 한 건. 참이면 훅의 현재 값을 그리고, 거짓이면 얼려 둔 값을 그린다. */
      live: boolean;
      answer: string;
      error: string;
      toolCalls: ToolCall[];
    };

export function AssistantPanel({
  open,
  onClose,
  board,
}: {
  open: boolean;
  onClose: () => void;
  board: BoardBridge;
}): JSX.Element {
  const chat = useLawChat();
  const panelRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const nextId = useRef(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  /** 직전 답에서 번호를 매겨 보여 준 카드. "2번 승인해줘" 를 풀 때 쓴다. */
  const [lastListed, setLastListed] = useState<CardRef[]>([]);

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

  /** 대화가 길어지면 새 답이 화면 밖에 생긴다. 항목이 늘 때마다 아래로 붙인다. */
  useEffect(() => {
    const body = panelRef.current?.querySelector(".board-assistant-body");
    if (body instanceof HTMLElement) body.scrollTop = body.scrollHeight;
  }, [entries.length, chat.answer]);

  function pushBoard(question: string, lines: string[], cards: CardRef[], tone: "read" | "done" | "ask"): void {
    setEntries((current) => [...current, { id: nextId.current++, kind: "board", question, lines, cards, tone }]);
    if (cards.length > 0) setLastListed(cards);
  }

  /** 법령 질문 한 건을 새로 연다. 앞서 진행하던 건은 지금 값 그대로 얼린다. */
  function pushLaw(question: string): void {
    setEntries((current) => [
      ...current.map((entry) =>
        entry.kind === "law" && entry.live
          ? { ...entry, live: false, answer: chat.answer, error: chat.error, toolCalls: chat.toolCalls }
          : entry,
      ),
      { id: nextId.current++, kind: "law", question, live: true, answer: "", error: "", toolCalls: [] },
    ]);
  }

  function runCommand(question: string, command: BoardCommand): void {
    if (command.kind === "read") {
      pushBoard(question, command.lines, command.cards, "read");
      return;
    }
    if (command.kind === "ask") {
      pushBoard(question, command.lines, command.cards, "ask");
      return;
    }
    if (command.kind === "selectDate") {
      board.onSelectDate(command.date);
      pushBoard(
        question,
        command.date === null
          ? ["날짜 필터를 풀었습니다. 이번 주 카드를 모두 보여 줍니다."]
          : [`${command.label} 만 보도록 보드를 맞췄습니다.`],
        [],
        "done",
      );
      return;
    }
    if (command.kind === "approve") {
      board.onApprove(command.card.itemId);
      pushBoard(question, [`「${command.card.title}」 초안을 승인하고 완료 열로 옮겼습니다.`], [command.card], "done");
      return;
    }
    if (command.kind === "reject") {
      board.onReject(command.card.itemId, command.reason);
      pushBoard(
        question,
        [`「${command.card.title}」 초안을 기각했습니다.`, `사유: ${command.reason}`],
        [command.card],
        "done",
      );
      return;
    }
    board.onMove(command.card.itemId, command.to);
    pushBoard(question, [`「${command.card.title}」 을 ${COLUMN_LABELS[command.to]} 열로 옮겼습니다.`], [command.card], "done");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const question = chat.question.trim();
    if (question.length === 0 || chat.isSubmitting) return;

    const command = interpretBoardCommand(question, { ...board.view, lastListed });
    if (command === null) {
      pushLaw(question);
      void chat.submit(event);
      return;
    }

    chat.setQuestion("");
    runCommand(question, command);
  }

  function focusCard(itemId: string): void {
    board.onFocusCard(itemId);
    document.querySelector(`[data-item-id="${itemId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

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
        {entries.length === 0 ? <AssistantIntro onPick={chat.setQuestion} /> : null}

        {entries.map((entry) =>
          entry.kind === "board" ? (
            <section className="board-assistant-turn" key={entry.id}>
              <article className="chat-message chat-message-user">
                <p className="chat-message-label">내 질문</p>
                <p>{entry.question}</p>
              </article>
              <article className={`chat-message chat-message-assistant board-assistant-reply is-${entry.tone}`}>
                <p className="chat-message-label">
                  {entry.tone === "done" ? "보드를 고쳤습니다" : entry.tone === "ask" ? "확인이 필요합니다" : "보드를 읽었습니다"}
                </p>
                {entry.lines.map((line, index) => (
                  <p key={`${entry.id}-${index}`}>{line}</p>
                ))}
                {entry.cards.length > 0 ? (
                  <div className="board-assistant-cardlinks">
                    {entry.cards.map((card) => (
                      <button key={card.itemId} onClick={() => focusCard(card.itemId)} type="button">
                        {COLUMN_LABELS[card.status]} · {card.title}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            </section>
          ) : (
            <ChatTranscript
              answer={entry.live ? chat.answer : entry.answer}
              assistantLabel={ASSISTANT_LABEL}
              error={entry.live ? chat.error : entry.error}
              isSubmitting={entry.live ? chat.isSubmitting : false}
              key={entry.id}
              question={entry.question}
              toolCalls={entry.live ? chat.toolCalls : entry.toolCalls}
            />
          ),
        )}
      </div>

      <ChatAskBar
        className="board-assistant-ask"
        disabled={chat.isSubmitting}
        inputId="board-assistant-question"
        onChange={chat.setQuestion}
        onSubmit={handleSubmit}
        placeholder="보드를 고치거나 법령을 물어보세요."
        value={chat.question}
      />
    </aside>
  );
}

/** 처음 열었을 때의 안내. 무엇을 시킬 수 있는지 예문으로 보여 준다. */
function AssistantIntro({ onPick }: { onPick: (value: string) => void }): JSX.Element {
  const boardSamples = [
    "지금 보드 요약해줘",
    "승인 대기 카드 보여줘",
    "2번 승인해줘",
    "T-03 카드 완료로 옮겨줘",
    "1번 기각해줘 사유: 자재 사양 재확인 필요",
  ];

  return (
    <div className="board-assistant-intro">
      <p className="board-assistant-intro-copy">
        이 화면의 카드를 직접 읽고 고칩니다. 카드는 번호나 조건 코드, 제목의 일부로 가리킵니다.
      </p>

      <div className="board-assistant-samples">
        {boardSamples.map((sample) => (
          <button key={sample} onClick={() => onPick(sample)} type="button">
            {sample}
          </button>
        ))}
      </div>

      <p className="board-assistant-scope">
        보드 조작은 화면 안에서 규칙으로 처리합니다. 그 밖의 질문은 공식 법령 원문을 찾아 읽는
        에이전트가 받고, 읽지 못한 내용은 단정하지 않습니다.
      </p>

      <div className="board-assistant-prompts">
        {PROMPT_CARDS.map((card) => (
          <button
            aria-disabled={card.label !== ACTIVE_PROMPT_LABEL}
            className={`board-assistant-prompt${card.label === ACTIVE_PROMPT_LABEL ? " is-enabled" : ""}`}
            disabled={card.label !== ACTIVE_PROMPT_LABEL}
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
