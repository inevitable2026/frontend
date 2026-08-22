"use client";

import Image from "next/image";
import { type CSSProperties, useEffect, useRef, useState } from "react";

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

/**
 * 사이드바 차례. **첫 항목이 태스크 보드**이므로 아래 인덱스가 곧 화면이다.
 * 0 태스크 보드 · 1 우리 회사 챗봇 · 2 현장 맥락 관리 · 3 TBM 기록 · 4 위험성평가 기록.
 * 순서를 바꾸면 `NAV_BOARD` · `NAV_SITE_CONTEXT` · `NAV_RISK` 세 상수도 같이 옮겨야 한다.
 * 날숫자로 비교하면 안 된다 — 실제로 위험성평가를 `=== 3` 으로 두었다가 태스크 보드가
 * 앞에 끼면서 조용히 TBM 탭을 가리켰다. 자동 병합은 인덱스의 의미를 모른다.
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
const NAV_RISK = 4;

/** 배지를 세는 현장. 태스크 보드의 `SITE_ID` 와 같다. 현장 선택이 붙으면 그걸 따른다. */
const BADGE_SITE = "site_gimpo_gochon_01";

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
}: {
  /**
   * 서버가 첫 그림 전에 읽어 둔 보드 재료. 태스크 보드가 처음 열리는 화면이라 이것을 들고
   * 오면 카드가 첫 HTML 에 이미 서 있다. 서버 쪽 읽기가 실패하면 null 로 오고, 그때는
   * 보드가 예전처럼 마운트 뒤에 직접 읽는다.
   */
  initialBoard?: BoardSources | null;
}) {
  const [activeNav, setActiveNav] = useState(NAV_BOARD);
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

  // 사이드바 배지는 탭을 열기 전에도 맞아야 한다. 그래서 콘솔이 직접 센다.
  useEffect(() => {
    let 살아있음 = true;
    fetch(`/api/board/items?siteId=${encodeURIComponent(BADGE_SITE)}`)
      .then((r) => (r.ok ? (r.json() as Promise<BoardPage>) : null))
      .then((page) => {
        if (!살아있음 || !page) return;
        const n = 재평가건수(page.items);
        setRiskBadge(n > 0 ? n : undefined);
      })
      .catch(() => {
        /* 배지를 못 세면 안 보인다. 틀린 숫자를 보이는 것보다 낫다. */
      });
    return () => {
      살아있음 = false;
    };
  }, []);

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
              {(() => {
                // 위험성평가 배지는 실측값이라 navigation 상수가 아니라 상태에서 온다.
                const badge = index === NAV_RISK ? riskBadge : item.badge;
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
              <h2 id="upload-title">맥락/레퍼런스 추가하기</h2>
              <p>위험성평가서, 공정표, 회사 양식 등 현장 문서를 올려주시면, 우리 현장 기준에 맞는 AI 초안을 만들어 드립니다.</p>
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
          <TaskBoard initialSources={initialBoard} onWatchChange={setWatch} />
        ) : activeNav === NAV_SITE_CONTEXT ? (
          <SiteContextPanel />
        ) : activeNav === NAV_RISK ? (
          <RiskAssessmentPanel />
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
