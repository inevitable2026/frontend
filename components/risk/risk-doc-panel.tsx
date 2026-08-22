"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import RiskRowChat from "@/components/risk/risk-row-chat";
import type { WorkItem } from "@/lib/board/types";
import {
  loadRiskRowReviewStates,
  RiskRowReviewRequestError,
  saveRiskRowReview,
} from "@/lib/risk/row-review-client";
import {
  reviewAsState,
  type RiskRowReviewCommand,
  type RiskRowReviewDecision,
  type RiskRowReviewState,
} from "@/lib/risk/row-review-types";
import {
  미확인행,
  불일치행,
  위험도표시,
  이행상태읽기,
  행정렬,
  회사표시,
  type 평가행,
  type 행팩트,
} from "@/lib/risk/rows";

/**
 * 오른쪽에서 밀려 나오는 평가서 패널.
 *
 * 예전에는 카드를 누르면 **페이지가 통째로 바뀌었다.** 대기열이 사라지니 "지금 몇 건이
 * 남았는지" 를 잃어버린 채 한 건만 보게 되고, 돌아오려면 뒤로 가기를 눌러야 했다.
 * 서랍으로 열면 목록이 그대로 남아 다음 카드로 바로 넘어갈 수 있다.
 *
 * 그리고 **행이 실제로 보인다.** 카드는 "9행"이라고 말하는데 작업장은 "초안이 없습니다"
 * 라고 답했다. 행은 처음부터 팩트로 있었고(`riskAssessmentRow`) 화면까지 이어진 길만
 * 없었다. 여기서 그 길을 잇는다.
 */

type 갈래 = "직접" | "챗봇";

