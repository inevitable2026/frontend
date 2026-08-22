"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import RiskRowChat from "@/components/risk/risk-row-chat";
import type { 문서차이 } from "@/lib/risk/diff";
import type { WorkItem } from "@/lib/board/types";
import { 문서이름, 문서이름확정, 문서키툴팁, 문서표시 } from "@/lib/risk/doc-label";
import {
  미확인행,
  불일치행,
  이행확인미비뺀것,
  type 결재상태,
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

/**
 * 결재 상태 표시. **저장된 값은 그대로 두고 화면 글자만 바꾼다** —
 * `작성중` · `결재대기` · `결재완료` 는 서버·시드와 맞물린 값이다.
 */
const 결재상태표시: Record<결재상태["상태"], string> = {
  작성중: "작성 중",
  결재대기: "결재 대기",
  결재완료: "결재 완료",
};

/** `2026-09-02` → `2026년 9월 2일`. 규칙에 안 맞으면 원본을 그대로 둔다. */
function 날짜표시(값: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(값);
  if (!m) return 값;
  return `${Number(m[1])}년 ${Number(m[2])}월 ${Number(m[3])}일`;
}

/**
 * 근거 문서의 종류 이름. 문서 ID 는 화면에 적지 않고 `title` 로만 내보낸다.
 * 종류를 모르면 종류만 말한다 — 이름을 지어내지 않는다.
 */
function 근거이름(id: string): string {
  if (id.startsWith("nm_")) return "아차사고 보고";
  if (id.startsWith("notice_")) return "공문";
  if (id.startsWith("rev_")) return "외부 검토 의견";
  if (id.startsWith("tbm_")) return "TBM 기록";
  return "관련 문서";
}

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
  /**
   * 이 문서의 결재 상태. **저장된 값이다.**
   *
   * 예전에는 화면이 "결재 상신을 올릴 수 있습니다" 라고 적으면서 그 사실을 어디에도
   * 기록하지 않았다. 로컬 배열 길이만 보고 쓴 문장이었고, `제출가능` 필드를 읽는 코드가
   * 레포에 한 줄도 없었다. 이제 저장된 것을 읽어 그대로 보인다.
   */
  const [결재, set결재] = useState<결재상태 | null>(null);
  /** 재평가가 무엇을 바꿨는가. 원본과 지금을 견준 결과다. */
  const [차이, set차이] = useState<문서차이 | null>(null);
  const [오류, set오류] = useState<string | null>(null);
  const [갈래, set갈래] = useState<갈래>("직접");
  const [미확인만, set미확인만] = useState(true);
  const [저장중, set저장중] = useState<Set<string>>(new Set());
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
        if (!res.ok) {
          // 상태 코드와 서버 문구는 화면이 아니라 콘솔로 내린다.
          console.error("[위험성평가] 평가서 조회 실패", res.status, body.error);
          throw new Error("평가서를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
        }
        if (!살아있음) return;
        set행들(행정렬(body.facts ?? []));
        set오류(null);

        // 결재 상태는 따로 읽는다. 없으면 없는 대로 둔다 — 없는 것과 "작성중" 은 다르다.
        const 결재응답 = await fetch(
          `/api/board/facts?siteId=${encodeURIComponent(siteId)}&factType=documentApprovalState`,
          { cache: "no-store" },
        ).catch(() => null);
        if (!살아있음 || !결재응답?.ok) return;
        const 결재본문 = (await 결재응답.json()) as { facts?: Array<{ key: string; value: 결재상태 }> };
        set결재((결재본문.facts ?? []).find((f) => f.key === docId)?.value ?? null);

        // 차이는 실패해도 본 화면을 막지 않는다. 있으면 더 잘 보이는 것이지
        // 없으면 못 쓰는 화면이 아니다.
        const 차이응답 = await fetch(
          `/api/board/facts/diff?siteId=${encodeURIComponent(siteId)}&docId=${encodeURIComponent(docId)}`,
          { cache: "no-store" },
        ).catch(() => null);
        if (!살아있음 || !차이응답?.ok) return;
        set차이((await 차이응답.json()) as 문서차이);
      } catch (e) {
        if (!살아있음) return;
        // 빈 배열로 두지 않는다. 못 읽은 것과 한 행도 없는 것은 다른 사실이다.
        console.error("[위험성평가] 평가서 조회 실패", e);
        set오류("평가서를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
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
          console.error("[위험성평가] 평가 항목 저장 실패", key, res.status, body.error);
          throw new Error("변경한 내용을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
        }
        // 서버가 받은 뒤에 화면을 바꾼다. 반대로 하면 실패했는데 저장된 것처럼 보인다.
        set행들((prev) => (prev ?? []).map((r) => (r.행id === 행.행id ? 행 : r)));
        set오류(null);
        return true;
      } catch (e) {
        console.error("[위험성평가] 평가 항목 저장 실패", key, e);
        set오류("변경한 내용을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
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

  /**
   * 이 카드가 이미 확정됐는가. `confirmedAt` 이 잠금의 기준이다
   * (`lib/board/transition.ts:185`) — `status` 가 아니다.
   */
  const 카드확정됨 = item.confirmedAt !== null || item.status === "done";

  async function 초안반영() {
    if (!docId || 초안행.length === 0 || 반영중) return;
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
        if (!됐다) {
          console.error("[위험성평가] 평가 항목 추가 실패", 행.행id);
          throw new Error(
            "평가 항목을 문서에 추가하지 못했습니다. 이 할 일은 그대로 두었으니 잠시 뒤 다시 시도해 주세요.",
          );
        }
      }

      // 행이 전부 들어간 뒤에만 카드를 확정한다.
      //
      // **이미 확정된 카드는 건드리지 않는다.** `transition.ts:185-187` 이 확정된 카드의
      // 재확정을 409 로 막는다. 그걸 모르고 그냥 보내다가 "행은 들어갔지만 카드를
      // 확정하지 못했습니다: 이미 확정된 카드입니다" 라는, 사용자가 할 수 있는 일이
      // 아무것도 없는 오류를 띄웠다. 행은 이미 들어갔으므로 이건 실패가 아니다.
      if (카드확정됨) {
        카드끝남?.(item.itemId);
        닫기();
        return;
      }

      const res = await fetch(`/api/board/items/${encodeURIComponent(item.itemId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", confirmedBy: "user_park" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.error("[위험성평가] 할 일 확정 실패", item.itemId, res.status, body.error);
        throw new Error(
          "평가 항목은 문서에 추가했지만 이 할 일을 닫지 못했습니다. 목록에서 다시 시도해 주세요.",
        );
      }
      // 대기열에서 빼 달라고 알린다. 이게 없으면 서버는 확정했는데 화면에는 카드가
      // 그대로 남아, 사용자가 보기엔 아무 일도 안 일어난 것과 같다.
      카드끝남?.(item.itemId);
      닫기();
    } catch (e) {
      console.error("[위험성평가] 초안 반영 실패", item.itemId, e);
      set오류(
        e instanceof Error
          ? e.message
          : "평가 항목을 추가하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
      );
    } finally {
      set반영중(false);
    }
  }

  /**
   * 이행확인이 끝났다는 사실을 **결재 상태로 기록한다.**
   *
   * 이게 없으면 "결재 상신을 올릴 수 있습니다" 는 로컬 배열 길이만 보고 쓴 문장이고,
   * 시스템 어디에도 남지 않는다. 실제로 그랬다 — `제출가능` 필드를 읽는 코드가 레포에
   * 한 줄도 없었다.
   *
   * **자동으로 쓰지 않는다.** 이행확인을 모델이 대신 못 채우게 한 것과 같은 이유다 —
   * 결재 상신 가능 여부는 사람의 판단이다.
   */
  async function 결재기록() {
    if (!docId || 반영중) return;
    set반영중(true);
    try {
      // 이 서랍이 해결한 것은 이행확인뿐이다. 법적 근거·개선 후 위험도 미기재는
      // 그대로 남긴다 — 셋 다 지우면 해결하지 않은 것을 해결했다고 적는 셈이다.
      const 남은미비 = 이행확인미비뺀것(결재?.미비);
      const 다음: 결재상태 = {
        // `문서` 칸에는 **사람 이름**이 들어간다(`data/board/seed-facts.json:22`).
        // 저장소 키를 넣으면 이 칸을 읽는 모든 화면이 키를 문서 이름으로 보이게 된다.
        // 이름을 확실히 못 만들면 **키를 그대로 둔다.** 총칭("문서")을 적으면 지어낸
        // 이름이 팩트로 굳어 다음에 읽는 사람에게 사실로 보인다. 키가 남아 있으면
        // `문서이름()` 이 그걸 이름으로 치지 않고 종류를 다시 판정한다.
        ...(결재 ?? {
          문서: 문서이름확정(docId) ?? docId,
          상태: "작성중" as const,
          제출가능: false,
        }),
        상태: "결재대기",
        // 남은 미비가 있으면 아직 올릴 수 없다. 이행확인만 끝났다고 제출가능을 켜면
        // 화면이 또 없는 사실을 말하게 된다.
        제출가능: 남은미비.length === 0,
        미비: 남은미비,
      };

      const res = await fetch("/api/board/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, factType: "documentApprovalState", key: docId, value: 다음 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.error("[위험성평가] 결재 상태 저장 실패", docId, res.status, body.error);
        throw new Error("이행확인 완료를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      }
      set결재(다음);
      set오류(null);

      // 이 문서를 무효로 지목한 카드가 이 카드라면 함께 닫는다.
      if (무효문서 === docId && !카드확정됨) {
        const 확정 = await fetch(`/api/board/items/${encodeURIComponent(item.itemId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done", confirmedBy: "user_park" }),
        });
        if (!확정.ok) {
          const body = (await 확정.json().catch(() => ({}))) as { error?: string };
          // 결재 상태는 이미 기록됐다. 카드만 못 닫은 것이므로 그렇게 말한다.
          console.error("[위험성평가] 할 일 확정 실패", item.itemId, 확정.status, body.error);
          throw new Error(
            "이행확인 완료는 저장했지만 이 할 일을 닫지 못했습니다. 목록에서 다시 시도해 주세요.",
          );
        }
      }
      카드끝남?.(item.itemId);
    } catch (e) {
      console.error("[위험성평가] 결재 상태 저장 실패", docId, e);
      set오류(
        e instanceof Error
          ? e.message
          : "이행확인 완료를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
      );
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
        aria-label={`${문서이름(docId, 결재)} 편집`}
      >
        <header className="risk-drawer-head">
          <div>
            {/* 문서 이름이 제목이다. 현장과 할 일 이름은 그 위 보조줄로 내린다. */}
            <p className="risk-drawer-eyebrow">
              {현장이름}
              {docId ? <b>「{item.title}」</b> : null}
            </p>
            {/* 열 문서를 못 찾았으면 문서 이름을 지어내지 않는다. 할 일 이름만 남긴다. */}
            <h2 title={문서키툴팁(docId)}>{docId ? 문서표시(docId, 결재) : item.title}</h2>
          </div>
          <button type="button" className="risk-drawer-close" onClick={닫기} aria-label="닫기">
            ✕
          </button>
        </header>

        {item.trigger ? (
          // 규칙 이름은 관리자가 쓰는 말이 아니다. 조건 문장만 보이고 규칙은 툴팁으로.
          <p className="risk-drawer-why" title={`점검 규칙: ${item.trigger.ruleId}`}>
            {item.trigger.condition}
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
            이 할 일에 연결된 평가서가 없어 여기서는 열 수 없습니다. 목록으로 돌아가 다른 할 일을
            확인해 주세요.
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
                이행확인 <b>{행들.length - 미확인.length}</b> / {행들.length}건
              </span>
              <label className="risk-drawer-filter">
                <input type="checkbox" checked={미확인만} onChange={(e) => set미확인만(e.target.checked)} />
                아직 확인 안 한 항목만 ({미확인.length}건)
              </label>
            </div>

            {/*
              결재 상태 — **저장된 값만** 적는다.

              이 줄이 있어야 "결재 상신을 올릴 수 있습니다" 가 장식이 아니라 기록이 된다.
              결재 팩트가 없으면 없다고 말한다. 없는 것과 "작성중" 은 다르다.
            */}
            <div className="risk-drawer-approval">
              {결재 === null ? (
                <p className="risk-drawer-approval-none">
                  이 문서에는 결재 상태 기록이 없습니다.
                </p>
              ) : (
                <>
                  {/* 1. 지금 상태 */}
                  <p className="risk-drawer-approval-head">
                    <b>{결재상태표시[결재.상태]}</b>
                    <span className={결재.제출가능 ? "is-ok" : "is-block"}>
                      {결재.제출가능 ? "결재를 올릴 수 있습니다" : "아직 결재를 올릴 수 없습니다"}
                    </span>
                    {결재.상신예정 ? <em>{날짜표시(결재.상신예정)} 결재 예정</em> : null}
                  </p>
                  {/* 2. 왜 못 올리는지 */}
                  {(결재.미비 ?? []).length > 0 ? (
                    <>
                      <p className="risk-drawer-approval-none" style={{ marginTop: 9 }}>
                        아래 항목이 채워져야 결재를 올릴 수 있습니다.
                      </p>
                      <ul className="risk-drawer-approval-gaps">
                        {(결재.미비 ?? []).map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              )}

              {/* 3. 무엇을 하면 되는지 */}
              <div className="risk-drawer-approval-acts">
                {/* 바뀐 평가서를 밖으로 꺼낸다. 재평가가 필요하다는 건 평가서가
                    바뀌었다는 뜻이고, 결재 상신은 결국 문서를 올리는 일이다. */}
                {docId && (행들?.length ?? 0) > 0 ? (
                  <>
                    {/* 둘을 나란히 둔다. 「수정한 것」만 있으면 받는 사람이 무엇이
                        달라졌는지 문서를 통째로 다시 읽어야 안다. */}
                    <a
                      className="risk-drawer-download"
                      href={`/api/board/facts/export?siteId=${encodeURIComponent(siteId)}&docId=${encodeURIComponent(docId)}&version=before`}
                    >
                      기존 평가서 내려받기
                    </a>
                    <a
                      className="risk-drawer-download is-now"
                      href={`/api/board/facts/export?siteId=${encodeURIComponent(siteId)}&docId=${encodeURIComponent(docId)}`}
                    >
                      수정한 평가서 내려받기
                    </a>
                  </>
                ) : null}

                {행들 !== null && 행들.length > 0 && 미확인.length === 0 && !결재?.제출가능 ? (
                  <button type="button" onClick={() => void 결재기록()} disabled={반영중}>
                    {반영중 ? "저장하는 중…" : "이행확인 끝났다고 표시하기"}
                  </button>
                ) : null}
              </div>
            </div>

            {/* 불일치가 있으면 숫자보다 먼저 말한다. 이 화면에서 가장 무거운 사실이다. */}
            {불일치.length > 0 ? (
              <p className="risk-drawer-forged">
                <b>{불일치.length}건</b>은 완료로 표시돼 있지만 현장에서 실제로 실행된 기록이
                없습니다. 비어 있는 항목보다 먼저 확인해 주세요.
              </p>
            ) : null}

            {갈래 === "직접" && 초안행.length > 0 ? (
              <section className="risk-drawer-draft">
                <h3>
                  추가할 평가 항목 <b>{초안행.length}</b>건
                </h3>
                <p className="risk-drawer-draft-note">
                  아직 문서에 들어가지 않은 초안입니다. 아래 기존 항목과 구분해 두었습니다.
                  {무효문서 && 무효문서 !== docId ? (
                    <>
                      {" "}
                      <b title={문서키툴팁(무효문서)}>{문서표시(무효문서)}</b>의 전제가 바뀌어서 생긴
                      할 일입니다. 새 항목은{" "}
                      <b title={문서키툴팁(docId)}>{문서표시(docId, 결재)}</b>에 들어갑니다.
                    </>
                  ) : null}
                </p>
                <ol>
                  {초안행.map((r) => (
                    <li key={r.itemId}>
                      <p className="risk-drawer-work">{r.hazard}</p>
                      <p className="risk-drawer-hazard">{r.process}</p>
                      {/* 초안은 등급(level)을 스스로 들고 온다. 그건 그대로 보인다 —
                          지어낸 값이 아니라 만든 쪽이 정한 값이다. */}
                      <span className="risk-drawer-score">
                        발생 가능성 {r.risk.likelihood} × 피해 크기 {r.risk.severity} → 위험도{" "}
                        <b>{r.risk.score}</b> ({r.risk.level})
                      </span>
                    </li>
                  ))}
                </ol>

                {/* 카드를 끝낼 수 있는 유일한 자리. 이게 없으면 열어 봐도 대기열에서
                    안 없어진다. */}
                <div className="risk-drawer-draft-acts">
                  <button type="button" onClick={() => void 초안반영()} disabled={반영중 || !docId}>
                    {반영중
                      ? "추가하는 중…"
                      : `새 평가 항목 ${초안행.length}건을 ${문서표시(docId, 결재)}에 추가하고 이 할 일 닫기`}
                  </button>
                  <span>
                    새 항목의 이행확인은 비워 둡니다. 현장에서 실제로 조치한 뒤에 직접 체크해 주세요.
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
                  // "추가할 평가 항목 3건" 이 떠 있는데 여기서 "읽지 못했습니다" 라고
                  // 하면 같은 화면이 두 가지 말을 한다.
                  초안행.length > 0 ? (
                    <p className="risk-drawer-empty" title={문서키툴팁(docId)}>
                      {문서표시(docId, 결재)}에는 아직 평가 항목이 없습니다. 위 {초안행.length}건이
                      이 문서의 첫 항목이 됩니다.
                    </p>
                  ) : (
                    <p className="risk-drawer-empty">
                      이 평가서에서 평가 항목을 한 건도 읽지 못했습니다. 결재를 올릴 수 있는지는
                      여기서 판단할 수 없습니다.
                    </p>
                  )
                ) : 미확인만 ? (
                  <p className="risk-drawer-empty">
                    {행들.length}건 모두 이행확인이 끝났습니다. 결재를 올릴 수 있습니다.
                  </p>
                ) : (
                  <p className="risk-drawer-empty">조건에 맞는 평가 항목이 없습니다.</p>
                )
              ) : (
                <ol className="risk-drawer-rows">
                  {보일행.map((행, i) => (
                    <RowCard
                      key={행.행id}
                      행={행}
                      순번={i + 1}
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
  순번,
  저장중,
  저장,
}: {
  행: 평가행;
  /** 목록에 보이는 순번. 저장소의 행 식별자는 `title` 로만 내보낸다. */
  순번: number;
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
        <span className="risk-drawer-rowid" title={`평가서 항목 번호 ${행.행id}`}>
          {순번}
        </span>
        <span className="risk-drawer-class">{행.공종분류 ?? "공종 미기재"}</span>
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
                aria-label="삭제"
                onClick={() => 저장({ ...행, 대책: (행.대책 ?? []).filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="risk-drawer-nocontrol">
          대책이 아직 없습니다. 아래 「+ 대책 추가」로 적어 주세요.
        </p>
      )}

      {펼침 ? (
        <div className="risk-drawer-add">
          <input
            type="text"
            value={초안}
            placeholder="대책을 한 줄로 적어 주세요"
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
            추가
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
            {행.근거 ? <em title={`근거 문서 ${행.근거}`}> · 근거: {근거이름(행.근거)}</em> : null}
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
              이행확인 취소하기
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
          {저장중 ? <span className="risk-drawer-saving">평가 항목을 저장하는 중…</span> : null}
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
          {저장중 ? <span className="risk-drawer-saving">평가 항목을 저장하는 중…</span> : null}
        </div>
      )}
    </li>
  );
}
