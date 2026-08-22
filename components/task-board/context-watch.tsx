"use client";

import type { JSX } from "react";

import type { BoardWatch, ContextSourceIcon } from "./types";

/**
 * "연결된 맥락을 보고 있습니다" 한 덩어리. 예전에는 헤더 오른쪽에 가로로 누워 있었으나
 * 헤더가 붐비고 소스 목록이 본문을 밀어내서 AI 사이드바 머리 아래로 옮겼다. 사이드바는
 * 폭이 좁으므로 여기서는 세로로 선다 — 배치는 `.board-assistant-watch` 가 정한다.
 */

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

export function ContextWatch({ watch }: { watch: BoardWatch }): JSX.Element {
  return (
    <section aria-label={watch.title} className="board-watch">
      <div className="board-watch-head">
        <span aria-hidden="true" className="board-watch-dot" />
        <b>{watch.title}</b>
      </div>
      <ul className="board-watch-list">
        {watch.sources.map((source) => (
          <li className="board-watch-row" key={source.id}>
            <SourceIcon icon={source.icon} />
            <span>{source.label}</span>
            <span className="board-watch-time">{source.lastSyncedLabel}</span>
          </li>
        ))}
      </ul>
      <p className="board-watch-foot">{watch.footnote}</p>
    </section>
  );
}
