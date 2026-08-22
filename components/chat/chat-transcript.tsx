"use client";

import type { JSX, RefObject } from "react";

import { JsonViewer } from "@/components/json-viewer";
import { MarkdownContent } from "@/components/markdown-content";

import { citationSources } from "./parse";
import { TOOL_LABELS, type ToolCall } from "./types";

/**
 * 출처 줄의 문구. 도구 이름 하나(`search_official_law`)를 박아 두던 자리인데 도구가
 * 7개로 늘면서 법령 아닌 검색이 전부 "인용 가능" 으로 잘못 표시됐다. 인용 규약은
 * 도구 종류가 아니라 **검색이냐 읽기냐**로 갈리므로 접두사로 판정한다.
 */
function sourcesLabel(toolName: string): string {
  return toolName.startsWith("search_") ? "검색 후보 · 아직 인용 불가" : "확인한 원문 · 인용 가능";
}

/**
 * 질문 한 건과 그 답. 챗봇 탭과 보드의 AI 사이드바가 같은 마크업을 쓴다 — 도구 실행
 * 과정을 접었다 펴는 형태와 인용 표시 규칙이 두 곳에서 갈리면 안 된다.
 *
 * 훅이 아니라 값을 받는 이유는 사이드바가 **지난 대화도 함께 쌓아 보여 주기** 때문이다.
 * 진행 중인 한 건은 훅의 현재 값을, 끝난 건은 그때 받아 둔 값을 그대로 넘긴다.
 */
export function ChatTranscript({
  question,
  toolCalls,
  answer,
  error,
  isSubmitting,
  assistantLabel,
  anchorRef,
}: {
  question: string;
  toolCalls: ToolCall[];
  answer: string;
  error: string;
  isSubmitting: boolean;
  assistantLabel: string;
  /** 대화의 맨 끝 표식. 이것이 보이는지로 화면이 최신을 따라갈지 정한다. */
  anchorRef?: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  return (
    <section className="chat-area" aria-label="대화 결과">
      <article className="chat-message chat-message-user">
        <p className="chat-message-label">내 질문</p>
        <p>{question}</p>
      </article>

      {toolCalls.length > 0 ? <section className="tool-timeline" aria-label="도구 실행 과정">
        <p className="timeline-label">확인 과정</p>
        {toolCalls.map((tool) => {
          const header = <>
            <strong>
              <span>{TOOL_LABELS[tool.name] ?? "도구 실행"}</span>
              <code>{tool.name}</code>
            </strong>
            <span className="tool-card-meta">
              <span className={`tool-status is-${tool.status}`}>{tool.status === "completed" ? "완료" : tool.status === "error" ? "오류" : "실행 중"}</span>
              <span className="tool-chevron" aria-hidden="true" />
            </span>
          </>;
          const body = <>
            {tool.input !== undefined ? <div className="tool-card-section"><span>입력</span><JsonViewer label={`${TOOL_LABELS[tool.name] ?? tool.name} 입력 JSON`} value={tool.input} /></div> : null}
            {tool.output !== undefined ? <div className="tool-card-section"><span>출력</span><JsonViewer label={`${TOOL_LABELS[tool.name] ?? tool.name} 출력 JSON`} value={tool.output} /></div> : null}
            {tool.sources.length > 0 ? <div className="tool-card-section tool-sources"><span>{sourcesLabel(tool.name)}</span>{tool.sources.map((source) => <a href={source.url} key={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}</div> : null}
          </>;

          return (
            <details className="tool-card tool-card-accordion" key={tool.id}>
              <summary className="tool-card-header">{header}</summary>
              <div className="tool-card-body">{body}</div>
            </details>
          );
        })}
      </section> : null}

      <article className="chat-message chat-message-assistant" aria-busy={isSubmitting}>
        <p className="chat-message-label">{assistantLabel}</p>
        {answer ? <MarkdownContent content={answer} sources={citationSources(toolCalls)} /> : isSubmitting ? <p className="assistant-pending">답변을 준비하고 있습니다…</p> : null}
        {error ? <p className="chat-error" role="alert">{error}</p> : null}
      </article>
      {anchorRef === undefined ? null : (
        <div className="chat-latest-anchor" ref={anchorRef} aria-hidden="true" />
      )}
    </section>
  );
}
