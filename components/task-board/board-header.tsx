"use client";

import type { JSX } from "react";

import type {
  BoardCounterKey,
  BoardSiteHeader,
  CalendarViewMode,
  ContextSourceIcon,
  TaskCard,
} from "./types";

/**
 * 카운터 세 칸. 숫자는 **카드 목록에서 파생한다** — 따로 받아 두면 카드와 어긋날 수 있다.
 *
 * - 조건 발생 : 조건이 발생해 사람이 직접 해야 하는 일 (Todo 열의 경고 카드)
 * - 오늘 기한 : 아직 끝나지 않은 기한 카드
 * - 승인 대기 : 승인 열에 올라온 초안
 */
const COUNTER_DEFS: readonly {
  key: BoardCounterKey;
  label: string;
  tone: "alert" | "due" | "ai";
  match: (card: TaskCard) => boolean;
}[] = [
  {
    key: "condition",
    label: "조건 발생",
    tone: "alert",
    match: (card) => card.status === "todo" && card.tone === "alert",
  },
  {
    key: "due",
    label: "오늘 기한",
    tone: "due",
    match: (card) => card.status !== "done" && card.tone === "due",
  },
  {
    key: "approval",
    label: "승인 대기",
    tone: "ai",
    match: (card) => card.status === "approval",
  },
];

const VIEW_MODES: readonly { mode: CalendarViewMode; label: string }[] = [
  { mode: "week", label: "주" },
  { mode: "month", label: "월" },
];

const SOURCE_ICON: Record<ContextSourceIcon, JSX.Element> = {
  mail: (
    <>
      <rect height="16" rx="2" width="20" x="2" y="4" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  document: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
    </>
  ),
  schedule: (
    <>
      <path d="M3 17h18" />
      <path d="M6 17V9" />
      <path d="M11 17V5" />
      <path d="M16 17v-6" />
    </>
  ),
  observation: (
    <>
      <path d="M12 2v20" />
      <path d="M2 12h20" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
};

function SourceIcon({ icon }: { icon: ContextSourceIcon }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      {SOURCE_ICON[icon]}
    </svg>
  );
}

type BoardHeaderProps = {
  site: BoardSiteHeader;
  /** 카운터 숫자의 유일한 출처. 열 분포가 바뀌면 숫자도 같이 바뀐다. */
  cards: TaskCard[];
  viewMode: CalendarViewMode;
  onViewModeChange: (mode: CalendarViewMode) => void;
};

export function BoardHeader({
  site,
  cards,
  viewMode,
  onViewModeChange,
}: BoardHeaderProps): JSX.Element {
  // 여섯 요소가 모두 `.board-header` 의 **직계 자식**이어야 한다. `.board-counters`(flex 1 1 300px)와
  // `.board-watch`(flex 2 1 460px)는 헤더의 가로 flex 안에서 둘째 줄로 내려가 눕는 전제이고,
  // 헤더 밖으로 나가면 `.board-shell` 의 세로 flex 를 타고 위아래로 늘어난다.
  return (
    <header className="board-header">
      <h1 className="board-header-title">{site.name}</h1>
      <span className="board-header-phase">{site.phase}</span>
      <div aria-label="달력 보기 범위" className="board-view-toggle" role="group">
        {VIEW_MODES.map((item) => (
          <button
            aria-pressed={viewMode === item.mode}
            className={
              viewMode === item.mode ? "board-view-toggle-button is-on" : "board-view-toggle-button"
            }
            key={item.mode}
            onClick={() => onViewModeChange(item.mode)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="board-counters">
        {COUNTER_DEFS.map((counter) => (
          <div className="board-counter" key={counter.key}>
            <span className={`board-counter-value is-${counter.tone}`}>
              {cards.filter(counter.match).length}
            </span>
            <span className="board-counter-label">{counter.label}</span>
          </div>
        ))}
      </div>

      <section aria-label={site.watch.title} className="board-watch">
        <div className="board-watch-head">
          <span aria-hidden="true" className="board-watch-dot" />
          <b>{site.watch.title}</b>
        </div>
        <ul className="board-watch-list">
          {site.watch.sources.map((source) => (
            <li className="board-watch-row" key={source.id}>
              <SourceIcon icon={source.icon} />
              <span>{source.label}</span>
              <span className="board-watch-time">{source.lastSyncedLabel}</span>
            </li>
          ))}
        </ul>
        <p className="board-watch-foot">{site.watch.footnote}</p>
      </section>
    </header>
  );
}
