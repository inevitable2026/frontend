"use client";

import type { CSSProperties, JSX } from "react";

/**
 * 보드를 읽는 동안 세워 두는 뼈대.
 *
 * 회색 덩어리의 자리를 따로 잡지 않고 **진짜 화면이 쓰는 레이아웃 클래스를 그대로 두른다**
 * (`.board-header` · `.board-brief` · `.board-cal` · `.board-kanban`). 그래야 반응형 규칙이
 * 바뀌어도 뼈대와 본 화면이 따로 놀지 않고, 데이터가 도착하는 순간 요소가 껑충 뛰지 않는다.
 *
 * 여기에 적힌 숫자는 전부 고정값이다. 무작위로 폭을 흔들면 서버가 그린 표시와 브라우저가
 * 다시 그린 표시가 어긋나 하이드레이션 경고가 난다.
 */

/** 칸반 세 열에 각각 몇 장의 카드 자리를 깔지. Todo · 승인 · 완료 차례다. */
const 열별_카드수 = [4, 3, 3] as const;

/** 카드마다 제목 줄의 폭을 달리해 같은 모양이 반복되는 인상을 줄인다. */
const 카드_제목폭 = ["86%", "68%", "92%", "74%"] as const;

/** 브리핑 지표 네 칸의 이름표 폭. */
const 지표_이름폭 = [46, 58, 52, 64] as const;

type SkelProps = {
  /** 숫자면 px, 문자열이면 그대로 CSS 길이로 쓴다. */
  width: number | string;
  /** 기본 12px. 글자 한 줄과 비슷한 두께다. */
  height?: number;
  radius?: number;
};

function Skel({ width, height = 12, radius }: SkelProps): JSX.Element {
  const style: CSSProperties = {
    width: typeof width === "number" ? `${width}px` : width,
    height: `${height}px`,
  };
  if (radius !== undefined) style.borderRadius = `${radius}px`;
  return <span className="board-skel" style={style} />;
}

function SkeletonHeader(): JSX.Element {
  return (
    <header aria-hidden="true" className="board-header">
      <Skel width={196} height={22} />
      <Skel width={92} height={13} />

      <div className="board-counters">
        {[0, 1, 2].map((index) => (
          <div className="board-counter" key={index}>
            <Skel width={34} height={18} />
            <Skel width={62} height={11} />
          </div>
        ))}
      </div>
    </header>
  );
}

function SkeletonBriefing(): JSX.Element {
  return (
    <section aria-hidden="true" className="board-brief">
      <div className="board-brief-card">
        <div className="board-brief-top">
          <Skel width={30} height={30} radius={9} />
          <div className="board-brief-heading board-skel-stack">
            <Skel width={168} height={14} />
            <Skel width={112} height={11} />
          </div>
          <Skel width={78} height={22} radius={999} />
        </div>

        <div className="board-skel-lede">
          <Skel width="100%" height={14} />
          <Skel width="72%" height={14} />
        </div>

        <div className="board-brief-metrics">
          {지표_이름폭.map((폭, index) => (
            <div className="board-brief-metric board-skel-stack" key={index}>
              <Skel width={30} height={16} />
              <Skel width={폭} height={11} />
            </div>
          ))}
        </div>

        <div className="board-brief-list">
          {[0, 1, 2].map((index) => (
            <div className="board-skel-rsn" key={index}>
              <Skel width={9} height={9} radius={999} />
              <Skel width={index === 1 ? "58%" : "44%"} height={13} />
              <Skel width={14} height={14} radius={4} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SkeletonCalendar(): JSX.Element {
  return (
    <section aria-hidden="true" className="board-cal">
      <div className="board-cal-bar">
        <div className="board-cal-nav">
          <Skel width={28} height={28} radius={7} />
          <Skel width={28} height={28} radius={7} />
        </div>
        <Skel width={186} height={14} />
        <div className="board-skel-legend">
          <Skel width={150} height={11} />
          <Skel width={64} height={26} radius={7} />
        </div>
      </div>

      <div className="board-week">
        {[0, 1, 2, 3, 4, 5, 6].map((index) => (
          <div className="board-day board-skel-day" key={index}>
            <div className="board-day-top board-skel-day-top">
              <Skel width={18} height={11} />
              <Skel width={14} height={14} />
            </div>
            <Skel width="100%" height={16} radius={5} />
            {index % 3 === 0 ? null : <Skel width="82%" height={16} radius={5} />}
          </div>
        ))}
      </div>
    </section>
  );
}

function SkeletonCard({ 제목폭, 꼬리 }: { 제목폭: string; 꼬리: boolean }): JSX.Element {
  return (
    <div className="board-skel-card">
      <div className="board-skel-card-top">
        <Skel width={54} height={16} radius={999} />
        <Skel width={40} height={11} />
      </div>
      <Skel width={제목폭} height={13} />
      {꼬리 ? <Skel width="62%" height={11} /> : null}
      <div className="board-skel-card-foot">
        <Skel width={72} height={18} radius={999} />
        <Skel width={46} height={11} />
      </div>
    </div>
  );
}

function SkeletonKanban(): JSX.Element {
  return (
    <div aria-hidden="true" className="board-kanban-wrap">
      <div className="board-kanban-head">
        <Skel width={148} height={15} />
        <Skel width={34} height={12} />
        <Skel width={96} height={22} radius={999} />
        {/* 끌기 안내 문구 자리. 클래스를 그대로 두르므로 1199px 아래에서 같이 줄바꿈된다. */}
        <span className="board-kanban-hint">
          <Skel width={232} height={11} />
        </span>
      </div>

      <div className="board-kanban">
        {열별_카드수.map((카드수, columnIndex) => (
          <section className="board-column" key={columnIndex}>
            <div className="board-column-head">
              <Skel width={7} height={7} radius={999} />
              <Skel width={52} height={13} />
              <Skel width={16} height={12} />
            </div>
            <div className="board-column-body">
              {Array.from({ length: 카드수 }, (_, cardIndex) => (
                <SkeletonCard
                  key={cardIndex}
                  제목폭={카드_제목폭[cardIndex % 카드_제목폭.length]}
                  꼬리={cardIndex % 2 === 0}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * 뼈대 전체.
 *
 * `aria-busy` 로 이 영역이 아직 채워지는 중임을 알리고, 회색 덩어리 자체는 읽을 것이 없으므로
 * `aria-hidden` 으로 감춘다. 대신 아래의 `.board-status` 가 같은 문장을 소리로 읽어 준다 —
 * 그 자리는 보드가 다 그려진 뒤에도 카드 이동을 알리는 데 쓰이는 자리와 같다.
 */
export function BoardSkeleton({ message }: { message: string }): JSX.Element {
  return (
    <div aria-busy="true" className="board-shell is-loading">
      <SkeletonHeader />
      <SkeletonBriefing />
      <SkeletonCalendar />
      <SkeletonKanban />

      <div aria-live="polite" className="board-status" role="status">
        {message}
      </div>
    </div>
  );
}
