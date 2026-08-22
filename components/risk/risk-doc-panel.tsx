"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import RiskRowChat from "@/components/risk/risk-row-chat";
import type { WorkItem } from "@/lib/board/types";
import { 미확인행, 위험도표시, 행정렬, 회사표시, type 평가행, type 행팩트 } from "@/lib/risk/rows";

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
}: {
  item: WorkItem;
  siteId: string;
  현장이름: string;
  닫기: () => void;
}) {
  const [행들, set행들] = useState<평가행[] | null>(null);
  const [오류, set오류] = useState<string | null>(null);
  const [갈래, set갈래] = useState<갈래>("직접");
  const [미확인만, set미확인만] = useState(true);
  const [저장중, set저장중] = useState<Set<string>>(new Set());
  const 서랍 = useRef<HTMLDivElement>(null);

  // 이 카드가 무효로 지목한 문서. 없으면 근거 문서에서 찾는다.
  const docId = item.invalidates[0]?.docId ?? item.trigger?.sourceDocRefs?.[0] ?? null;

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
  const 보일행 = 미확인만 ? 미확인 : (행들 ?? []);

  /**
   * 이 카드가 **새로 제안한** 행. 기존 문서의 행과 섞지 않는다.
   *
   * 열한 장 가운데 초안 행을 든 카드는 `card_ra_draft_3rows` 하나뿐이지만, 그 하나를
   * 안 보여 주면 그 카드는 열어도 아무것도 없는 카드가 된다.
   */
  const 초안행 = item.draft?.form === "회의록" ? item.draft.rows : [];

  /**
   * 행 하나를 저장한다. 같은 key 로 팩트를 **덧붙이면** 마지막 것이 이긴다 —
   * 덮어쓰지 않으므로 바뀐 이력이 남는다.
   */
  const 저장 = useCallback(
    async (행: 평가행) => {
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
      } catch (e) {
        set오류(e instanceof Error ? `저장 실패: ${e.message}` : "저장에 실패했습니다.");
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
                이행확인 빈 행만 ({미확인.length})
              </label>
            </div>

            {갈래 === "직접" && 초안행.length > 0 ? (
              <section className="risk-drawer-draft">
                <h3>
                  이번에 제안된 신규 행 <b>{초안행.length}</b>
                </h3>
                <p className="risk-drawer-draft-note">
                  아직 문서에 들어가지 않은 초안입니다. 아래 기존 행과 구분해 두었습니다.
                </p>
                <ol>
                  {초안행.map((r) => (
                    <li key={r.itemId}>
                      <p className="risk-drawer-work">{r.hazard}</p>
                      <p className="risk-drawer-hazard">{r.process}</p>
                      {/* 초안은 등급(level)을 스스로 들고 온다. 그건 그대로 보인다 —
                          지어낸 값이 아니라 만든 쪽이 정한 값이다. */}
                      <span className="risk-drawer-score">
                        빈도 {r.risk.likelihood} × 강도 {r.risk.severity} = <b>{r.risk.score}</b>{" "}
                        {r.risk.level}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {갈래 === "직접" ? (
              보일행.length === 0 ? (
                <p className="risk-drawer-empty">
                  {미확인만 ? "이행확인이 빈 행이 없습니다. 결재 상신을 올릴 수 있습니다." : "행이 없습니다."}
                </p>
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

  // 색띠는 위험도가 아니라 **이행확인 여부**를 말한다. 이 화면의 질문이 그것이고
  // (무엇이 결재 상신을 막는가), 위험도 등급은 매트릭스를 모르면 지어낼 수 없다.
  return (
    <li className={`risk-drawer-row ${행.이행확인 ? "is-done" : "is-open"}`}>
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

      <div className="risk-drawer-row-foot">
        <label className="risk-drawer-check">
          <input
            type="checkbox"
            checked={행.이행확인 === true}
            disabled={저장중}
            onChange={(e) => 저장({ ...행, 이행확인: e.target.checked })}
          />
          {/* 무엇을 확인하는 것인지 말한다. "체크"만 있으면 표시만 채우게 된다. */}
          <span>
            현장에서 <b>실제로 실행</b>된 것을 확인했습니다
          </span>
        </label>
        {저장중 ? <span className="risk-drawer-saving">저장 중…</span> : null}
      </div>
    </li>
  );
}
