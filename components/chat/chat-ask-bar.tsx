"use client";

import Image from "next/image";
import type { FormEvent, JSX } from "react";

import type { LawChat } from "./use-law-chat";

/**
 * 질문 입력줄. `inputId` 를 밖에서 받는 이유는 라벨과 짝지을 DOM id 가 화면마다
 * 달라야 하기 때문이다 — 챗봇 탭과 AI 사이드바가 같은 id 를 쓰면 라벨이 엉킨다.
 */
export function ChatAskBar({
  chat,
  inputId,
  className,
  placeholder = "무엇이든 물어보세요. ",
  rows = 2,
  onSubmit,
}: {
  chat: LawChat;
  inputId: string;
  className?: string;
  placeholder?: string;
  rows?: number;
  /** 보내기 전에 가로챌 곳. 보드 사이드바는 여기서 화면 명령인지 먼저 가른다. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}): JSX.Element {
  const { question, setQuestion, lastQuestion, answer, error, isSubmitting, submit } = chat;

  const statusMessage = error
    ? `오류: ${error}`
    : isSubmitting
      ? "질문을 보내고 답변을 기다리는 중입니다."
      : answer
        ? "답변이 완료되었습니다."
        : lastQuestion
          ? `질문을 보냈습니다: ${lastQuestion}`
          : "";

  return (
    <form className={className ? `ask-bar ${className}` : "ask-bar"} onSubmit={onSubmit ?? submit}>
      <label className="sr-only" htmlFor={inputId}>
        질문
      </label>
      <textarea
        id={inputId}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={isSubmitting}
        placeholder={placeholder}
        rows={rows}
      />
      <button className="submit-question" type="submit" aria-label="질문 보내기" disabled={isSubmitting || !question.trim()}>
        <Image src="/assets/arrow-up.svg" alt="" width={24} height={24} />
      </button>
      <p className="sr-only" aria-live="polite">
        {statusMessage}
      </p>
    </form>
  );
}
