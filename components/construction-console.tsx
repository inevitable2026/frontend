"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { ChatAskBar } from "@/components/chat/chat-ask-bar";
import { useLatestPin } from "./chat/use-latest-pin";
import { askBarStatus } from "@/components/chat/status";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { ACTIVE_PROMPT_LABEL, ASSISTANT_LABEL, PROMPT_CARDS } from "@/components/chat/prompts";
import { useLawChat } from "@/components/chat/use-law-chat";
import { RiskAssessmentPanel } from "@/components/risk/risk-assessment-panel";
import { 재평가건수 } from "@/components/risk/risk-queue";
import type { BoardPage } from "@/lib/board/types";
import { SiteContextPanel } from "@/components/site-context-panel";
import { ContextWatch } from "@/components/task-board/context-watch";
import { TaskBoard } from "@/components/task-board/task-board";
import type { BoardSources } from "@/components/task-board/board-data";
import type { BoardWatch } from "@/components/task-board/types";
import {
  type ConsoleNav,
  type ConsoleUrlState,
  patchConsoleUrlState,
  serializeConsoleUrlState,
} from "@/lib/console-url";

/**
 * URL 에 적는 값이 화면의 정체성이다. 배열 순서를 상태로 쓰지 않는다 — 메뉴가 숨겨지거나
 * 끼어들어도 주소와 화면이 엇갈리지 않아야 한다.
 */
const navigation: readonly { value: ConsoleNav; label: string; icon: string; badge?: number }[] = [
  { value: "board", label: "태스크 보드", icon: "/assets/file-check.svg", badge: 11 },
  { value: "chat", label: "우리 회사 챗봇", icon: "/assets/messages-square.svg" },
  { value: "context", label: "현장 맥락 관리", icon: "/assets/database.svg" },
  { value: "risk", label: "위험성평가 기록", icon: "/assets/file-exclamation.svg" },
];

const appAssets = [
  { src: "/assets/document-app.svg", className: "asset-square" },
  { src: "/assets/image-70.png", className: "asset-square" },
  { src: "/assets/image-71.png", className: "asset-narrow" },
  { src: "/assets/image-69.png", className: "asset-wide" },
  { src: "/assets/image-72.png", className: "asset-narrow" },
] as const;

function AssetCarousel({ blurred = false }: { blurred?: boolean }) {
  return (
    <div
      className={`asset-carousel${blurred ? " asset-carousel-blur" : ""}`}
      aria-hidden="true"
    >
      <div className="asset-track">
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
    </div>
  );
}

