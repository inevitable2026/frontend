"use client";

import Image from "next/image";
import {
  FormEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { JsonViewer } from "@/components/json-viewer";
import { MarkdownContent, type CitationSource } from "@/components/markdown-content";
import { SiteContextPanel } from "@/components/site-context-panel";
import { TaskBoard } from "@/components/task-board/task-board";

/**
 * 사이드바 차례. **첫 항목이 태스크 보드**이므로 아래 인덱스가 곧 화면이다.
 * 0 태스크 보드 · 1 우리 회사 챗봇 · 2 현장 맥락 관리 · 3 TBM 기록 · 4 위험성평가 기록.
 * 순서를 바꾸면 `NAV_BOARD` · `NAV_SITE_CONTEXT` 두 상수도 같이 옮겨야 한다.
 */
const navigation: readonly { label: string; icon: string; badge?: number }[] = [
  { label: "태스크 보드", icon: "/assets/file-check.svg", badge: 11 },
  { label: "우리 회사 챗봇", icon: "/assets/messages-square.svg" },
  { label: "현장 맥락 관리", icon: "/assets/database.svg" },
  { label: "TBM 기록 목록", icon: "/assets/file-user.svg" },
  { label: "위험성평가 기록 목록", icon: "/assets/file-exclamation.svg" },
];

const NAV_BOARD = 0;
const NAV_SITE_CONTEXT = 2;

const promptCards = [
  {
    label: "오늘의 안전 현황",
    prompt: "이번 주 TBM 미실시 팀이랑\n정기교육 시간 미달자 알려줘",
    icon: "/assets/file-check.svg",
  },
  {
    label: "감사 대응",
    prompt: "6월 위험성평가랑 조치 이력,\n감사 제출용으로 묶어줘",
    icon: "/assets/shredder.svg",
  },
  {
    label: "작업 전 법령 체크",
    prompt: "내일 굴착작업 시작하는데\n법적으로 빠진 서류 있는지 확인해줘",
    icon: "/assets/scale.svg",
  },
] as const;

const appAssets = [
  { src: "/assets/document-app.svg", className: "asset-square" },
  { src: "/assets/image-70.png", className: "asset-square" },
  { src: "/assets/image-71.png", className: "asset-narrow" },
  { src: "/assets/image-69.png", className: "asset-wide" },
  { src: "/assets/image-72.png", className: "asset-narrow" },
] as const;

const ACTIVE_PROMPT_LABEL = "작업 전 법령 체크";

const TOOL_LABELS: Record<string, string> = {
  search_official_law: "공식 법령 후보 검색",
  read_official_law: "공식 조문 원문 조회",
};

type JsonRecord = Record<string, unknown>;

type SourceLink = {
  label: string;
  url: string;
};

type ToolCall = {
  id: string;
  name: string;
  status: "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
  sources: SourceLink[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined || value === null) return undefined;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function toSourceLinks(value: unknown): SourceLink[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((source, index) => {
    if (typeof source === "string") {
      return /^https?:\/\//.test(source)
        ? [{ label: `출처 ${index + 1}`, url: source }]
        : [];
    }
    if (!isRecord(source)) return [];

    const url = asText(source.url ?? source.href ?? source.link);
    if (!url || !/^https?:\/\//.test(url)) return [];

    return [{ label: asText(source.title ?? source.name ?? source.label) ?? `출처 ${index + 1}`, url }];
  });
}

function normalizeStatus(value: unknown): ToolCall["status"] {
  const status = asText(value)?.toLowerCase();
  if (["error", "failed", "failure"].includes(status ?? "")) return "error";
  if (["completed", "complete", "done", "success", "finished"].includes(status ?? "")) {
    return "completed";
  }
  return "running";
}

function structuredRecord(value: unknown): JsonRecord | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function citationSources(toolCalls: ToolCall[]): CitationSource[] {
  const sources = toolCalls.flatMap((tool) => {
    if (tool.name !== "read_official_law" || tool.status !== "completed") return [];

    const output = structuredRecord(tool.output);
    const result = output && isRecord(output.result) ? output.result : output;
    const officialSource = result && isRecord(result.source) ? result.source : undefined;
    const url = asText(result?.canonicalUrl ?? officialSource?.url ?? tool.sources[0]?.url);
    const title = asText(result?.title ?? officialSource?.title ?? tool.sources[0]?.label);
    if (!url || !title || !/^https?:\/\//.test(url)) return [];

    return [{
      title,
      url,
      authority: asText(result?.authority ?? officialSource?.authority),
      version: asText(result?.version ?? officialSource?.version),
      excerpt: asText(result?.excerpt),
    }];
  });

  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

function parseEvent(payload: unknown, index: number): { tool?: ToolCall; answer?: string; error?: string } {
  if (!isRecord(payload)) return {};
  const event = isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
  const type = asText(event.type ?? event.event ?? event.kind)?.toLowerCase() ?? "";
  const toolPayload = isRecord(event.tool) ? { ...event, ...event.tool } : event;
  const isTool = type.includes("tool") || toolPayload.tool_name !== undefined || toolPayload.toolName !== undefined;

  if (isTool) {
    const name = asText(toolPayload.name ?? toolPayload.tool_name ?? toolPayload.toolName) ?? "도구 실행";
    return {
      tool: {
        id: asText(toolPayload.id ?? toolPayload.call_id ?? toolPayload.tool_call_id) ?? `${name}-${index}`,
        name,
        status: normalizeStatus(toolPayload.status),
        input: toolPayload.input ?? toolPayload.arguments ?? toolPayload.args,
        output: toolPayload.output ?? toolPayload.result ?? toolPayload.content,
        sources: toSourceLinks(toolPayload.sources ?? toolPayload.source_links ?? toolPayload.links),
      },
    };
  }

  if (type.includes("error") || event.error !== undefined) {
    return { error: asText(event.error ?? event.message) ?? "응답을 가져오지 못했습니다." };
  }

  const answer = asText(event.answer ?? event.message ?? event.text ?? event.content ?? event.delta);
  return answer ? { answer } : {};
}

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

function AssetCarousel({ blurred = false }: { blurred?: boolean }) {
  return (
    <div
      className={`asset-track${blurred ? " asset-track-blur" : ""}`}
      aria-hidden="true"
    >
      {[0, 1].map((groupIndex) => (
        <div className="asset-group" key={groupIndex}>
          {appAssets.map((asset) => (
            <Image
              key={`${groupIndex}-${asset.src}`}
              className={asset.className}
              src={asset.src}
              alt=""
              width={66}
              height={64}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ConstructionConsole() {
  const [activeNav, setActiveNav] = useState(NAV_BOARD);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [answer, setAnswer] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [isAwayFromLatest, setIsAwayFromLatest] = useState(false);
  const [hasUnseenContent, setHasUnseenContent] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const latestContent = useRef<HTMLDivElement>(null);
  const askBar = useRef<HTMLFormElement>(null);
  const followsLatest = useRef(false);
  const isScrollingToLatest = useRef(false);
  const scrollResetTimer = useRef<number | undefined>(undefined);
  const hasResponseContent = toolCalls.length > 0 || Boolean(answer) || Boolean(error);

  const latestContentIsVisible = useCallback(() => {
    const latest = latestContent.current;
    if (!latest) return true;

    const composerTop = askBar.current?.getBoundingClientRect().top ?? window.innerHeight;
    const visibleBottom = Math.min(composerTop, window.innerHeight);
    return latest.getBoundingClientRect().top <= visibleBottom - 12;
  }, []);

  const scrollToLatest = useCallback(() => {
    followsLatest.current = true;
    isScrollingToLatest.current = true;
    setIsAwayFromLatest(false);
    setHasUnseenContent(false);

    if (scrollResetTimer.current !== undefined) {
      window.clearTimeout(scrollResetTimer.current);
    }

    window.requestAnimationFrame(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "smooth",
      });
    });

    scrollResetTimer.current = window.setTimeout(() => {
      isScrollingToLatest.current = false;
    }, 800);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;

    const previousOverflow = document.body.style.overflow;
    const desktopQuery = window.matchMedia("(min-width: 1024px)");

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }

    function closeAtDesktopWidth(event: MediaQueryListEvent) {
      if (event.matches) setSidebarOpen(false);
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    desktopQuery.addEventListener("change", closeAtDesktopWidth);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      desktopQuery.removeEventListener("change", closeAtDesktopWidth);
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (!lastQuestion || activeNav !== 0) return;

    let frame: number | undefined;

    function updateLatestPosition() {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const isVisible = latestContentIsVisible();
        if (isScrollingToLatest.current) {
          if (isVisible) {
            isScrollingToLatest.current = false;
            followsLatest.current = true;
            setIsAwayFromLatest(false);
            setHasUnseenContent(false);
          }
          return;
        }

        followsLatest.current = isVisible;
        setIsAwayFromLatest(!isVisible);
        if (isVisible) setHasUnseenContent(false);
      });
    }

    window.addEventListener("scroll", updateLatestPosition, { passive: true });
    window.addEventListener("resize", updateLatestPosition);

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updateLatestPosition);
      window.removeEventListener("resize", updateLatestPosition);
    };
  }, [activeNav, lastQuestion, latestContentIsVisible]);

  useEffect(() => {
    if (!hasResponseContent || activeNav !== 0) return;

    const frame = window.requestAnimationFrame(() => {
      if (followsLatest.current) {
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "auto",
        });
        setIsAwayFromLatest(false);
        setHasUnseenContent(false);
        return;
      }

      const isVisible = latestContentIsVisible();
      followsLatest.current = isVisible;
      setIsAwayFromLatest(!isVisible);
      if (isVisible) {
        setHasUnseenContent(false);
      } else {
        setHasUnseenContent(true);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeNav, answer, error, hasResponseContent, latestContentIsVisible, toolCalls]);

  useEffect(() => () => {
    if (scrollResetTimer.current !== undefined) {
      window.clearTimeout(scrollResetTimer.current);
    }
  }, []);

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion || isSubmitting) return;

    setLastQuestion(trimmedQuestion);
    setQuestion("");
    setToolCalls([]);
    setAnswer("");
    setError("");
    setIsSubmitting(true);
    setIsAwayFromLatest(false);
    setHasUnseenContent(false);
    followsLatest.current = true;
    isScrollingToLatest.current = false;

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

  return (
    <main className="construction-console">
      <Image
        aria-hidden="true"
        className="hero-ellipse"
        src="/assets/hero-ellipse.svg"
        alt=""
        width={1200}
        height={1200}
        priority
      />

      <header className="mobile-header">
        <div className="mobile-brand">
          <Image
            src="/assets/upstage-logo.svg"
            alt="Upstage"
            width={113.273}
            height={28}
            priority
          />
          <span>for Construction</span>
        </div>
        <button
          className="menu-toggle"
          type="button"
          aria-label="메뉴 열기"
          aria-controls="primary-sidebar"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(true)}
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      <button
        className={`sidebar-backdrop${sidebarOpen ? " is-visible" : ""}`}
        type="button"
        aria-label="메뉴 닫기"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        id="primary-sidebar"
        className={`sidebar${sidebarOpen ? " is-open" : ""}`}
        aria-label="주요 메뉴"
      >
        <button
          className="sidebar-close"
          type="button"
          aria-label="메뉴 닫기"
          onClick={() => setSidebarOpen(false)}
        >
          <span aria-hidden="true" />
        </button>

        <div className="brand-card">
          <Image
            src="/assets/upstage-logo.svg"
            alt="Upstage"
            width={113.273}
            height={28}
            priority
          />
          <span>for Construction</span>
        </div>

        <nav className="nav-panel">
          {navigation.map((item, index) => (
            <button
              className={`nav-item${activeNav === index ? " is-active" : ""}`}
              key={item.label}
              type="button"
              aria-current={activeNav === index ? "page" : undefined}
              onClick={() => {
                setActiveNav(index);
                setSidebarOpen(false);
                followsLatest.current = true;
                setIsAwayFromLatest(false);
                setHasUnseenContent(false);
              }}
            >
              <span
                className="nav-item-icon"
                aria-hidden="true"
                style={{ "--nav-icon": `url(${item.icon})` } as CSSProperties}
              />
              <span className="nav-item-label">{item.label}</span>
              {item.badge === undefined ? null : (
                <span className="nav-badge">{item.badge}</span>
              )}
            </button>
          ))}
        </nav>

        <button className="app-switch" type="button">
          <span>안전관리자 및 작업반장 앱</span>
          <Image
            src="/assets/arrow-right-sidebar.svg"
            alt=""
            width={13.755}
            height={13.755}
          />
        </button>

        <div className="sidebar-bottom">
          <section className="upload-promo" aria-labelledby="upload-title">
            <div className="asset-stage" aria-hidden="true">
              <div className="asset-stage-inner">
                <AssetCarousel blurred />
                <AssetCarousel />
              </div>
            </div>
            <div className="promo-copy">
              <div className="promo-fade" aria-hidden="true" />
              <h2 id="upload-title">맥락/레퍼런스 추가하기</h2>
              <p>
                Ingest your documents and playbooks,
                <br />
                and we will convert them into executable flows
              </p>
            </div>
            <input
              ref={uploadInput}
              className="sr-only"
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
              multiple
            />
            <button
              className="upload-button"
              type="button"
              onClick={() => uploadInput.current?.click()}
            >
              문서 업로드 하기
            </button>
          </section>
        </div>
      </aside>

      <section className={`workspace${activeNav === NAV_BOARD ? " is-board" : ""}`}>
        {activeNav === NAV_BOARD ? (
          <TaskBoard />
        ) : activeNav === NAV_SITE_CONTEXT ? (
          <SiteContextPanel />
        ) : (
        <div className={`content-stack${lastQuestion ? " is-chatting" : ""}`}>
          {!lastQuestion ? <>
          <header className="hero-copy">
            <div className="hero-title-group">
              <p className="eyebrow">관리자용 콘솔</p>
              <h1>
                우리회사 현장 맥락을
                <br />
                바탕으로 하는 스마트 에이전트
              </h1>
            </div>
            <p className="hero-description">
              업로드된 서류, 법령, 공공데이터, 현장 기록을 바탕으로 답해요.
            </p>
          </header>

          <Image
            className="crane-illustration"
            src="/assets/crane-building.svg"
            alt="건물과 타워크레인 일러스트"
            width={254}
            height={195.102}
            priority
          />

          <div className="prompt-grid">
            {promptCards.map((card) => (
              <button
                className={`prompt-card${card.label === ACTIVE_PROMPT_LABEL ? " is-enabled" : " is-disabled"}`}
                key={card.label}
                type="button"
                disabled={card.label !== ACTIVE_PROMPT_LABEL}
                aria-disabled={card.label !== ACTIVE_PROMPT_LABEL}
                onClick={() => setQuestion(card.prompt)}
              >
                <Image src={card.icon} alt="" width={28} height={28} />
                <span className="card-copy">
                  <span className="card-label">{card.label}</span>
                  <span className="card-prompt">
                    {card.prompt.split("\n").map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </span>
                </span>
              </button>
            ))}
          </div>
          </> : <section className="chat-area" aria-label="대화 결과">
            <article className="chat-message chat-message-user">
              <p className="chat-message-label">내 질문</p>
              <p>{lastQuestion}</p>
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
                  {tool.sources.length > 0 ? <div className="tool-card-section tool-sources"><span>{tool.name === "search_official_law" ? "검색 후보 · 아직 법적 인용 불가" : "확인한 공식 원문 · 인용 가능"}</span>{tool.sources.map((source) => <a href={source.url} key={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}</div> : null}
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
              <p className="chat-message-label">현장 법령 체크 에이전트</p>
              {answer ? <MarkdownContent content={answer} sources={citationSources(toolCalls)} /> : isSubmitting ? <p className="assistant-pending">답변을 준비하고 있습니다…</p> : null}
              {error ? <p className="chat-error" role="alert">{error}</p> : null}
            </article>

            <div className="chat-latest-anchor" ref={latestContent} aria-hidden="true" />
          </section>}

          <div className="composer-dock">
            <div className="new-content-live">
              {isAwayFromLatest ? (
                <button
                  className={`new-content-pill${hasUnseenContent ? " is-new" : ""}`}
                  type="button"
                  onClick={scrollToLatest}
                >
                  <span className="new-content-touch-target" aria-hidden="true" />
                  {hasUnseenContent ? <span className="new-content-dot" aria-hidden="true" /> : null}
                  <span>{hasUnseenContent ? "새 내용이 도착했어요" : "맨 아래로 이동"}</span>
                  <span className="new-content-arrow" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {hasUnseenContent ? "새 내용이 도착했습니다. 새 내용으로 이동 버튼을 이용할 수 있습니다." : ""}
            </span>

            <form className="ask-bar" ref={askBar} onSubmit={submitQuestion}>
              <label className="sr-only" htmlFor="question">
                질문
              </label>
              <textarea
                id="question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                disabled={isSubmitting}
                placeholder="무엇이든 물어보세요. "
                rows={2}
              />
              <button className="submit-question" type="submit" aria-label="질문 보내기" disabled={isSubmitting || !question.trim()}>
                <Image src="/assets/arrow-up.svg" alt="" width={24} height={24} />
              </button>
              <p className="sr-only" aria-live="polite">
                {error ? `오류: ${error}` : isSubmitting ? "질문을 보내고 답변을 기다리는 중입니다." : answer ? "답변이 완료되었습니다." : lastQuestion ? `질문을 보냈습니다: ${lastQuestion}` : ""}
              </p>
            </form>
          </div>
        </div>
        )}
      </section>
    </main>
  );
}
