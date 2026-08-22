"use client";

import { useState } from "react";

import type { RiskRowDraft, WorkItem } from "@/lib/board/types";

/**
 * 작업장 — 대기열에서 고른 위험성평가 카드를 열어 행 단위로 보고 승인한다.
 *
 * 보드는 입구, 여기는 작업장이다. 감지·카드 생성은 보드가 하고, 여기서는 **읽고·고치고·
 * 승인**한다. 승인은 카드 전체가 아니라 **행 단위**여야 "3행만 재검토" 가 가능하다.
 *
 * 시각 언어는 보드 것을 쓴다(`board-card`·`board-draft-*`·`board-button-*`). 다만
 * 구조는 여기가 더 깊다 — 보드의 `DraftPreview` 는 `{label, value}` 평면인데 엔진의
 * `RiskRowDraft` 는 위험도·대책·조문·근거를 따로 들고 있다. 그 깊이를 평면으로 눌러
 * 담으면 정보가 사라지므로, 클래스만 빌리고 구조는 유지한다.
 *
 * 위험도는 초안이 들고 온 값을 그대로 보인다. 화면에서 빈도 x 강도를 곱하지 않는 이유는
 * 매트릭스마다 "높음" 기준이 달라(4x3 은 9 이상, 5x4 는 15 이상) 곱셈만으로는 등급이
 * 어긋나기 때문이다.
 */

function 등급클래스(level: string): string {
  if (level.includes("높") || level.toLowerCase().includes("high")) return "is-high";
  if (level.includes("중") || level.includes("보통") || level.toLowerCase().includes("mid"))
    return "is-mid";
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

/** 행의 색띠. 보드 카드가 급한 것을 색으로 말하는 것과 같은 규칙이다. */
function 행색띠(row: RiskRowDraft, 잠김: boolean): string {
  if (잠김) return "is-ok";
  const 등급 = 등급클래스(row.risk.level);
  if (등급 === "is-high") return "is-alert";
  if (등급 === "is-mid") return "is-due";
  return "is-routine";
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
  const [보류행, set보류행] = useState<Set<string>>(new Set());

  const draft = item.draft;
  const rows: RiskRowDraft[] = draft?.form === "회의록" ? draft.rows : [];

  function 행승인(rowId: string) {
    set승인된행((prev) => new Set(prev).add(rowId));
    set보류행((prev) => {
      const next = new Set(prev);
      next.delete(rowId);
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
      {item.trigger === null ? null : (
        <p className="board-card-why risk-ws-why">
          <b>{item.trigger.ruleId}</b> · {item.trigger.condition}
          {item.trigger?.requiresHumanConfirmation ? (
            <em> · 기계 판단만으로 확정할 수 없어 사람 확인이 필요합니다.</em>
          ) : null}
        </p>
      )}

      {item.invalidates.length > 0 ? (
        <ul className="risk-ws-invalidates">
          {item.invalidates.map((inv) => (
            <li key={`${inv.docId}-${inv.scope}`}>
              <b>{inv.docId}</b> {inv.scope || "전체"} — {inv.reason}
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
          {rows.map((row, i) => {
            const 잠김 = 승인된행.has(row.itemId);
            const 보류 = 보류행.has(row.itemId);

            return (
              <li
                className={`board-card risk-row ${행색띠(row, 잠김)}${보류 ? " is-held" : ""}`}
                key={row.itemId}
              >
                <div className="board-card-top">
                  <span className="board-card-kind is-doc">{row.hazardClass || "위험요인"}</span>
                  <span className="risk-row-no">{String(i + 1).padStart(2, "0")}</span>
                </div>

                <div className="board-card-title">{row.hazard}</div>
                <div className="board-card-note">{row.process}</div>

                <div className="board-draft-row">
                  <span className="board-draft-label">현재 대책</span>
                  <span className="board-draft-value">
                    {row.currentControl || "없음 — 이번에 새로 정합니다."}
                  </span>
                </div>

                <div className="risk-row-scores">
                  <label>
                    <span>개선 전</span>
                    {위험도(row.risk)}
                  </label>
                  <span className="risk-row-arrow" aria-hidden="true">
                    →
                  </span>
                  <label>
                    <span>개선 후</span>
                    {위험도(row.residualRisk)}
                  </label>
                </div>

                {row.measures.map((m) => (
                  <div className="board-draft-row" key={m.measureId}>
                    <span className="board-draft-label">대책</span>
                    <span className="board-draft-value">
                      {m.text}
                      <small>
                        {m.owner} · {m.dueDate} · {m.status}
                      </small>
                    </span>
                  </div>
                ))}

                <div className="board-card-meta">
                  {row.legalReferences.map((ref) => (
                    // `citable` 이 false 면 원문을 확인하지 못한 후보다. 인용할 수 없다는
                    // 것을 화면이 말해야 한다 — 확인 안 된 조문을 근거처럼 보이면 안 된다.
                    <span
                      key={ref.ref}
                      className={`board-tag${ref.citable ? " is-doc" : ""}${ref.citable ? "" : " risk-uncited"}`}
                      title={ref.note || (ref.citable ? "원문 확인됨" : "원문 미확인 — 인용 불가")}
                    >
                      {ref.ref}
                      {ref.citable ? null : " · 미확인"}
                    </span>
                  ))}
                  {row.derivedFrom.contextDocRefs.map((docRef) => (
                    <span className="board-tag" key={docRef}>
                      {docRef}
                    </span>
                  ))}
                </div>

                <div className="board-card-actions">
                  <button
                    type="button"
                    className="board-button-approve"
                    disabled={잠김}
                    onClick={() => 행승인(row.itemId)}
                  >
                    {잠김 ? "승인됨 · 잠김" : "이 행 승인"}
                  </button>
                  {잠김 ? null : (
                    <button
                      type="button"
                      className="board-button-reject"
                      onClick={() =>
                        set보류행((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.itemId)) next.delete(row.itemId);
                          else next.add(row.itemId);
                          return next;
                        })
                      }
                    >
                      {보류 ? "보류 해제" : "보류"}
                    </button>
                  )}
                </div>

                {잠김 && item.produces.length > 0 ? (
                  <div className="board-card-foot">
                    <span className="board-tag is-ok">
                      파생 {item.produces.map((p) => p.form).join(" · ")}
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {/* 아직 서버에 안 남는다는 것을 숨기지 않는다. 새로고침하면 사라진다. */}
      {승인된행.size > 0 ? (
        <p className="risk-ws-notice">
          승인이 아직 <b>이 화면에만</b> 남습니다. 새로고침하면 사라집니다 — 행 단위 승인을
          저장할 자리가 아직 없습니다.
        </p>
      ) : null}
    </div>
  );
}
