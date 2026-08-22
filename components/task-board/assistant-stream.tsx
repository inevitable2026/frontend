"use client";

import type { JSX } from "react";
import type { UIMessage } from "ai";

import { JsonViewer } from "@/components/json-viewer";
import { MarkdownContent, type CitationSource } from "@/components/markdown-content";

/**
 * 스트리밍으로 들어오는 답 한 통을 그린다.
 *
 * 도구 호출은 **한 줄짜리 글**로만 보여 준다. 실행 중에는 그 줄이 어른거리고(shimmer),
 * 끝나면 펼쳐서 주고받은 값을 볼 수 있다. JSON 덩어리가 실행 중에 먼저 나오면 읽을 것이
 * 없는데도 화면이 요동친다.
 */

type ToolLabel = { running: string; done: string };

const TOOL_LABELS: Record<string, ToolLabel> = {
  search_official_law: { running: "공식 법령 후보를 찾는 중", done: "공식 법령 후보 검색" },
  read_official_law: { running: "공식 조문 원문을 읽는 중", done: "공식 조문 원문 조회" },
  read_board: { running: "보드를 읽는 중", done: "보드 확인" },
  move_card: { running: "카드를 옮기는 중", done: "카드 이동" },
  approve_card: { running: "초안을 승인하는 중", done: "초안 승인" },
  reject_card: { running: "초안을 기각하는 중", done: "초안 기각" },
  select_date: { running: "날짜 필터를 맞추는 중", done: "날짜 필터" },
};

const FALLBACK_LABEL: ToolLabel = { running: "도구를 실행하는 중", done: "도구 실행" };

type ToolPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

type SourceLink = { label: string; url: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * 도구 파트만 골라 우리 모양으로 본다. AI SDK 의 파트 합집합은 도구 이름을 타입에 담아
 * 두는데, 이 화면은 이름을 문자열로만 쓰므로 좁은 구조 하나로 읽는 편이 간단하다.
 */
function toolParts(message: UIMessage): ToolPart[] {
  return message.parts.flatMap((part) =>
    part.type.startsWith("tool-") ? [part as unknown as ToolPart] : [],
  );
}

function toolName(part: ToolPart): string {
  return part.type.slice("tool-".length);
}

/** 실행 중인 도구가 무엇을 쥐고 있는지 한 조각만 덧붙인다. 입력이 아직 오는 중일 수도 있다. */
function inputHint(part: ToolPart): string {
  if (!isRecord(part.input)) return "";
  const query = asText(part.input.query);
  if (query) return `「${query}」`;
  const ref = asText(part.input.ref);
  return ref ? `「${ref}」` : "";
}

/** 끝난 도구가 무엇을 확인했는지 한 줄로 요약한다. */
function outputHint(part: ToolPart): string {
  if (!isRecord(part.output)) return "";

  // 보드 도구는 무엇을 했는지, 못 했으면 왜 못 했는지를 그 자리에 적는다.
  if (part.output.applied === false) return asText(part.output.reason) ?? "하지 못했습니다";
  if (part.output.applied === true) {
    const title = asText(part.output.title);
    if (part.output.action === "move") {
      return `「${title ?? ""}」 → ${asText(part.output.toLabel) ?? ""}`;
    }
    if (part.output.action === "selectDate") return asText(part.output.label) ?? "";
    return title ?? "";
  }
  if (typeof part.output.matchedCount === "number") return `카드 ${part.output.matchedCount}장`;

  if (Array.isArray(part.output.candidates)) return `후보 ${part.output.candidates.length}건`;
  const title = asText(part.output.title);
  if (!title) return "";
  const provision = asText(part.output.provision);
  return provision ? `${title} ${provision}` : title;
}

function sourceLinks(part: ToolPart): SourceLink[] {
  if (!isRecord(part.output)) return [];

  if (Array.isArray(part.output.candidates)) {
    return part.output.candidates.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const url = asText(candidate.canonicalUrl);
      const label = asText(candidate.title);
      return url && label ? [{ label, url }] : [];
    });
  }

  const source = isRecord(part.output.source) ? part.output.source : undefined;
  const url = asText(part.output.canonicalUrl ?? source?.url);
  const label = asText(part.output.title ?? source?.title);
  return url && label ? [{ label, url }] : [];
}

