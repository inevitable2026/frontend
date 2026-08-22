"use client";

import { useState, type JSX } from "react";

import { BriefingItem, RichLine } from "./briefing-item";
import type { DailyBriefing } from "./types";

const BRIEFING_TITLE = "오늘의 브리핑";

function BriefAvatar(): JSX.Element {
  return (
    <span aria-hidden="true" className="board-brief-avatar">
      <svg
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path d="M12 3v3" />
        <path d="M12 18v3" />
        <path d="m5.6 5.6 2.1 2.1" />
        <path d="m16.3 16.3 2.1 2.1" />
        <path d="M3 12h3" />
        <path d="M18 12h3" />
        <path d="m5.6 18.4 2.1-2.1" />
        <path d="m16.3 7.7 2.1-2.1" />
      </svg>
    </span>
  );
}

type DailyBriefingProps = {
  briefing: DailyBriefing;
  /** 컨테이너가 펼침 상태를 들고 있을 때만 넘긴다. 없으면 이 컴포넌트가 직접 든다. */
  openConditionIds?: string[];
  onToggleCondition?: (conditionId: string) => void;
  onFocusCard?: (cardId: string) => void;
};

export function DailyBriefingPanel({
  briefing,
  openConditionIds,
  onToggleCondition,
  onFocusCard,
}: DailyBriefingProps): JSX.Element {
  // 여러 항목이 한꺼번에 펼쳐질 수 있다. 첫 진입의 펼침은 `defaultOpen` 이 정한다.
  // 초기값을 지연 계산으로 한 번만 읽으므로 효과 안에서 setState 를 부를 일이 없다.
  const [ownOpenIds, setOwnOpenIds] = useState<string[]>(() =>
    briefing.conditions
      .filter((condition) => condition.defaultOpen)
      .map((condition) => condition.conditionId),
  );

  const openIds = openConditionIds ?? ownOpenIds;

  function toggle(conditionId: string): void {
    if (onToggleCondition) {
      onToggleCondition(conditionId);
      return;
    }
    setOwnOpenIds((previous) =>
      previous.includes(conditionId)
        ? previous.filter((id) => id !== conditionId)
        : [...previous, conditionId],
    );
  }

  return (
    <section aria-label="AI 브리핑" className="board-brief">
      <div className="board-brief-card">
        <div className="board-brief-top">
          <BriefAvatar />
          <div className="board-brief-heading">
            <b>{BRIEFING_TITLE}</b>
            <span>{briefing.stampLabel}</span>
          </div>
          <span className="board-brief-live">
            <i aria-hidden="true" />
            {briefing.liveLabel}
          </span>
        </div>

        <p className="board-brief-lede">
          <RichLine runs={briefing.lede} />
        </p>

        <div className="board-brief-metrics">
          {briefing.metrics.map((metric) => (
            <div className="board-brief-metric" key={metric.key}>
              <span
                className={
                  metric.tone === "ai"
                    ? "board-brief-metric-value is-ai"
                    : "board-brief-metric-value"
                }
              >
                {metric.value}
              </span>
              <span className="board-brief-metric-label">{metric.label}</span>
            </div>
          ))}
        </div>

        <div className="board-brief-list">
          {briefing.conditions.map((condition) => (
            <BriefingItem
              condition={condition}
              isOpen={openIds.includes(condition.conditionId)}
              key={condition.conditionId}
              onFocusCard={onFocusCard}
              onToggle={toggle}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
