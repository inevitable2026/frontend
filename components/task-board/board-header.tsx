"use client";

import type { JSX } from "react";

import type { BoardSiteHeader, TaskCard } from "./types";
import { 카운터규칙 } from "./view-model";

/**
 * 카운터 세 칸. 숫자는 **카드 목록에서 파생한다** — 따로 받아 두면 카드와 어긋날 수 있다.
 *
 * - 조건 발생 : 조건이 발생해 사람이 직접 해야 하는 일 (Todo 열의 경고 카드)
 * - 오늘 기한 : 보드가 그리는 날이 기한인 미완료 카드
 * - 승인 대기 : 승인 열에 올라온 초안
 *
 * 세는 규칙은 view-model.ts 가 들고 있다. 어댑터도 같은 숫자를 BoardSiteHeader.counters 에
 * 채우므로, 규칙을 두 곳에 적으면 같은 화면의 두 자리가 곧바로 갈라진다.
 */

type BoardHeaderProps = {
  site: BoardSiteHeader;
  /** 카운터 숫자의 유일한 출처. 열 분포가 바뀌면 숫자도 같이 바뀐다. */
  cards: TaskCard[];
  /** "오늘 기한" 이 가리키는 날. 보드가 그리는 날짜다. */
  boardDate: string;
};

export function BoardHeader({ site, cards, boardDate }: BoardHeaderProps): JSX.Element {
  // 주/월 토글과 "연결된 맥락" 은 헤더에서 뺐다. 달력 보기는 캘린더 자신의 "월간 펼치기"
  // 버튼 하나가 쥐고, 맥락 목록은 AI 사이드바로 옮겼다(`context-watch.tsx`).
  // 남은 요소는 모두 `.board-header` 의 **직계 자식**이어야 한다. `.board-counters`
  // (flex 1 1 300px)가 헤더의 가로 flex 안에서 둘째 줄로 내려가 눕는 전제이고, 헤더
  // 밖으로 나가면 `.board-shell` 의 세로 flex 를 타고 위아래로 늘어난다.
  return (
    <header className="board-header">
      <h1 className="board-header-title">{site.name}</h1>
      <span className="board-header-phase">{site.phase}</span>

      <div className="board-counters">
        {카운터규칙(boardDate).map((counter) => (
          <div className="board-counter" key={counter.key}>
            <span className={`board-counter-value is-${counter.tone}`}>
              {cards.filter(counter.match).length}
            </span>
            <span className="board-counter-label">{counter.label}</span>
          </div>
        ))}
      </div>
    </header>
  );
}