/**
 * 인용에 쓸 출처. **읽기에 성공한 원문만** 통과시킨다 — 검색 후보는 `citable: false` 라
 * 근거가 되지 못한다 (`docs/company-chatbot-plan.md` 의 인용 규칙).
 */
export function citationSourcesOf(message: UIMessage): CitationSource[] {
  const sources = toolParts(message).flatMap((part) => {
    if (toolName(part) !== "read_official_law") return [];
    if (part.state !== "output-available" || !isRecord(part.output)) return [];

    const source = isRecord(part.output.source) ? part.output.source : undefined;
    const url = asText(part.output.canonicalUrl ?? source?.url);
    const title = asText(part.output.title ?? source?.title);
    if (!url || !title) return [];

    return [{
      title,
      url,
      authority: asText(part.output.authority ?? source?.authority),
      version: asText(part.output.version ?? source?.version),
      excerpt: asText(part.output.excerpt),
    }];
  });

  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

function ToolStepLine({ part }: { part: ToolPart }): JSX.Element {
  const name = toolName(part);
  const label = TOOL_LABELS[name] ?? FALLBACK_LABEL;

  if (part.state === "output-error") {
    return (
      <p className="board-assistant-step is-error">
        {label.done}에 실패했습니다. {part.errorText ?? ""}
      </p>
    );
  }

  if (part.state !== "output-available") {
    return (
      <p className="board-assistant-step is-running">
        <span className="board-assistant-shimmer">
          {label.running}
          {inputHint(part) ? ` ${inputHint(part)}` : ""}…
        </span>
      </p>
    );
  }

  const hint = outputHint(part);
  const sources = sourceLinks(part);

  return (
    <details className="board-assistant-step-details">
      <summary className="board-assistant-step is-done">
        <span>
          {label.done}
          {hint ? ` · ${hint}` : ""}
        </span>
        <span aria-hidden="true" className="board-assistant-step-chevron" />
      </summary>
      <div className="board-assistant-step-body">
        {part.input === undefined ? null : (
          <div className="tool-card-section">
            <span>입력</span>
            <JsonViewer label={`${label.done} 입력 JSON`} value={part.input} />
          </div>
        )}
        <div className="tool-card-section">
          <span>출력</span>
          <JsonViewer label={`${label.done} 출력 JSON`} value={part.output} />
        </div>
        {sources.length === 0 ? null : (
          <div className="tool-card-section tool-sources">
            <span>{name === "search_official_law" ? "검색 후보 · 아직 법적 인용 불가" : "확인한 공식 원문 · 인용 가능"}</span>
            {sources.map((source) => (
              <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                {source.label}
              </a>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export function AssistantMessageView({
  message,
  assistantLabel,
  isStreaming,
}: {
  message: UIMessage;
  assistantLabel: string;
  /** 아직 글자가 오는 중이면 마지막 글 뒤에 깜빡이는 막대를 둔다. */
  isStreaming: boolean;
}): JSX.Element {
  const citations = citationSourcesOf(message);
  const steps = toolParts(message);
  const texts = message.parts.flatMap((part) =>
    part.type === "text" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  );
  const answer = texts.join("").trim();

  return (
    <>
      {steps.length === 0 ? null : (
        <section aria-label="확인 과정" className="board-assistant-steps">
          {steps.map((part, index) => (
            <ToolStepLine key={part.toolCallId ?? `${part.type}-${index}`} part={part} />
          ))}
        </section>
      )}

      {answer.length === 0 && !isStreaming ? null : (
        <article aria-busy={isStreaming} className="chat-message chat-message-assistant">
          <p className="chat-message-label">{assistantLabel}</p>
          {answer.length === 0 ? (
            <p className="assistant-pending">
              <span className="board-assistant-shimmer">답변을 준비하고 있습니다…</span>
            </p>
          ) : (
            <div className={isStreaming ? "board-assistant-typing" : undefined}>
              <MarkdownContent content={answer} sources={citations} />
            </div>
          )}
        </article>
      )}
    </>
  );
}
