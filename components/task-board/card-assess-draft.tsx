"use client";

// 서랍 안에서 새 위험성평가 초안을 만든다 (AC-7 ~ AC-10).
//
// 서랍은 자기 완결적이다(명세 Constraints 1). 그래서 결과를 위험성평가 탭으로 넘기지 않고
// 여기서 읽기 전용으로 그린다. 엑셀 내려받기 링크도 두지 않는다 — 어느 AC 에도 없고,
// 지금 필요한 것은 서랍 안에서 결과를 확인하는 것뿐이다.
//
// `RiskTable` 을 재사용하지 않는 이유: 그 컴포넌트는 `수정`·`저장중` 을 받아
// `PATCH /api/risk/{id}` 로 저장한다(risk-assessment-panel.tsx:489-534). no-op 을 넘기면
// 고칠 수 있어 보이는데 아무 데도 안 남는 화면이 된다.

import { useMemo, useState, type JSX } from "react";

import type { SnapshotFact, WorkItem } from "@/lib/board/types";
import type { Assessment } from "@/lib/risk/types";

import { 평가초안입력 } from "./card-assess-input";
import {
  EVIDENCE_ASSESS_BUTTON,
  EVIDENCE_ASSESS_DEMO_NOTE,
  EVIDENCE_ASSESS_FAILED,
  EVIDENCE_ASSESS_RUNNING,
  EVIDENCE_ASSESS_SCOPE_NOTE,
} from "./evidence-copy";

export function CardAssessDraft({
  item,
  facts,
  siteName,
}: {
  item: WorkItem;
  facts: SnapshotFact[];
  siteName: string;
}): JSX.Element | null {
  const [만드는중, set만드는중] = useState(false);
  const [오류, set오류] = useState<string | null>(null);
  const [평가서, set평가서] = useState<Assessment | null>(null);

  const 입력 = useMemo(() => 평가초안입력(item, facts, siteName), [item, facts, siteName]);

  // AC-7. 무효화하는 문서가 없는 카드에는 이 자리가 아예 나타나지 않는다.
  if (item.invalidates.length === 0) return null;

  const 만들기 = async () => {
    set만드는중(true);
    set오류(null);
    try {
      const res = await fetch("/api/risk/assess", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(입력.본문),
      });
      const body = (await res.json().catch(() => ({}))) as { assessment?: Assessment; error?: string };
      if (!res.ok) throw new Error(body.error ?? `${EVIDENCE_ASSESS_FAILED} (${res.status})`);
      if (!body.assessment) throw new Error("서버가 평가서를 돌려주지 않았습니다.");
      // 성공했을 때만 표를 바꾼다. 실패를 표로 덮지 않는다 (AC-10).
      set평가서(body.assessment);
    } catch (e) {
      set오류(e instanceof Error ? `${EVIDENCE_ASSESS_FAILED} — ${e.message}` : EVIDENCE_ASSESS_FAILED);
    } finally {
      set만드는중(false);
    }
  };

  return (
    <div className="board-evidence-assess">
      <h4>새 평가 초안</h4>

      {/* 보낼 조건을 먼저 보인다. 사람이 어휘를 다시 고르지 않는다 (AC-8). */}
      <dl className="board-evidence-assess-cond">
        <div>
          <dt>공종</dt>
          <dd>{입력.공종.length > 0 ? 입력.공종.join(" · ") : "읽지 못했습니다"}</dd>
        </div>
        <div>
          <dt>자재</dt>
          <dd>{입력.자재.length > 0 ? 입력.자재.join(" · ") : "읽지 못했습니다"}</dd>
        </div>
        <div>
          <dt>장비</dt>
          {/* 현장 팩트 14종 어디에도 장비를 담는 필드가 없다. 빈 것을 빈 것이라고 적는다. */}
          <dd>현장 팩트에 장비를 담는 자리가 없습니다</dd>
        </div>
      </dl>

      <div className="board-evidence-assess-acts">
        <button
          type="button"
          disabled={만드는중 || !입력.보낼수있음}
          onClick={() => void 만들기()}
        >
          {만드는중 ? EVIDENCE_ASSESS_RUNNING : EVIDENCE_ASSESS_BUTTON}
        </button>
        {입력.못보내는사유 ? (
          <span className="board-evidence-assess-hint">{입력.못보내는사유}</span>
        ) : null}
      </div>

      {오류 ? (
        <p className="board-evidence-error" role="alert">
          {오류}
        </p>
      ) : null}

      {평가서 ? (
        <div className="board-evidence-assess-result">
          <p className="board-evidence-assess-demo">{EVIDENCE_ASSESS_DEMO_NOTE}</p>
          <p className="board-evidence-assess-meta">
            매트릭스 {평가서.matrix} · 평가 방법 {평가서.method} · {평가서.hazards.length}행
          </p>
          {평가서.hazards.length === 0 ? (
            <p className="board-evidence-empty">돌아온 평가표에 행이 한 줄도 없습니다.</p>
          ) : (
            <ol className="board-evidence-assess-rows">
              {평가서.hazards.map((h, i) => (
                <li key={`${i}-${h.unit_work}`}>
                  <p className="board-evidence-assess-work">
                    {h.work_type} · {h.unit_work}
                  </p>
                  <p className="board-evidence-assess-hazard">{h.hazard}</p>
                  {/* 점수와 등급은 서버가 계산한 값을 그대로 적는다. 화면에서 곱하거나
                      등급을 매기지 않는다 — 매트릭스마다 상한이 달라 어긋난다. */}
                  <span className="board-evidence-assess-score">
                    빈도 {h.before.frequency} × 강도 {h.before.severity} = {h.before.score}{" "}
                    {h.before.level}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="board-evidence-assess-scope">{EVIDENCE_ASSESS_SCOPE_NOTE}</p>
        </div>
      ) : null}
    </div>
  );
}
