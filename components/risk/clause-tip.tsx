"use client";

import { useCallback, useRef, useState } from "react";

import type { Clause } from "@/lib/risk/types";

/**
 * 조문 칩. 올려놓으면 조문 본문이 뜬다.
 *
 * 예전에는 `title` 속성 하나였다. 브라우저 기본 툴팁은 ⑴ 뜨는 데 1초 넘게 걸리고
 * ⑵ 줄바꿈이 없어 본문 같은 긴 글에 못 쓰고 ⑶ 키보드로는 아예 안 뜬다. 무엇보다
 * `title={c.title}` 이라 **제목만** 보였다 — "제200조(접촉 방지)" 옆에 "접촉 방지"가
 * 뜨는 셈이라 새로 알려 주는 것이 없었다.
 *
 * 정작 필요한 것은 **본문**이다. 이 화면에서 조문은 "왜 이 대책이어야 하는가"의 근거이고,
 * 근거는 읽을 수 있어야 근거다.
 *
 * `position: fixed` 로 띄운다. 칩이 `overflow` 가 걸린 카드 안에 있어서 absolute 로 두면
 * 잘린다. 대신 스크롤·리사이즈로 좌표가 낡으므로 열 때마다 다시 잰다.
 */

/**
 * 조문이 어떻게 붙었는지. 사람이 판단하려면 출처를 알아야 한다.
 *
 * **셋을 한 문장으로 뭉개지 않는다.** 같은 용어가 그대로 있는 것과 뜻이 비슷할 뿐인 것은
 * 근거의 강도가 다르고, 이 화면에서 그 차이는 법령 인용을 그대로 써도 되는지를 가른다.
 * 값 자체(`keyword` 등)는 화면에 적지 않고 `title` 로만 내보낸다.
 */
const 출처문구: Record<string, string> = {
  keyword: "이 조문에 같은 용어가 그대로 있습니다.",
  bm25: "이 조문의 본문 내용이 비슷합니다.",
  embedding: "뜻이 비슷해 찾았습니다. 사람이 한 번 확인해 주세요.",
};

type 위치 = { left: number; top: number; 아래: boolean };

export default function ClauseTip({
  clause,
  matchSource,
}: {
  clause: Clause;
  /** `Hazard.match_source` — 이 행의 조문들이 어떤 경로로 붙었는지. */
  matchSource?: string | null;
}) {
  const [자리, set자리] = useState<위치 | null>(null);
  const 칩 = useRef<HTMLButtonElement>(null);

  const 열기 = useCallback(() => {
    const el = 칩.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 아래 공간이 카드 높이(대략 200px)보다 좁으면 위로 뒤집는다.
    const 아래 = window.innerHeight - r.bottom > 200;
    set자리({
      left: Math.min(Math.max(12, r.left), window.innerWidth - 372),
      top: 아래 ? r.bottom + 8 : r.top - 8,
      아래,
    });
  }, []);

  const 닫기 = useCallback(() => set자리(null), []);

  return (
    <>
      <button
        ref={칩}
        type="button"
        className={`clause-chip${자리 ? " is-open" : ""}`}
        onMouseEnter={열기}
        onMouseLeave={닫기}
        onFocus={열기}
        onBlur={닫기}
        onKeyDown={(e) => {
          if (e.key === "Escape") 닫기();
        }}
        // 클릭으로도 열고 닫는다. 터치 기기에는 hover 가 없다.
        onClick={() => (자리 ? 닫기() : 열기())}
        aria-expanded={자리 !== null}
      >
        {clause.label}
      </button>

      {자리 ? (
        <div
          className={`clause-card${자리.아래 ? "" : " is-above"}`}
          role="tooltip"
          style={{
            left: 자리.left,
            ...(자리.아래 ? { top: 자리.top } : { bottom: window.innerHeight - 자리.top }),
          }}
        >
          <p className="clause-card-head">
            <b>{clause.article}</b>
            <span>{clause.title}</span>
          </p>

          {clause.body ? (
            <p className="clause-card-body">{clause.body}</p>
          ) : (
            // 본문이 비어 있으면 그렇다고 말한다. 빈 카드를 띄우면 조회가 실패한 건지
            // 원래 없는 건지 구분이 안 된다.
            <p className="clause-card-body is-empty">
              조문 본문을 불러오지 못했습니다. 조문 번호로 법령 원문을 확인해 주세요.
            </p>
          )}

          {/* 알 수 없는 출처는 지어내지 않고 문장에서 뺀다. 원값은 title 로만 남긴다. */}
          <p className="clause-card-foot" title={matchSource ? `조문 매칭 출처: ${matchSource}` : undefined}>
            산업안전보건기준에 관한 규칙
            {matchSource && 출처문구[matchSource] ? ` · ${출처문구[matchSource]}` : ""}
          </p>
        </div>
      ) : null}
    </>
  );
}
