"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";

const navigation = [
  { label: "우리 회사 챗봇", icon: "/assets/messages-square.svg" },
  { label: "현장 맥락 관리", icon: "/assets/database.svg" },
  { label: "TBM 기록 목록", icon: "/assets/file-user.svg" },
  { label: "위험성평가 기록 목록", icon: "/assets/file-exclamation.svg" },
] as const;

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

export function ConstructionConsole() {
  const [activeNav, setActiveNav] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);

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

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion) return;

    setLastQuestion(trimmedQuestion);
    setQuestion("");
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
              }}
            >
              <Image src={item.icon} alt="" width={18} height={18} />
              <span>{item.label}</span>
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
            <div className="asset-strip asset-strip-blur" aria-hidden="true">
              {appAssets.map((asset) => (
                <Image
                  key={`blur-${asset.src}`}
                  className={asset.className}
                  src={asset.src}
                  alt=""
                  width={66}
                  height={64}
                />
              ))}
            </div>
            <div className="asset-strip" aria-hidden="true">
              {appAssets.map((asset) => (
                <Image
                  key={asset.src}
                  className={asset.className}
                  src={asset.src}
                  alt=""
                  width={66}
                  height={64}
                />
              ))}
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

      <section className="workspace">
        <div className="content-stack">
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
                className="prompt-card"
                key={card.label}
                type="button"
                onClick={() => setQuestion(card.prompt.replace("\n", " "))}
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

          <form className="ask-bar" onSubmit={submitQuestion}>
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
              placeholder="무엇이든 물어보세요. "
              rows={2}
            />
            <button className="submit-question" type="submit" aria-label="질문 보내기">
              <Image src="/assets/arrow-up.svg" alt="" width={24} height={24} />
            </button>
            <p className="sr-only" aria-live="polite">
              {lastQuestion ? `질문을 보냈습니다: ${lastQuestion}` : ""}
            </p>
          </form>
        </div>
      </section>
    </main>
  );
}
