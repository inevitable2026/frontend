"use client";

import Image from "next/image";
import type { FormEvent, JSX, RefObject } from "react";

/**
 * 질문 입력줄. 챗봇 탭과 보드 AI 사이드바가 같은 마크업을 쓴다.
 *
 * 값을 직접 받는 이유는 두 화면의 상태 주인이 다르기 때문이다. 챗봇 탭은 `useLawChat`
 * 이, 사이드바는 AI SDK 의 `useChat` 이 대화를 쥔다. `inputId` 를 밖에서 받는 것도
 * 같은 이유인데, 두 화면이 같은 DOM id 를 쓰면 라벨이 엉킨다.
 */
export function ChatAskBar({
  value,
  onChange,
  onSubmit,
  disabled = false,
  statusMessage = "",
  inputId,
  className,
  placeholder = "무엇이든 물어보세요. ",
  rows = 2,
  formRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
  /** 화면에 보이지 않고 보조 기술만 읽는 진행 상황. */
  statusMessage?: string;
  inputId: string;
  className?: string;
  placeholder?: string;
  rows?: number;
  /** 화면 아래에 고정된 이 줄의 윗선까지만 "보인다"고 셈한다. */
  formRef?: RefObject<HTMLFormElement | null>;
}): JSX.Element {
  return (
    <form
      className={className ? `ask-bar ${className}` : "ask-bar"}
      onSubmit={onSubmit}
      ref={formRef}
    >
      <label className="sr-only" htmlFor={inputId}>
        질문
      </label>
      <textarea
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
      />
      <button className="submit-question" type="submit" aria-label="질문 보내기" disabled={disabled || !value.trim()}>
        <Image src="/assets/arrow-up.svg" alt="" width={24} height={24} />
      </button>
      <p className="sr-only" aria-live="polite">
        {statusMessage}
      </p>
    </form>
  );
}