export function ConstructionConsole({
  initialBoard = null,
  initialUrlState,
}: {
  /**
   * 서버가 첫 그림 전에 읽어 둔 보드 재료. 태스크 보드가 처음 열리는 화면이라 이것을 들고
   * 오면 카드가 첫 HTML 에 이미 서 있다. 서버 쪽 읽기가 실패하면 null 로 오고, 그때는
   * 보드가 예전처럼 마운트 뒤에 직접 읽는다.
   */
  initialBoard?: BoardSources | null;
  initialUrlState: ConsoleUrlState;
}) {
  const router = useRouter();
  const urlState = initialUrlState;
  const incomingUrlRef = useRef(serializeConsoleUrlState(urlState));
  const pendingUrlStateRef = useRef(urlState);
  const incomingUrl = serializeConsoleUrlState(urlState);

  // A navigation may not have re-rendered this component before another control
  // emits a patch. Only replace our pending state when the server-provided URL
  // actually changes (including browser back/forward).
  useEffect(() => {
    if (incomingUrl === incomingUrlRef.current) return;
    incomingUrlRef.current = incomingUrl;
    pendingUrlStateRef.current = urlState;
  }, [incomingUrl, urlState]);
  /**
   * 위험성평가 탭 배지 — 재평가가 필요한 건수.
   * 상수로 박지 않는다. 배지가 실제와 어긋나면 그 자체로 거짓말이다.
   */
  const [riskBadge, setRiskBadge] = useState<number | undefined>(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * "연결된 맥락을 보고 있습니다". 보드가 스냅샷을 읽고 나서 올려 주고, 사이드바가 그린다.
   * 아직 한 번도 읽지 않았으면 null 이고 그 자리는 비워 둔다.
   */
  const [watch, setWatch] = useState<BoardWatch | null>(null);

  const updateUrl = useCallback((patch: Partial<ConsoleUrlState>): void => {
    const next = patchConsoleUrlState(pendingUrlStateRef.current, patch);
    pendingUrlStateRef.current = next;
    router.push(serializeConsoleUrlState(next), { scroll: false });
  }, [router]);

  // 사이드바 배지는 탭을 열기 전에도 맞아야 한다. 그래서 콘솔이 직접 센다.
  useEffect(() => {
    let 살아있음 = true;
    fetch(`/api/board/items?siteId=${encodeURIComponent(urlState.siteId)}`)
      // 실패를 `null` 로 바꾸지 않는다. 그러면 아래 catch 가 영영 안 불려서
      // 400 을 맞아도 "카드가 0장" 과 똑같아 보인다.
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<BoardPage>;
      })
      .then((page) => {
        if (!살아있음 || !page) return;
        const n = 재평가건수(page.items);
        setRiskBadge(n > 0 ? n : undefined);
      })
      .catch((e) => {
        // 배지를 못 세면 안 보인다. 틀린 숫자를 보이는 것보다 낫다.
        //
        // 다만 **조용히 삼키지는 않는다.** 예전에 배지 요청이 400 을 맞고 있었는데
        // 이 자리가 아무 말도 안 해서, 배지가 원래 없는 건지 설정이 어긋난 건지
        // 구분할 방법이 없었다.
        console.error("[console] 위험성평가 배지를 세지 못했습니다:", e);
      });
    return () => {
      살아있음 = false;
    };
  }, [urlState.siteId]);

  const uploadInput = useRef<HTMLInputElement>(null);
  // 챗봇 탭의 대화. URL의 conversationId가 대화의 주소이므로 새로고침과 뒤로/앞으로도 복원된다.
  const chat = useLawChat({
    siteId: urlState.siteId,
    conversationId: urlState.conversationId,
    onConversationCreated: (conversationId) => updateUrl({ nav: "chat", conversationId }),
    onNewConversation: () => updateUrl({ nav: "chat", conversationId: null }),
  });
  const hasChatContent = chat.turns.length > 0 || chat.pendingTurn !== null || chat.error.length > 0;
  // 답이 길어질 때 화면을 따라 내리는 규칙. 사용자가 위로 올라가 있으면 끌어내리지 않는다.
  const pin = useLatestPin({
    enabled: urlState.nav === "chat" && hasChatContent,
    hasResponseContent:
      chat.turns.length > 0 || (chat.pendingTurn?.toolCalls.length ?? 0) > 0 || (chat.pendingTurn?.answer.length ?? 0) > 0 || (chat.pendingTurn?.error.length ?? 0) > 0 || chat.error.length > 0,
    revision: `${chat.turns.length}:${chat.pendingTurn?.toolCalls.length ?? 0}:${chat.pendingTurn?.answer.length ?? 0}:${chat.pendingTurn?.error.length ?? 0}:${chat.error.length}`,
  });
  const {
    anchorRef: chatAnchorRef,
    composerRef: chatComposerRef,
    hasUnseenContent,
    isAwayFromLatest,
    scrollToLatest,
  } = pin;

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
          {navigation.map((item) => (
            <button
              className={`nav-item${urlState.nav === item.value ? " is-active" : ""}`}
              key={item.label}
              type="button"
              aria-current={urlState.nav === item.value ? "page" : undefined}
              onClick={() => {
                updateUrl({ nav: item.value });
                setSidebarOpen(false);
              }}
            >
              <span
                className="nav-item-icon"
                aria-hidden="true"
                style={{ "--nav-icon": `url(${item.icon})` } as CSSProperties}
              />
              <span className="nav-item-label">{item.label}</span>
              {(() => {
                // 위험성평가 배지는 실측값이라 navigation 상수가 아니라 상태에서 온다.
                const badge = item.value === "risk" ? riskBadge : item.badge;
                return badge === undefined ? null : <span className="nav-badge">{badge}</span>;
              })()}
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

        {watch === null ? null : <ContextWatch watch={watch} />}

        <div className="sidebar-bottom">
          <section className="upload-promo" aria-labelledby="upload-title">
            <AssetCarousel blurred />
            <AssetCarousel />
            <div className="promo-copy">
              <div className="promo-fade" aria-hidden="true" />
              <h2 id="upload-title">현장 문서 추가하기</h2>
              <p>
                위험성평가서·공정표·회사 양식 등 현장 문서를 올리면,
                <br />
                우리 현장 기준에 맞춘 AI 초안을 바로 만들 수 있어요.
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

      <section className={`workspace${urlState.nav === "board" ? " is-board" : ""}`}>
        {urlState.nav === "board" ? (
          <TaskBoard
            key={`${urlState.siteId}:${urlState.boardDate}:${urlState.boardFilterDate ?? "all"}:${urlState.boardView}`}
            initialSources={initialBoard}
            onWatchChange={setWatch}
            siteId={urlState.siteId}
            boardDate={urlState.boardDate}
            selectedDate={urlState.boardFilterDate}
            viewMode={urlState.boardView}
            onUrlStateChange={updateUrl}
          />
        ) : urlState.nav === "context" ? (
          <SiteContextPanel
            siteId={urlState.siteId}
            contextKind={urlState.contextKind}
            documentId={urlState.documentId}
            onUrlStateChange={updateUrl}
          />
        ) : urlState.nav === "risk" ? (
          <RiskAssessmentPanel
            siteId={urlState.siteId}
            riskScreen={urlState.riskScreen}
            riskSiteId={urlState.riskSiteId}
            cardId={urlState.cardId}
            assessmentId={urlState.assessmentId}
            onUrlStateChange={updateUrl}
          />
        ) : (
        <div className={`content-stack${hasChatContent ? " is-chatting" : ""}`}>
          {!hasChatContent ? <>
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
            {PROMPT_CARDS.map((card) => (
              <button
                className={`prompt-card${card.label === ACTIVE_PROMPT_LABEL ? " is-enabled" : " is-disabled"}`}
                key={card.label}
                type="button"
                disabled={card.label !== ACTIVE_PROMPT_LABEL}
                aria-disabled={card.label !== ACTIVE_PROMPT_LABEL}
                onClick={() => chat.setQuestion(card.prompt)}
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
          </> : <>
            <div className="chat-thread-head">
              <p>저장된 대화</p>
              <button className="new-conversation-button" onClick={chat.newConversation} type="button" disabled={chat.isSubmitting}>
                새 대화
              </button>
            </div>
            {chat.turns.map((turn) => <ChatTranscript
              key={turn.id || turn.commandId}
              answer={turn.answer}
              assistantLabel={ASSISTANT_LABEL}
              error={turn.error}
              isSubmitting={turn.status === "pending"}
              question={turn.question}
              toolCalls={turn.toolCalls}
            />)}
            {chat.pendingTurn ? <ChatTranscript
              answer={chat.pendingTurn.answer}
              assistantLabel={ASSISTANT_LABEL}
              error={chat.pendingTurn.error}
              isSubmitting={chat.isSubmitting}
              question={chat.pendingTurn.question}
              toolCalls={chat.pendingTurn.toolCalls}
              anchorRef={chatAnchorRef}
            /> : <div className="chat-latest-anchor" ref={chatAnchorRef} aria-hidden="true" />}
            {chat.error && !chat.pendingTurn ? <p className="chat-error chat-load-error" role="alert">{chat.error}</p> : null}
          </>}

          <div className="composer-dock">
            <div className="new-content-live">
              {isAwayFromLatest ? (
                <button
                  className={`new-content-pill${hasUnseenContent ? " is-new" : ""}`}
                  onClick={scrollToLatest}
                  type="button"
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

            <ChatAskBar
              disabled={chat.isSubmitting}
              formRef={chatComposerRef}
              inputId="question"
              onChange={chat.setQuestion}
              onSubmit={chat.submit}
              statusMessage={askBarStatus(chat)}
              value={chat.question}
            />
          </div>
        </div>
        )}
      </section>
    </main>
  );
}
