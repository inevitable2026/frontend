"use client";

import type { Assessment, Hazard } from "@/lib/risk/types";

/**
 * 평가표 + 이행확인.
 *
 * 넓은 화면에서는 표, 좁은 화면에서는 카드로 그린다. 같은 데이터를 두 번 그리지 않고
 * **하나의 마크업**을 CSS 로 전환한다 — 두 벌을 만들면 한쪽만 고치는 일이 반드시 생긴다.
 *
 * 위험도는 서버가 계산한 값을 그대로 쓴다. 화면에서 빈도 x 강도를 곱하지 않는 이유는
 * 매트릭스마다 상한과 "높음" 기준이 달라(4x3 은 9 이상, 5x4 는 15 이상) 곱셈만으로는
 * 등급이 어긋나기 때문이다.
 */

function 등급클래스(level: string): string {
  if (level.includes("높")) return "is-high";
  if (level.includes("보통") || level.includes("중")) return "is-mid";
  return "is-low";
}

function 위험도표시(h: Hazard, 위치: "before" | "after") {
  const r = h[위치];
  if (!r) return <span className="risk-score is-none">-</span>;
  return (
    <span className={`risk-score ${등급클래스(r.level)}`}>
      <b>{r.score}</b>
      <em>{r.level}</em>
      <small>
        빈도 {r.frequency} · 강도 {r.severity}
      </small>
    </span>
  );
}

export default function RiskTable({
  assessment,
  수정,
  저장중,
}: {
  assessment: Assessment;
  /**
   * 행 하나를 고친다. 평가 전체를 만들어 올리지 **않는** 이유 —
   * 그러면 이 컴포넌트가 렌더 시점의 `assessment` 로 다음 값을 계산하게 되고,
   * 체크를 빠르게 두 번 누르면 두 번째가 첫 번째를 덮어써 **체크가 사라진다.**
   * 실제로 그렇게 만들었다가 잡았다. 병합은 상태를 소유한 쪽에서 해야 한다.
   *
   * 행을 배열 순서로 찾는다. 스키마에 행 번호 필드가 없기 때문이다 —
   * 있을 거라 짐작하고 `no` 로 찾다가 한 행을 고치면 전부 바뀌는 버그를 만들었다.
   */
  수정: (index: number, patch: Partial<Hazard>) => void;
  저장중: boolean;
}) {
  const 전체 = assessment.hazards.length;
  const 완료 = assessment.hazards.filter((h) => h.confirmed).length;
  const 비율 = 전체 === 0 ? 0 : Math.round((완료 / 전체) * 100);

  return (
    <section className="risk-table-wrap">
      <header className="risk-progress">
        <div>
          <span className="eyebrow">이행확인</span>
          <strong>
            {완료} / {전체}
          </strong>
          <span className="risk-progress-pct">{비율}%</span>
        </div>
        <div className="risk-progress-bar" role="progressbar" aria-valuenow={비율} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${비율}%` }} />
        </div>
        {저장중 ? <span className="risk-saving">저장 중…</span> : null}
      </header>

      <ol className="risk-rows">
        {assessment.hazards.map((h, i) => (
          <li className={`risk-row${h.confirmed ? " is-done" : ""}`} key={`${i}-${h.hazard.slice(0, 24)}`}>
            <div className="risk-row-main">
              <span className="risk-row-no">{i + 1}</span>
              <div className="risk-row-text">
                <p className="risk-row-step">
                  {h.work_type}
                  {h.unit_work ? ` · ${h.unit_work}` : ""}
                  {h.accident_type ? <em> · {h.accident_type}</em> : null}
                </p>
                <p className="risk-row-hazard">{h.hazard}</p>
              </div>
            </div>

            <div className="risk-row-scores">
              <label>
                <span>개선 전</span>
                {위험도표시(h, "before")}
              </label>
              <label>
                <span>개선 후</span>
                {위험도표시(h, "after")}
              </label>
            </div>

            <ul className="risk-controls">
              {h.controls.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>

            {h.clauses.length > 0 ? (
              <ul className="risk-clauses">
                {h.clauses.map((c) => (
                  // 조문은 생성 모델이 쓰지 않는다. 검색으로 붙인 것만 나온다 —
                  // 없는 조문을 그럴듯하게 지어내면 그게 이 화면에서 가장 위험한 오류다.
                  <li key={c.article} title={c.title}>
                    {c.label}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="risk-row-check">
              <label className="risk-check">
                <input
                  type="checkbox"
                  checked={h.confirmed}
                  onChange={(e) => 수정(i, { confirmed: e.target.checked })}
                />
                <span>이행확인</span>
              </label>
              <label className="risk-owner">
                <span className="sr-only">담당자</span>
                <input
                  type="text"
                  value={h.owner ?? ""}
                  placeholder="담당자"
                  onChange={(e) => 수정(i, { owner: e.target.value })}
                />
              </label>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
