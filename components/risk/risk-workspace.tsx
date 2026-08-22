"use client";

import { useState } from "react";

import type { RiskRowDraft, WorkItem } from "@/lib/board/types";

/**
 * 작업장 — 대기열에서 고른 위험성평가 카드를 열어 행 단위로 보고 승인한다.
 *
 * 보드는 입구, 여기는 작업장이다. 감지·카드 생성은 보드가 하고, 여기서는 **읽고·고치고·
 * 승인**한다. 승인은 카드 전체가 아니라 **행 단위**여야 "3행만 재검토" 가 가능하다.
 *
 * 위험도는 초안이 들고 온 값을 그대로 보인다. 화면에서 빈도 x 강도를 곱하지 않는 이유는
 * 매트릭스마다 "높음" 기준이 달라(4x3 은 9 이상, 5x4 는 15 이상) 곱셈만으로는 등급이
 * 어긋나기 때문이다.
 */

function 등급클래스(level: string): string {
  if (level.includes("높") || level.toLowerCase().includes("high")) return "is-high";
  if (level.includes("중") || level.includes("보통") || level.toLowerCase().includes("mid")) return "is-mid";
  return "is-low";
}

function 위험도(r: RiskRowDraft["risk"]) {
  return (
    <span className={`risk-score ${등급클래스(r.level)}`}>
      <b>{r.score}</b>
      <em>{r.level}</em>
      <small>
        빈도 {r.likelihood} · 강도 {r.severity}
      </small>
    </span>
  );
}

export default function RiskWorkspace({
  item,
  현장이름,
  닫기,
  승인,
}: {
  item: WorkItem;
  현장이름: string;
  닫기: () => void;
  /** 행 하나를 승인한다. 승인된 행은 잠기고, 그 행을 재료로 쓰는 파생물이 만들어진다. */
  승인: (rowId: string) => void;
}) {
  const [승인된행, set승인된행] = useState<Set<string>>(new Set());

  const draft = item.draft;
  const rows: RiskRowDraft[] = draft?.form === "회의록" ? draft.rows : [];

  function 행승인(rowId: string) {
    set승인된행((prev) => {
      const next = new Set(prev);
      next.add(rowId);
      return next;
    });
    승인(rowId);
  }

  return (
    <div className="risk-workspace">
      <header className="risk-ws-head">
        <button type="button" className="risk-ws-back" onClick={닫기}>
          ← 대기열
        </button>
        <div>
          <p className="risk-ws-site">{현장이름}</p>
          <h2>{draft?.form === "회의록" ? draft.제목 : item.title}</h2>
        </div>
        <span className="risk-ws-progress">
          승인 {승인된행.size} / {rows.length}
        </span>
      </header>

      {/* 왜 이 평가가 열렸는지. 규칙이 만든 문구를 그대로 보인다. */}
      {item.trigger ? (
        <p className="risk-ws-why">
          <strong>{item.trigger.ruleId}</strong> {item.trigger.condition}
          {item.trigger.requiresHumanConfirmation ? (
            <em> · 기계 판단만으로 확정할 수 없어 사람 확인이 필요합니다.</em>
          ) : null}
        </p>
      ) : null}

      {item.invalidates.length > 0 ? (
        <ul className="risk-ws-invalidates">
          {item.invalidates.map((inv) => (
            <li key={`${inv.docId}-${inv.scope}`}>
              <b>{inv.docId}</b> {inv.scope} — {inv.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {rows.length === 0 ? (
        <p className="risk-queue-empty">
          이 카드에는 아직 평가행 초안이 없습니다. 승인하면 초안이 만들어집니다.
        </p>
      ) : (
        <ol className="risk-rows">
          {rows.map((row) => {
            const 잠김 = 승인된행.has(row.itemId);
            return (
              <li className={`risk-row${잠김 ? " is-done" : ""}`} key={row.itemId}>
                <div className="risk-row-main">
                  <span className="risk-row-no">{row.itemId.slice(-2)}</span>
                  <div className="risk-row-text">
                    <p className="risk-row-step">
                      {row.process}
                      {row.hazardClass ? <em> · {row.hazardClass}</em> : null}
                    </p>
                    <p className="risk-row-hazard">{row.hazard}</p>
                    {row.currentControl ? (
                      <p className="risk-row-current">현재 대책: {row.currentControl}</p>
                    ) : null}
                  </div>
                </div>

                <div className="risk-row-scores">
                  <label>
                    <span>개선 전</span>
                    {위험도(row.risk)}
                  </label>
                  <label>
                    <span>개선 후</span>
                    {위험도(row.residualRisk)}
                  </label>
                </div>

                <ul className="risk-controls">
                  {row.measures.map((m) => (
                    <li key={m.measureId}>
                      {m.text}
                      <small>
                        {m.owner} · {m.dueDate} · {m.status}
                      </small>
                    </li>
                  ))}
                </ul>

                {row.legalReferences.length > 0 ? (
                  <ul className="risk-clauses">
                    {row.legalReferences.map((ref) => (
                      // `citable` 이 false 면 원문을 확인하지 못한 후보다. 인용할 수 없다는
                      // 것을 화면이 말해야 한다 — 확인 안 된 조문을 근거처럼 보이면 안 된다.
                      <li
                        key={ref.ref}
                        className={ref.citable ? "" : "is-uncited"}
                        title={ref.note || (ref.citable ? "원문 확인됨" : "원문 미확인 — 인용 불가")}
                      >
                        {ref.ref}
                        {ref.citable ? null : <span aria-label="인용 불가"> · 미확인</span>}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* 근거. 지금은 문서 id 까지. 좌표 하이라이트는 파싱 좌표를 저장한 뒤에 붙는다. */}
                {row.derivedFrom.contextDocRefs.length > 0 ? (
                  <ul className="risk-evidence">
                    {row.derivedFrom.contextDocRefs.map((docRef) => (
                      <li key={docRef}>{docRef}</li>
                    ))}
                  </ul>
                ) : null}

                <div className="risk-row-check">
                  <button
                    type="button"
                    className="risk-approve"
                    disabled={잠김}
                    onClick={() => 행승인(row.itemId)}
                  >
                    {잠김 ? "승인됨 · 잠김" : "이 행 승인"}
                  </button>
                  {잠김 && item.produces.length > 0 ? (
                    <span className="risk-derives">
                      파생: {item.produces.map((p) => p.form).join(" · ")}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
