"use client";

import { 급함색, 기한문구, 종류라벨 } from "@/components/risk/derive";
import type { WorkItem } from "@/lib/board/types";

/**
 * 조치 대기열 — 이 탭의 첫 화면.
 *
 * 현장이 열둘인 회사에서 "현장 목록"을 먼저 보여주면 무엇부터 손대야 하는지를
 * 사람이 판단해야 한다. 그래서 목록이 아니라 **순서**를 보여준다.
 *
 * **감지는 여기서 하지 않는다.** 태스크 보드가 이미 규칙 여덟 개로 조건을 찾아
 * `WorkItem` 으로 만들어 두었다(`lib/detect/engine.ts`). 이 화면은 그중 위험성평가에
 * 해당하는 것만 골라 다시 그린다 — 출처가 하나여야 두 화면이 서로 다른 말을 하지 않는다.
 *
 * **시각 언어도 보드 것을 그대로 쓴다.** 같은 데이터를 보여주면서 생김새가 다르면
 * 사용자는 두 개를 따로 배워야 한다. `board-card*` 클래스와 `카드로()` 어댑터를 재사용하고,
 * 여기서만 필요한 것(묶음 머리)만 `risk-queue-*` 로 새로 둔다.
 */

export type 현장 = { id: string; code: string; name: string };

/** 위험성평가와 상관있는 카드만. 회의록(=위험성평가 회의록)을 만들거나 이미 가진 것. */
export function 위험성평가카드인가(item: WorkItem): boolean {
  if (item.draft?.form === "회의록") return true;
  return item.produces.some((p) => p.form === "회의록");
}

type 묶음 = "재평가" | "작성중" | "최신";

/**
 * 카드를 세 줄로 가른다.
 * - 재평가: 무효화가 걸린 것. 기존 평가가 더 이상 사실이 아니게 된 경우다.
 * - 작성중: 초안이 붙었고 아직 승인 전.
 * - 최신: 나머지.
 */
/**
 * 재평가가 필요한 건수. 사이드바 배지가 이 값을 쓴다.
 *
 * **세어서 쓴다.** 태스크 보드의 배지 11 은 상수로 박혀 있는데(`construction-console.tsx:27`),
 * 그 숫자가 실제와 어긋나면 배지가 거짓말이 된다. 여기서는 대기열이 실제로 고른 것을 센다.
 */
export function 재평가건수(항목들: WorkItem[]): number {
  return 항목들.filter((i) => 위험성평가카드인가(i) && i.invalidates.length > 0).length;
}

function 묶음판정(item: WorkItem): 묶음 {
  if (item.invalidates.length > 0) return "재평가";
  if (item.draft && item.status !== "done") return "작성중";
  return "최신";
}

const 묶음표시: Record<묶음, { 기호: string; 라벨: string }> = {
  재평가: { 기호: "▲", 라벨: "재평가 필요" },
  작성중: { 기호: "●", 라벨: "작성 중" },
  최신: { 기호: "■", 라벨: "최신" },
};

const 순서: 묶음[] = ["재평가", "작성중", "최신"];

export default function RiskQueue({
  항목들,
  현장이름,
  선택,
  불러오는중,
  기준시각,
}: {
  항목들: WorkItem[];
  /** siteId → 현장 이름. 없으면 siteId 를 그대로 보인다. */
  현장이름: Map<string, string>;
  선택: (item: WorkItem) => void;
  불러오는중: boolean;
  /**
   * 기한 판정("16:30 지남")의 기준. **부모가 넘긴다.**
   * 렌더 중에 `Date.now()` 를 부르면 리렌더마다 판정이 달라져 화면이 스스로 흔들린다
   * (`react-hooks/purity` 가 잡아 준다). 시각은 렌더의 입력이지 렌더가 만드는 것이 아니다.
   */
  기준시각: number;
}) {
  const 위험카드 = 항목들.filter(위험성평가카드인가);

  const 묶인것 = new Map<묶음, WorkItem[]>(순서.map((g) => [g, []]));
  for (const item of 위험카드) 묶인것.get(묶음판정(item))!.push(item);

  if (불러오는중) return <p className="risk-queue-empty">대기열을 불러오는 중…</p>;

  if (위험카드.length === 0) {
    return (
      <p className="risk-queue-empty">
        지금 손봐야 할 위험성평가가 없습니다. 문서를 올리면 바뀐 것이 여기에 뜹니다.
      </p>
    );
  }

  const 제목찾기 = new Map(항목들.map((i) => [i.itemId, i.title]));

  return (
    <div className="risk-queue">
      {순서.map((묶음이름) => {
        const 목록 = 묶인것.get(묶음이름)!;
        if (목록.length === 0) return null;
        const { 기호, 라벨 } = 묶음표시[묶음이름];

        return (
          <section className={`risk-queue-group is-${묶음이름}`} key={묶음이름}>
            <h3>
              <span aria-hidden="true">{기호}</span>
              {라벨}
              <em>{목록.length}</em>
            </h3>

            <ul>
              {목록.map((item) => {
                const 기한 = 기한문구(item.dueBy, 기준시각);
                const 막힘 = item.blockedBy.length > 0;

                return (
                  <li key={item.itemId}>
                    {/* 보드 카드와 같은 뼈대. 다른 점은 이것이 통째로 누를 수 있는 버튼이라는 것뿐이다. */}
                    <button
                      type="button"
                      className={`board-card risk-queue-card ${급함색(item)}`}
                      onClick={() => 선택(item)}
                    >
                      <span className="board-card-top">
                        <span className="board-card-kind is-doc">{종류라벨(item)}</span>
                        {item.origin === "machine" ? (
                          <span className="board-card-ai-mark">
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 3v3" />
                              <path d="M12 18v3" />
                              <path d="M3 12h3" />
                              <path d="M18 12h3" />
                            </svg>
                            자동 생성
                          </span>
                        ) : null}
                        <span className="risk-queue-site">
                          {현장이름.get(item.siteId) ?? item.siteId}
                        </span>
                      </span>

                      <span className="board-card-title">{item.title}</span>
                      {item.summary === null ? null : (
                        <span className="board-card-note">{item.summary}</span>
                      )}

                      <span className="board-card-meta">
                        {item.invalidates.length > 0 ? (
                          <span className="board-tag is-alert">무효 {item.invalidates.length}</span>
                        ) : null}
                        {item.produces.slice(1).map((p) => (
                          <span key={p.form} className="board-tag is-doc">
                            {p.form}
                          </span>
                        ))}
                      </span>

                      {/* 왜 이 카드가 여기 있는지. 규칙이 만든 문구를 그대로 쓴다. */}
                      {item.trigger === null ? null : (
                        <span className="board-card-why">
                          <b>{item.trigger.ruleId}</b> · {item.trigger.condition}
                        </span>
                      )}

                      {막힘 ? (
                        <span className="board-card-blocked">
                          {item.blockedBy.map((id) => 제목찾기.get(id) ?? id).join(" · ")} 이(가) 먼저
                          확정돼야 합니다
                        </span>
                      ) : null}

                      {기한.글 === null ? null : (
                        <span className="board-card-foot">
                          <span className={`board-card-when${기한.급함 ? " is-hot" : ""}`}>{기한.글}</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
