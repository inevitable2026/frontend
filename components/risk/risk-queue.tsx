"use client";

import type { WorkItem } from "@/lib/board/types";

/**
 * 조치 대기열 — 이 탭의 첫 화면.
 *
 * 현장이 열두 개인 회사에서 "현장 목록"을 먼저 보여주면 무엇부터 손대야 하는지를
 * 사람이 판단해야 한다. 그래서 목록이 아니라 **순서**를 보여준다.
 *
 * **감지는 여기서 하지 않는다.** 태스크 보드가 이미 규칙 여덟 개로 조건을 찾아
 * `WorkItem` 으로 만들어 두었다(`lib/detect/engine.ts`). 이 화면은 그중 위험성평가에
 * 해당하는 것만 골라 다시 그린다 — 출처가 하나여야 두 화면이 서로 다른 말을 하지 않는다.
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
}: {
  항목들: WorkItem[];
  /** siteId → 현장 이름. 없으면 siteId 를 그대로 보인다. */
  현장이름: Map<string, string>;
  선택: (item: WorkItem) => void;
  불러오는중: boolean;
}) {
  const 위험카드 = 항목들.filter(위험성평가카드인가);

  const 묶인것 = new Map<묶음, WorkItem[]>(순서.map((g) => [g, []]));
  for (const item of 위험카드) 묶인것.get(묶음판정(item))!.push(item);

  if (불러오는중) {
    return <p className="risk-queue-empty">대기열을 불러오는 중…</p>;
  }

  if (위험카드.length === 0) {
    return (
      <p className="risk-queue-empty">
        지금 손봐야 할 위험성평가가 없습니다. 문서를 올리면 바뀐 것이 여기에 뜹니다.
      </p>
    );
  }

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
              {목록.map((item) => (
                <li key={item.itemId}>
                  <button type="button" onClick={() => 선택(item)}>
                    <span className="risk-queue-site">
                      {현장이름.get(item.siteId) ?? item.siteId}
                    </span>
                    <span className="risk-queue-title">{item.title}</span>
                    <span className="risk-queue-meta">
                      {/* 왜 이 카드가 여기 있는지를 화면이 스스로 말한다.
                          조건 문구는 규칙이 만든 것이고 우리가 지어내지 않는다. */}
                      {item.trigger?.condition ??
                        (item.draft?.form === "회의록" ? `행 ${item.draft.rows.length}개 초안` : "")}
                    </span>
                    {item.invalidates.length > 0 ? (
                      <span className="risk-queue-invalidates">
                        전제가 무너진 문서 {item.invalidates.length}건
                      </span>
                    ) : null}
                    {item.blockedBy.length > 0 ? (
                      // 선후 의존. 앞 카드가 승인돼야 이 카드가 확정된다.
                      <span className="risk-queue-blocked">앞선 {item.blockedBy.length}건 대기</span>
                    ) : null}
                    <span className="risk-queue-go" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
