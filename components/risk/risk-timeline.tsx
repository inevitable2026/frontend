"use client";

import type { WorkItem } from "@/lib/board/types";

/**
 * 현장 하나의 시간축.
 *
 * 대기열이 "지금 무엇을 손봐야 하는가"라면 여기는 **"이 현장에 무슨 일이 있었는가"** 다.
 * 제품의 논지가 여기서 화면이 된다 — *"이전 평가 이후 무엇이 바뀌었나"* 가 한 줄로 보인다.
 *
 * **여기서도 감지하지 않는다.** 태스크 보드가 만든 `WorkItem` 을 시간순으로 다시 세울 뿐이다.
 * 사건의 종류는 카드가 스스로 말한다 — 무효화가 있으면 변경, 초안이 있으면 작성,
 * 확정 시각이 있으면 승인.
 */

type 사건종류 = "변경" | "작성" | "승인" | "할일";

const 사건표시: Record<사건종류, { 기호: string; 라벨: string; 클래스: string }> = {
  변경: { 기호: "▲", 라벨: "변경 감지", 클래스: "is-변경" },
  작성: { 기호: "●", 라벨: "작성 중", 클래스: "is-작성" },
  승인: { 기호: "■", 라벨: "승인됨", 클래스: "is-승인" },
  할일: { 기호: "○", 라벨: "할 일", 클래스: "is-할일" },
};

function 종류판정(item: WorkItem): 사건종류 {
  if (item.confirmedAt) return "승인";
  if (item.invalidates.length > 0) return "변경";
  if (item.draft) return "작성";
  return "할일";
}

/**
 * 시간축에 놓을 시각. 승인된 것은 승인 시각이, 나머지는 만들어진 시각이 사건 시점이다.
 *
 * `dueBy` 를 쓰지 않는 이유는 그것이 **미래**이기도 하고 ISO 가 아닐 수도 있기 때문이다
 * (`docs/board-contract.md:394-397`). 시간축은 일어난 일을 놓는 자리다.
 */
function 사건시각(item: WorkItem): string {
  return item.confirmedAt ?? item.createdAt;
}

/** KST 기준 `YYYY-MM-DD`. `Date` 로 돌리면 UTC 서버리스에서 하루가 밀린다. */
function 날짜키(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

function 날짜표시(key: string): string {
  const [, m, d] = key.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

export default function RiskTimeline({
  항목들,
  현장이름,
  뒤로,
  선택,
  기준시각,
}: {
  항목들: WorkItem[];
  현장이름: string;
  뒤로: () => void;
  선택: (item: WorkItem) => void;
  기준시각: number;
}) {
  // 최근이 위로. 같은 날 안에서도 늦은 것이 위다.
  const 정렬 = [...항목들].sort((a, b) => 사건시각(b).localeCompare(사건시각(a)));

  const 날짜별 = new Map<string, WorkItem[]>();
  for (const item of 정렬) {
    const key = 날짜키(사건시각(item));
    if (!날짜별.has(key)) 날짜별.set(key, []);
    날짜별.get(key)!.push(item);
  }

  return (
    <div className="risk-timeline">
      <header className="risk-ws-head">
        <button type="button" className="risk-ws-back" onClick={뒤로}>
          ← 대기열
        </button>
        <div>
          <p className="risk-ws-site">현장 시간축</p>
          <h2>{현장이름}</h2>
        </div>
        <span className="risk-ws-progress">{항목들.length}건</span>
      </header>

      {날짜별.size === 0 ? (
        <p className="risk-queue-empty">이 현장에 아직 기록이 없습니다.</p>
      ) : (
        [...날짜별.entries()].map(([날짜, 목록]) => (
          <section className="risk-tl-day" key={날짜}>
            <h3>{날짜표시(날짜)}</h3>

            <ol>
              {목록.map((item) => {
                const 종류 = 종류판정(item);
                const { 기호, 라벨, 클래스 } = 사건표시[종류];

                return (
                  <li className={`risk-tl-item ${클래스}`} key={item.itemId}>
                    <span className="risk-tl-mark" aria-hidden="true">
                      {기호}
                    </span>

                    <button type="button" className="risk-tl-body" onClick={() => 선택(item)}>
                      <span className="risk-tl-kind">{라벨}</span>
                      <span className="risk-tl-title">{item.title}</span>

                      {/* 변경 사건은 무엇이 바뀌었고 무엇이 무너졌는지를 그대로 보인다.
                          이 두 줄이 이 제품이 무엇인지를 말한다. */}
                      {item.trigger === null ? null : (
                        <span className="risk-tl-why">{item.trigger.condition}</span>
                      )}

                      {item.invalidates.map((inv) => (
                        <span className="risk-tl-invalid" key={`${inv.docId}-${inv.scope}`}>
                          ↳ <b>{inv.docId}</b> {inv.scope || "전체"} 의 전제가 무너졌습니다
                        </span>
                      ))}

                      {item.produces.length > 0 ? (
                        <span className="risk-tl-produces">
                          ↳ 파생 {item.produces.map((p) => p.form).join(" · ")}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}