export default function RiskDocPanel({
  item,
  siteId,
  현장이름,
  닫기,
  카드끝남,
}: {
  item: WorkItem;
  siteId: string;
  현장이름: string;
  닫기: () => void;
  /** 카드가 확정되어 대기열에서 빠져야 할 때. 안 부르면 눌러도 화면이 그대로다. */
  카드끝남?: (itemId: string) => void;
}) {
  const [행들, set행들] = useState<평가행[] | null>(null);
  const [오류, set오류] = useState<string | null>(null);
  const [갈래, set갈래] = useState<갈래>("직접");
  const [미확인만, set미확인만] = useState(true);
  const [저장중, set저장중] = useState<Set<string>>(new Set());
  const [검토, set검토] = useState<Map<string, RiskRowReviewState>>(new Map());
  const [검토불러오는중, set검토불러오는중] = useState(false);
  const [검토동기화됨, set검토동기화됨] = useState(false);
  const [검토저장중, set검토저장중] = useState<Set<string>>(new Set());
  const [검토오류, set검토오류] = useState<string | null>(null);
  const [검토충돌, set검토충돌] = useState<string | null>(null);
  const 재시도명령 = useRef<Map<string, RiskRowReviewCommand>>(new Map());
  const 현재카드키 = useRef(`${siteId}\u001f${item.itemId}`);
  const 서랍 = useRef<HTMLDivElement>(null);

  /**
   * 이 서랍이 열 문서.
   *
   * **`produces.into` 가 먼저다.** 초안을 든 카드는 새 행이 들어갈 문서가 따로 있고,
   * 그게 사람이 보고 싶어 하는 문서다. `invalidates[0].docId` 를 먼저 보다가
   * `card_ra_draft_3rows` 에서 틀렸다 — 그 카드는 `ra_2026_07_regular` 를 무효화하지만
   * 새 3행은 `ra_draft_20260819` 로 들어간다. 무효화 대상을 열었더니 그 문서에는
   * 행 팩트가 없어(전제 팩트 하나뿐) **0행이 떴고**, 화면이 "행을 한 건도 읽지
   * 못했습니다" 라고 말했다. 읽지 못한 게 아니라 엉뚱한 문서를 연 것이었다.
   */
  const 대상문서 =
    item.produces.find((p) => typeof p.into === "string" && p.into)?.into ??
    item.invalidates[0]?.docId ??
    item.trigger?.sourceDocRefs?.[0] ??
    null;
  const docId = 대상문서;

  /** 이 카드가 무너뜨린 문서. 대상 문서와 다르면 맥락으로 함께 적는다. */
  const 무효문서 = item.invalidates[0]?.docId ?? null;

  /**
   * 평가서 행을 읽는다.
   *
   * 효과 안에 그대로 편다. 밖으로 빼서 `void 읽기()` 로 부르면 `react-hooks` 규칙이
   * "효과 본문에서 동기적으로 setState 한다"고 본다 — 실제로는 `await` 뒤에서만
   * 바뀌지만 규칙이 그 구분을 못 하고, 규칙을 끄는 것보다 이 모양이 낫다.
   *
   * `살아있음` 이 필요한 이유: 서랍은 카드를 바꿔 가며 다시 열린다. 앞 요청이 늦게
   * 도착하면 지금 보고 있는 평가서를 앞 카드의 행으로 덮어쓴다.
   */
  useEffect(() => {
    if (!docId) return;
    let 살아있음 = true;

    (async () => {
      try {
        const res = await fetch(
          `/api/board/facts?siteId=${encodeURIComponent(siteId)}&factType=riskAssessmentRow&docId=${encodeURIComponent(docId)}`,
          { cache: "no-store" },
        );
        const body = (await res.json()) as { facts?: 행팩트[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? `${res.status}`);
        if (!살아있음) return;
        set행들(행정렬(body.facts ?? []));
        set오류(null);
      } catch (e) {
        if (!살아있음) return;
        // 빈 배열로 두지 않는다. 못 읽은 것과 한 행도 없는 것은 다른 사실이다.
        set오류(e instanceof Error ? e.message : "평가서를 읽지 못했습니다.");
        set행들(null);
      }
    })();

    return () => {
      살아있음 = false;
    };
  }, [docId, siteId]);

  // Esc 로 닫는다. 서랍은 열자마자 포커스를 받아야 키가 먹는다.
  useEffect(() => {
    서랍.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") 닫기();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [닫기]);

  const 미확인 = useMemo(() => (행들 ? 미확인행(행들) : []), [행들]);
  const 불일치 = useMemo(() => (행들 ? 불일치행(행들) : []), [행들]);

  // 불일치를 맨 위로 올린다. 비어 있는 행은 아직 안 한 일이지만, 불일치는
  // **이미 했다고 적어 놓은 거짓말**이라 먼저 봐야 한다.
  const 보일행 = useMemo(() => {
    const 바탕 = 미확인만 ? 미확인 : (행들 ?? []);
    return [...바탕].sort((a, b) => {
      const w = (r: 평가행) => (이행상태읽기(r) === "불일치" ? 0 : 1);
      return w(a) - w(b);
    });
  }, [미확인만, 미확인, 행들]);

  const 카드키 = `${siteId}\u001f${item.itemId}`;
  const 검토할초안있음 = item.draft?.form === "회의록";
  const 초안행 = useMemo(() => [...검토.values()].map((state) => state.row), [검토]);
  const 승인된행수 = useMemo(
    () => 초안행.reduce((count, row) => count + (검토.get(row.itemId)?.decision === "approved" ? 1 : 0), 0),
    [검토, 초안행],
  );
  const 보류행수 = useMemo(
    () => 초안행.reduce((count, row) => count + (검토.get(row.itemId)?.decision === "held" ? 1 : 0), 0),
    [검토, 초안행],
  );
  const 대기행수 = Math.max(0, 초안행.length - 승인된행수 - 보류행수);
  const 모두승인됨 = 검토동기화됨 && 초안행.length > 0 && 승인된행수 === 초안행.length;

  const 검토불러오기 = useCallback(async (announce = false) => {
    const requestKey = `${siteId}\u001f${item.itemId}`;
    set검토동기화됨(false);
    set검토(new Map());
    set검토저장중(new Set());
    set검토오류(null);
    set검토충돌(null);
    set검토불러오는중(true);
    try {
      const states = await loadRiskRowReviewStates(siteId, item.itemId);
      if (현재카드키.current !== requestKey) return;
      set검토(new Map(states.map((state) => [state.rowId, state])));
      set검토동기화됨(true);
      if (announce) set검토충돌("다른 화면에서 먼저 저장했습니다. 서버의 현재 상태를 다시 불러왔습니다.");
    } catch (error) {
      if (현재카드키.current !== requestKey) return;
      set검토오류(error instanceof Error ? error.message : "행 검토 상태를 불러오지 못했습니다.");
    } finally {
      if (현재카드키.current === requestKey) set검토불러오는중(false);
    }
  }, [item.itemId, siteId]);

  useEffect(() => {
    현재카드키.current = 카드키;
    재시도명령.current.clear();
    if (!검토할초안있음) return;
    void Promise.resolve().then(() => 검토불러오기());
  }, [카드키, 검토불러오기, 검토할초안있음]);

  async function 검토저장(rowId: string, decision: RiskRowReviewDecision) {
    const requestKey = 카드키;
    const state = 검토.get(rowId);
    if (!state || 검토저장중.has(rowId) || state.decision === "approved") return;

    const retained = 재시도명령.current.get(rowId);
    const command = retained && retained.decision === decision
      ? retained
      : {
          commandId: crypto.randomUUID(),
          siteId,
          workItemId: item.itemId,
          rowId,
          expectedRowFingerprint: state.rowFingerprint,
          decision,
          expectedVersion: state.version,
        };
    재시도명령.current.set(rowId, command);
    set검토저장중((previous) => new Set(previous).add(rowId));
    set검토오류(null);
    set검토충돌(null);
    try {
      const result = await saveRiskRowReview(command);
      if (현재카드키.current !== requestKey) return;
      set검토((previous) => new Map(previous).set(rowId, reviewAsState(result.review, state.row)));
      재시도명령.current.delete(rowId);
    } catch (error) {
      if (현재카드키.current !== requestKey) return;
      if (error instanceof RiskRowReviewRequestError && error.status === 409) {
        재시도명령.current.delete(rowId);
        await 검토불러오기(true);
      } else {
        set검토오류(`${error instanceof Error ? error.message : "행 검토를 저장하지 못했습니다."} 같은 버튼을 다시 누르면 같은 명령으로 재시도합니다.`);
      }
    } finally {
      if (현재카드키.current === requestKey) {
        set검토저장중((previous) => {
          const next = new Set(previous);
          next.delete(rowId);
          return next;
        });
      }
    }
  }

  /**
   * 행 하나를 저장한다. 같은 key 로 팩트를 **덧붙이면** 마지막 것이 이긴다 —
   * 덮어쓰지 않으므로 바뀐 이력이 남는다.
   */
  const 저장 = useCallback(
    async (행: 평가행): Promise<boolean> => {
      const key = `${행.회의록}#${행.행id}`;
      set저장중((p) => new Set(p).add(key));
      try {
        const res = await fetch("/api/board/facts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId, factType: "riskAssessmentRow", key, value: 행, sourceDocId: 행.회의록 }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `${res.status}`);
        }
        // 서버가 받은 뒤에 화면을 바꾼다. 반대로 하면 실패했는데 저장된 것처럼 보인다.
        set행들((prev) => (prev ?? []).map((r) => (r.행id === 행.행id ? 행 : r)));
        set오류(null);
        return true;
      } catch (e) {
        set오류(e instanceof Error ? `저장 실패: ${e.message}` : "저장에 실패했습니다.");
        // 성패를 돌려준다. 챗봇 갈래가 실패한 제안을 "적용됨"으로 굳히던 자리다.
        return false;
      } finally {
        set저장중((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        });
      }
    },
    [siteId],
  );

  /**
   * 초안 3행을 문서에 반영하고 카드를 확정한다.
   *
   * 이게 없으면 **카드를 열어도 끝낼 방법이 없다.** 초안 행이 보이기만 하고 아무
   * 동작이 없어서, 대기열에서 영영 안 없어진다. 예전 작업장에는 행 단위 승인이
   * 있었는데 서랍으로 바꾸면서 같이 사라졌다.
   *
   * 순서가 중요하다 — **행을 먼저 쓰고, 다 들어간 뒤에 카드를 확정한다.** 반대로 하면
   * 카드는 끝났다고 적혀 있는데 행은 문서에 없는 상태가 남는다.
   *
   * 새 행의 이행확인은 비워 둔다. 방금 만든 행이 현장에서 실행됐을 리 없다.
   */
  const [반영중, set반영중] = useState(false);

  async function 초안반영() {
    if (!docId || 초안행.length === 0 || 반영중 || !모두승인됨) return;
    set반영중(true);
    try {
      for (const [i, r] of 초안행.entries()) {
        const 행: 평가행 = {
          회의록: docId,
          행id: r.itemId || `NEW-${String(i + 1).padStart(2, "0")}`,
          공종분류: r.hazardClass,
          단위작업: r.process,
          위험요인: r.hazard,
          대책: r.measures.map((m) => m.text),
          개선전: { 빈도: r.risk.likelihood, 강도: r.risk.severity, 위험도: r.risk.score },
          개선후: {
            빈도: r.residualRisk.likelihood,
            강도: r.residualRisk.severity,
            위험도: r.residualRisk.score,
          },
          // 이행확인은 비운다. 방금 만든 행이다.
        };
        const 됐다 = await 저장(행);
        if (!됐다) throw new Error(`${행.행id} 를 문서에 넣지 못했습니다. 카드는 그대로 둡니다.`);
      }

      // 행이 전부 들어간 뒤에만 카드를 확정한다.
      const res = await fetch(`/api/board/items/${encodeURIComponent(item.itemId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", confirmedBy: "user_park" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(`행은 들어갔지만 카드를 확정하지 못했습니다: ${body.error ?? res.status}`);
      }
      // 대기열에서 빼 달라고 알린다. 이게 없으면 서버는 확정했는데 화면에는 카드가
      // 그대로 남아, 사용자가 보기엔 아무 일도 안 일어난 것과 같다.
      카드끝남?.(item.itemId);
      닫기();
    } catch (e) {
      set오류(e instanceof Error ? e.message : "반영하지 못했습니다.");
    } finally {
      set반영중(false);
    }
  }

  return (
    <>
      <div className="risk-drawer-scrim" onClick={닫기} aria-hidden="true" />

      <aside
        className="risk-drawer"
        ref={서랍}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${docId ?? "평가서"} 편집`}
      >
        <header className="risk-drawer-head">
          <div>
            <p className="risk-drawer-eyebrow">
              {현장이름}
              {docId ? <b>{docId}</b> : null}
            </p>
            <h2>{item.title}</h2>
          </div>
          <button type="button" className="risk-drawer-close" onClick={닫기} aria-label="닫기">
            ✕
          </button>
        </header>

        {item.trigger ? (
          <p className="risk-drawer-why">
            <b>{item.trigger.ruleId}</b> · {item.trigger.condition}
          </p>
        ) : null}

        <div className="risk-drawer-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={갈래 === "직접"}
            className={갈래 === "직접" ? "is-on" : ""}
            onClick={() => set갈래("직접")}
          >
            직접 편집
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={갈래 === "챗봇"}
            className={갈래 === "챗봇" ? "is-on" : ""}
            onClick={() => set갈래("챗봇")}
          >
            챗봇으로 편집
          </button>
        </div>

        {!docId ? (
          <p className="risk-drawer-error">
            이 카드는 어떤 평가서를 가리키는지 밝히지 않았습니다. 무효 대상도 근거 문서도
            비어 있어 열 평가서를 특정할 수 없습니다.
          </p>
        ) : null}

        {오류 ? <p className="risk-drawer-error">{오류}</p> : null}

        {docId && 행들 === null && !오류 ? (
          <p className="risk-drawer-empty">평가서를 읽는 중입니다…</p>
        ) : null}

        {행들 !== null ? (
          <>
            <div className="risk-drawer-bar">
              <span className="risk-drawer-count">
                이행확인 <b>{행들.length - 미확인.length}</b> / {행들.length}
              </span>
              <label className="risk-drawer-filter">
                <input type="checkbox" checked={미확인만} onChange={(e) => set미확인만(e.target.checked)} />
                확인 안 된 행만 ({미확인.length})
              </label>
            </div>

            {/* 불일치가 있으면 숫자보다 먼저 말한다. 이 화면에서 가장 무거운 사실이다. */}
            {불일치.length > 0 ? (
              <p className="risk-drawer-forged">
                <b>{불일치.length}행</b>은 이행확인이 표시되어 있지만 실제로는 실행되지 않은
                것으로 판정됐습니다. 비어 있는 행보다 먼저 확인해야 합니다.
              </p>
            ) : null}

            {갈래 === "직접" && 검토할초안있음 ? (
              <section className="risk-drawer-draft">
                <h3>
                  이번에 제안된 신규 행 <b>{초안행.length}</b>
                </h3>
                <p className="risk-drawer-draft-note">
                  아직 문서에 들어가지 않은 초안입니다. 아래 기존 행과 구분해 두었습니다.
                  {무효문서 && 무효문서 !== docId ? (
                    <>
                      {" "}
                      이 카드는 <b>{무효문서}</b> 의 전제가 무너져 올라왔고, 새 행은{" "}
                      <b>{docId}</b> 로 들어갑니다.
                    </>
                  ) : null}
                </p>

                {검토불러오는중 ? (
                  <p className="risk-drawer-review-notice" aria-live="polite">
                    저장된 행 검토를 불러오는 중입니다…
                  </p>
                ) : null}
                {검토오류 ? (
                  <p className="risk-drawer-review-notice is-error" role="alert">{검토오류}</p>
                ) : null}
                {검토충돌 ? (
                  <p className="risk-drawer-review-notice is-conflict" role="status">{검토충돌}</p>
                ) : null}
                <ol>
                  {초안행.map((r) => {
                    const state = 검토.get(r.itemId);
                    const approved = state?.decision === "approved";
                    const held = state?.decision === "held";
                    const saving = 검토저장중.has(r.itemId);
                    const disabled = !검토동기화됨 || !state || saving;
                    return (
                      <li
                        key={r.itemId}
                        data-row-id={r.itemId}
                        data-review-state={state?.decision ?? "loading"}
                        className={approved ? "is-approved" : held ? "is-held" : "is-pending"}
                      >
                        <div className="risk-drawer-review-head">
                          <b>{r.itemId}</b>
                          <span>{approved ? "승인됨 · 잠김" : held ? "보류됨" : "검토 대기"}</span>
                        </div>
                        <p className="risk-drawer-work">{r.hazard}</p>
                        <p className="risk-drawer-hazard">{r.process}</p>
                        <span className="risk-drawer-score">
                          빈도 {r.risk.likelihood} × 강도 {r.risk.severity} = <b>{r.risk.score}</b>{" "}
                          {r.risk.level}
                        </span>
                        <div className="risk-drawer-review-actions">
                          <button
                            type="button"
                            className="is-hold"
                            disabled={disabled || approved || held}
                            onClick={() => void 검토저장(r.itemId, "held")}
                          >
                            {saving ? "저장 중…" : held ? "보류됨" : "보류"}
                          </button>
                          <button
                            type="button"
                            className="is-approve"
                            disabled={disabled || approved}
                            onClick={() => void 검토저장(r.itemId, "approved")}
                          >
                            {saving ? "저장 중…" : approved ? "승인됨 · 잠김" : "이 행 승인"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>

                {/* 카드를 끝낼 수 있는 유일한 자리. 이게 없으면 열어 봐도 대기열에서
                    안 없어진다. */}
                <div className="risk-drawer-draft-acts">
                  <button
                    type="button"
                    onClick={() => void 초안반영()}
                    disabled={반영중 || !docId || !모두승인됨}
                  >
                    {반영중 ? "반영 중…" : `${초안행.length}행을 ${docId} 에 넣고 카드 끝내기`}
                  </button>
                  <span>
                    {!검토동기화됨
                      ? "저장된 검토 상태를 확인한 뒤 반영할 수 있습니다."
                      : 보류행수 > 0
                        ? `보류된 ${보류행수}행이 있어 반영할 수 없습니다.`
                        : 대기행수 > 0
                          ? `아직 승인하지 않은 ${대기행수}행이 있습니다.`
                          : "모든 행이 승인됐습니다. 반영해도 새 행의 이행확인은 비워 둡니다."}
                  </span>
                </div>
              </section>
            ) : null}

            {갈래 === "직접" ? (
              보일행.length === 0 ? (
                /*
                 * **행이 0건인 것과 전부 확인된 것을 가르지 않으면 거짓말이 된다.**
                 *
                 * 처음에는 필터가 켜져 있으면 무조건 "빈 행이 없습니다. 결재 상신을 올릴 수
                 * 있습니다." 라고 적었다. 그런데 평가서를 한 행도 못 읽었을 때도 `보일행` 은
                 * 0이라, **읽지 못한 평가서를 결재 가능하다고 단언**하게 된다. 이 화면에서
                 * 가장 하면 안 되는 종류의 문장이다.
                 */
                행들.length === 0 ? (
                  // 초안이 있으면 0행은 **아직 안 만든 문서**라는 뜻이다. 위에 이미
                  // "이번에 제안된 신규 행 3" 이 떠 있는데 여기서 "읽지 못했습니다" 라고
                  // 하면 같은 화면이 두 가지 말을 한다.
                  초안행.length > 0 ? (
                    <p className="risk-drawer-empty">
                      {docId} 에는 아직 행이 없습니다. 위 {초안행.length}행이 이 문서의 첫 행이
                      됩니다.
                    </p>
                  ) : (
                    <p className="risk-drawer-empty">
                      이 평가서에서 행을 한 건도 읽지 못했습니다. 결재 가능 여부는 여기서
                      판단할 수 없습니다.
                    </p>
                  )
                ) : 미확인만 ? (
                  <p className="risk-drawer-empty">
                    {행들.length}행 모두 이행확인이 끝났습니다. 결재 상신을 올릴 수 있습니다.
                  </p>
                ) : (
                  <p className="risk-drawer-empty">행이 없습니다.</p>
                )
              ) : (
                <ol className="risk-drawer-rows">
                  {보일행.map((행) => (
                    <RowCard
                      key={행.행id}
                      행={행}
                      저장중={저장중.has(`${행.회의록}#${행.행id}`)}
                      저장={저장}
                    />
                  ))}
                </ol>
              )
            ) : (
              <RiskRowChat
                행들={행들}
                docId={docId}
                현장이름={현장이름}
                저장={저장}
              />
            )}
          </>
        ) : null}
      </aside>
    </>
  );
}

/** 행 하나. 이행확인·담당사·대책을 여기서 고친다. */
function RowCard({
  행,
  저장중,
  저장,
}: {
  행: 평가행;
  저장중: boolean;
  저장: (행: 평가행) => void;
}) {
  const [펼침, set펼침] = useState(false);
  const [초안, set초안] = useState<string>("");

  // 색띠는 위험도가 아니라 **이행확인 상태**를 말한다. 이 화면의 질문이 그것이고
  // (무엇이 결재 상신을 막는가), 위험도 등급은 매트릭스를 모르면 지어낼 수 없다.
  const 상태 = 이행상태읽기(행);

  return (
    <li
      className={`risk-drawer-row ${
        상태 === "확인" ? "is-done" : 상태 === "불일치" ? "is-forged" : "is-open"
      }`}
    >
      <div className="risk-drawer-row-top">
        <span className="risk-drawer-rowid">{행.행id}</span>
        <span className="risk-drawer-class">{행.공종분류 ?? "분류 없음"}</span>
        <span className="risk-drawer-owner">{회사표시(행.담당사)}</span>
      </div>

      <p className="risk-drawer-work">{행.단위작업}</p>
      {행.위험요인 ? <p className="risk-drawer-hazard">{행.위험요인}</p> : null}

      <div className="risk-drawer-scores">
        <span className="risk-drawer-score">개선 전 {위험도표시(행.개선전)}</span>
        <span aria-hidden="true">→</span>
        <span className="risk-drawer-score">개선 후 {위험도표시(행.개선후)}</span>
        {행.사고분류 ? <span className="risk-drawer-acc">{행.사고분류}</span> : null}
      </div>

      {(행.대책 ?? []).length > 0 ? (
        <ul className="risk-drawer-controls">
          {(행.대책 ?? []).map((c, i) => (
            <li key={`${i}-${c.slice(0, 12)}`}>
              {c}
              <button
                type="button"
                aria-label="이 대책 빼기"
                onClick={() => 저장({ ...행, 대책: (행.대책 ?? []).filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="risk-drawer-nocontrol">대책이 비어 있습니다.</p>
      )}

      {펼침 ? (
        <div className="risk-drawer-add">
          <input
            type="text"
            value={초안}
            placeholder="대책을 한 줄로 적습니다"
            onChange={(e) => set초안(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && 초안.trim()) {
                저장({ ...행, 대책: [...(행.대책 ?? []), 초안.trim()] });
                set초안("");
                set펼침(false);
              }
            }}
          />
          <button
            type="button"
            disabled={!초안.trim()}
            onClick={() => {
              저장({ ...행, 대책: [...(행.대책 ?? []), 초안.trim()] });
              set초안("");
              set펼침(false);
            }}
          >
            더하기
          </button>
        </div>
      ) : (
        <button type="button" className="risk-drawer-addbtn" onClick={() => set펼침(true)}>
          + 대책 추가
        </button>
      )}

      {/*
        불일치 행은 체크박스를 주지 않는다.

        여기에 체크박스를 두면 누르는 순간 `이행확인: true` 가 되어, 근접사고 보고가
        실행되지 않았다고 증명한 대책이 **한 번 더 실행됐다고 적히게** 된다. 위조를
        찾아낸 화면이 위조를 덮는 가장 쉬운 길을 제공하는 셈이다.

        대신 무엇이 어긋났는지를 보이고, 실제로 조치한 뒤 다시 표시하도록 남긴다.
      */}
      {상태 === "불일치" ? (
        <div className="risk-drawer-forged-box">
          <p>
            평가서 표시 <b>이행함</b> · 실제 실행 <b>안 함</b>
            {행.근거 ? <em> · 근거 {행.근거}</em> : null}
          </p>
          <div className="risk-drawer-forged-acts">
            <button
              type="button"
              disabled={저장중}
              onClick={() =>
                // 표시를 지운다. "확인함"으로 덮는 것이 아니라 **빈칸으로 되돌린다** —
                // 아직 하지 않은 일이므로 그것이 사실에 맞는 상태다.
                저장({ ...행, 이행확인: undefined, 표시값: false })
              }
            >
              표시를 지우고 미이행으로 되돌리기
            </button>
            <button
              type="button"
              disabled={저장중}
              onClick={() =>
                // 실제로 조치했을 때만 누른다. 실제실행까지 함께 참으로 바꾼다.
                저장({ ...행, 이행확인: true, 표시값: true, 실제실행: true })
              }
            >
              지금 조치했고 직접 확인했습니다
            </button>
          </div>
          {저장중 ? <span className="risk-drawer-saving">저장 중…</span> : null}
        </div>
      ) : (
        <div className="risk-drawer-row-foot">
          <label className="risk-drawer-check">
            <input
              type="checkbox"
              checked={상태 === "확인"}
              disabled={저장중}
              onChange={(e) =>
                저장({ ...행, 이행확인: e.target.checked, 실제실행: e.target.checked })
              }
            />
            {/* 무엇을 확인하는 것인지 말한다. "체크"만 있으면 표시만 채우게 된다. */}
            <span>
              현장에서 <b>실제로 실행</b>된 것을 확인했습니다
            </span>
          </label>
          {저장중 ? <span className="risk-drawer-saving">저장 중…</span> : null}
        </div>
      )}
    </li>
  );
}
