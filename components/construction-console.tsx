"use client";

import Image from "next/image";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import { ChatAskBar } from "@/components/chat/chat-ask-bar";
import { useLatestPin } from "./chat/use-latest-pin";
import { askBarStatus } from "@/components/chat/status";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { ACTIVE_PROMPT_LABEL, ASSISTANT_LABEL, PROMPT_CARDS } from "@/components/chat/prompts";
import { useLawChat } from "@/components/chat/use-law-chat";
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
const NAV_CHAT = 1;
const NAV_SITE_CONTEXT = 2;

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
  const uploadInput = useRef<HTMLInputElement>(null);
  // 챗봇 탭의 대화. 보드의 AI 사이드바는 같은 훅을 따로 부르므로 상태가 섞이지 않는다.
  const chat = useLawChat();
  // 답이 길어질 때 화면을 따라 내리는 규칙. 사용자가 위로 올라가 있으면 끌어내리지 않는다.
  const pin = useLatestPin({
    enabled: activeNav === NAV_CHAT && chat.lastQuestion.length > 0,
    hasResponseContent:
      chat.toolCalls.length > 0 || chat.answer.length > 0 || chat.error.length > 0,
    revision: `${chat.toolCalls.length}:${chat.answer.length}:${chat.error.length}`,
  });

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
          {navigation.map((item, index) => (
            <button
              className={`nav-item${activeNav === index ? " is-active" : ""}`}
              key={item.label}
              type="button"
              aria-current={activeNav === index ? "page" : undefined}
              onClick={() => {
                setActiveNav(index);
                setSidebarOpen(false);
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
        <div className={`content-stack${chat.lastQuestion ? " is-chatting" : ""}`}>
          {!chat.lastQuestion ? <>
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
          </> : <ChatTranscript
            answer={chat.answer}
            assistantLabel={ASSISTANT_LABEL}
            error={chat.error}
            isSubmitting={chat.isSubmitting}
            question={chat.lastQuestion}
            toolCalls={chat.toolCalls}
            anchorRef={pin.anchorRef}
          />}

          <div className="composer-dock">
            <div className="new-content-live">
              {pin.isAwayFromLatest ? (
                <button
                  className={`new-content-pill${pin.hasUnseenContent ? " is-new" : ""}`}
                  onClick={pin.scrollToLatest}
                  type="button"
                >
                  <span className="new-content-touch-target" aria-hidden="true" />
                  {pin.hasUnseenContent ? <span className="new-content-dot" aria-hidden="true" /> : null}
                  <span>{pin.hasUnseenContent ? "새 내용이 도착했어요" : "맨 아래로 이동"}</span>
                  <span className="new-content-arrow" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {pin.hasUnseenContent ? "새 내용이 도착했습니다. 새 내용으로 이동 버튼을 이용할 수 있습니다." : ""}
            </span>

            <ChatAskBar
              disabled={chat.isSubmitting}
              formRef={pin.composerRef}
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
