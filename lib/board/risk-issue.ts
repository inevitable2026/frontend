import { MAIL_THREADS, type MailAttachment, type MailMessage } from "@/lib/context/mail-threads";
import { 최신만, type 평가행 } from "@/lib/risk/rows";

import { BOARD_SITE_ID, BOARD_SITE_SEED_ID } from "./site";
import { boardStore } from "./store";
import type { RiskRowDraft, WorkItem } from "./types";

/**
 * 태스크 보드 맨 위의 "위험성평가 이슈" 한 건을 조립한다.
 *
 * 이슈란: 기계가 올린 회의록 초안 가운데 **이미 있는 평가서로 되돌아 들어가는 것**
 * (produces.into 가 invalidates 의 문서와 같은 것)이다. 새 문서를 만드는 초안
 * (card_ra_draft_3rows 는 ra_draft_20260819 라는 새 문서로 간다)은 여기 걸리지 않는다 —
 * 그쪽은 "기존 평가서가 어떻게 바뀌는가" 라는 질문 자체가 성립하지 않기 때문이다.
 *
 * 변경 전 행은 보드 팩트(riskAssessmentRow)에서, 변경 후 행은 카드의 초안에서 온다.
 * 이 파일은 문장을 지어내지 않는다 — 머리글은 카드의 trigger.condition 과 invalidates
 * 를 그대로 옮긴다. 법령 원문과 회사 양식은 메일함 목업(lib/context/mail-threads.ts)과
 * 같은 이유로 여기 고정 데이터로 둔다: 커넥터 없이 화면이 "근거가 이렇게 보인다" 를
 * 보여야 하고, DB 에 섞으면 실제 적재분과 구분할 수 없다.
 */

/* ------------------------------------------------------------------ 근거 */

export type RiskIssueMailEvidence = {
  kind: "mail";
  refId: string;
  threadId: string;
  제목: string;
  발신자: { 이름: string; 주소: string };
  수신: string[];
  참조: string[];
  보낸시각: string;
  본문문단: string[];
  첨부: { 이름: string; 쪽수: number; 표: Array<{ 항목: string; 값: string }> } | null;
};

export type RiskIssueLawEvidence = {
  kind: "law";
  refId: string;
  법령명: string;
  /** "[시행 2026. 1. 1.] …" 줄. 원문의 머리 표기 그대로. */
  시행표기: string;
  조문제목: string;
  /** 항 단위. 번호는 "①" 같은 원문 표기이고 호는 null 로 온다. */
  조문: Array<{ 번호: string | null; 본문: string }>;
  /** 이 이슈와 맞닿는 구절. 화면이 형광으로 칠한다. 원문에 실제로 있는 문자열만 담는다. */
  강조구절: string[];
  매칭: string;
};

export type RiskIssueFormEvidence = {
  kind: "form";
  refId: string;
  서식명: string;
  서식번호: string;
  결재란: string[];
  표: Array<{ 항목: string; 값: string }>;
  주기: string;
  발행처: string;
};

export type RiskIssueEvidence =
  | RiskIssueMailEvidence
  | RiskIssueLawEvidence
  | RiskIssueFormEvidence;

/**
 * 법령 근거 — 산업안전보건기준에 관한 규칙 제38조 발췌.
 *
 * 조문 조회 커넥터가 없어 원문 발췌를 시드로 둔다. 초안 행의 legalReferences 가 이
 * refId 를 가리킨다. 원문에 없는 문장을 여기 적으면 안전 화면이 법령을 위조하는 셈이
 * 되므로, 고칠 때는 국가법령정보센터의 현행 조문과 대조한다.
 */
const LAW_38: RiskIssueLawEvidence = {
  kind: "law",
  refId: "law_38_pre_survey",
  법령명: "산업안전보건기준에 관한 규칙",
  시행표기: "[시행 2026. 1. 1.] [고용노동부령, 일부개정]",
  조문제목: "제38조(사전조사 및 작업계획서의 작성 등)",
  조문: [
    {
      번호: "①",
      본문:
        "사업주는 다음 각 호의 작업을 하는 경우 근로자의 위험을 방지하기 위하여 별표 4에 따라 해당 작업, 작업장의 지형·지반 및 지층 상태 등에 대한 사전조사를 하고 그 결과를 기록·보존하여야 하며, 조사결과를 고려하여 별표 4의 구분에 따른 사항을 포함한 작업계획서를 작성하고 그 계획에 따라 작업을 하도록 하여야 한다.",
    },
    { 번호: null, 본문: "3. 차량계 건설기계를 사용하는 작업" },
    { 번호: "②", 본문: "제1항에 따라 작성한 작업계획서의 내용을 해당 근로자에게 알려야 한다." },
  ],
  강조구절: ["사전조사를 하고 그 결과를 기록·보존", "작업계획서를 작성", "차량계 건설기계를 사용하는 작업"],
  매칭: "키워드 · 이동식크레인",
};

/** 이 평가행 문자열 인용이 위 조문을 가리킨다. 반영 시 행의 법적근거 칸에 적힌다. */
export const LAW_38_인용 = "산업안전보건기준에 관한 규칙 제38조(사전조사 및 작업계획서의 작성 등)";

/**
 * 맥락 근거 — 회사 양식. 시나리오(docs/scenario-gimpo-logistics.md)의 합성 문서다.
 * 초안 행의 derivedFrom.contextDocRefs 가 이 refId 를 가리킨다.
 */
const FORM_EQ07: RiskIssueFormEvidence = {
  kind: "form",
  refId: "form_eq07_equipment",
  서식명: "장비반입검토서",
  서식번호: "EQ-07 (Rev.4)",
  결재란: ["담당", "소장", "승인"],
  표: [
    { 항목: "공사명", 값: "김포 고촌 물류센터 신축공사" },
    { 항목: "장비명", 값: "이동식크레인 (하이드로크레인)" },
    { 항목: "규 격", 값: "50톤 (변경 전: 25톤)" },
    { 항목: "반입일", 값: "2026. 9. 2. 예정" },
    { 항목: "첨 부", 값: "■ 장비 제원표 □ 지반 지내력 검토서 □ 아웃트리거 배치도" },
  ],
  주기: "※ 40톤 이상 중량물 장비는 반입 전 지반 지내력 검토서와 아웃트리거 배치도를 첨부하여 공무팀 검토를 득할 것.",
  발행처: "한신종합건설(주) 안전보건관리규정 별지 제7호",
};

/* ------------------------------------------------------------------ 이슈 */

export type RiskIssueRowChange = {
  mode: "수정" | "신규";
  행id: string;
  /** 신규 행이면 null — "기존 평가서에 없음" 을 화면이 그대로 그린다. */
  before: 평가행 | null;
  /** 반영을 누르면 이 값이 그대로 POST /api/board/facts 로 간다. 병합은 여기서 끝낸다. */
  after: 평가행;
  /** 이 행이 기대는 근거의 refId 목록. evidence 배열의 차례가 곧 [1][2][3] 번호다. */
  refs: string[];
};

export type RiskIssue = {
  issueId: string;
  /**
   * 카드와 팩트가 실제로 붙어 있는 현장 식별자. JSON 저장소는 시드의
   * site_gimpo_gochon_01 을 치환 없이 들고 있으므로 화면이 보낸 uuid 와 다를 수 있다.
   * 반영 요청은 반드시 이 값으로 보내야 같은 저장소에 쓰인다.
   */
  siteId: string;
  cardId: string;
  detectedAt: string;
  targetDocId: string;
  headline: string;
  /** 카드가 이미 들고 있는 문장들. 여기서 새로 짓지 않는다. */
  lede: string[];
  evidence: RiskIssueEvidence[];
  rows: RiskIssueRowChange[];
};

type 회의록초안 = Extract<NonNullable<WorkItem["draft"]>, { form: "회의록" }>;

/**
 * 재생성 이슈로 읽는 카드: 승인 열의 기계 초안 가운데, 회의록 초안이 있고 그 초안이
 * 들어갈 문서가 **자기가 무효화한 문서와 같은** 것. 초안 없는 재평가 카드(temp_power)와
 * 새 문서로 가는 초안(card_ra_draft_3rows)은 걸리지 않는다.
 */
function 이슈카드인가(item: WorkItem): item is WorkItem & { draft: 회의록초안 } {
  if (item.status !== "approval" || item.origin !== "machine") return false;
  if (item.confirmedAt !== null) return false;
  if (item.draft?.form !== "회의록" || item.draft.rows.length === 0) return false;
  const 들어갈곳 = item.produces.find((p) => p.form === "회의록")?.into ?? null;
  if (!들어갈곳) return false;
  return item.invalidates.some((inv) => inv.docId === 들어갈곳);
}

/** 초안 행 하나를, 있으면 변경 전 행 위에 병합해 저장 가능한 평가행으로 만든다. */
function 초안을행으로(
  draft: RiskRowDraft,
  targetDocId: string,
  before: 평가행 | null,
  관리기간: string | undefined,
): 평가행 {
  const 법적근거 = draft.legalReferences.filter((r) => r.citable && r.ref === LAW_38.refId).length
    ? [LAW_38_인용]
    : (before?.법적근거 ?? []);

  return {
    // 변경 전 행의 담당사·이행확인담당·사고분류는 초안이 바꾸지 않으므로 지킨다.
    ...(before ?? {}),
    회의록: targetDocId,
    행id: draft.itemId,
    관리기간: before?.관리기간 ?? 관리기간,
    공종분류: before?.공종분류 ?? draft.hazardClass,
    단위작업: draft.process,
    위험요인: draft.hazard,
    대책: draft.measures.map((m) => m.text),
    법적근거,
    개선전: { 빈도: draft.risk.likelihood, 강도: draft.risk.severity, 위험도: draft.risk.score },
    개선후: {
      빈도: draft.residualRisk.likelihood,
      강도: draft.residualRisk.severity,
      위험도: draft.residualRisk.score,
    },
    // 방금 다시 쓴 행이다. 이전에 체크되어 있었어도 새 대책이 실행됐을 리 없다.
    이행확인: undefined,
    표시값: undefined,
    실제실행: undefined,
    근거: undefined,
  };
}

/** 카드의 근거 문서 참조에서 메일 근거 한 장을 찾는다. */
function 메일근거(item: WorkItem): RiskIssueMailEvidence | null {
  const 참조들 = new Set([
    ...(item.trigger?.sourceDocRefs ?? []),
    ...(item.draft?.form === "회의록"
      ? item.draft.rows.flatMap((r) => r.derivedFrom.contextDocRefs)
      : []),
  ]);

  for (const thread of MAIL_THREADS) {
    for (const message of thread.messages) {
      const 걸린첨부 = message.첨부.find((a) => 참조들.has(a.id));
      if (!참조들.has(message.id) && !걸린첨부) continue;
      return 메일근거만들기(thread.id, message, 걸린첨부 ?? message.첨부[0] ?? null);
    }
  }
  return null;
}

function 메일근거만들기(
  threadId: string,
  message: MailMessage,
  첨부: MailAttachment | null,
): RiskIssueMailEvidence {
  return {
    kind: "mail",
    refId: message.id,
    threadId,
    제목: MAIL_THREADS.find((t) => t.id === threadId)?.제목 ?? "",
    발신자: message.발신자,
    수신: message.수신,
    참조: message.참조,
    보낸시각: message.보낸시각,
    본문문단: message.본문.split("\n").filter((line) => line.trim() !== ""),
    첨부: 첨부
      ? {
          이름: 첨부.이름,
          쪽수: 첨부.쪽수,
          // 첫 쪽의 표가 제원 요약이다. 미리보기가 비어 있으면 표 없이 이름만 남는다.
          표: 첨부.미리보기[0]?.표 ?? [],
        }
      : null,
  };
}

/**
 * 이슈 한 건을 조립한다. 이슈로 읽을 카드가 없으면 null — 화면은 섹션을 그리지 않는다.
 *
 * uuid 로 못 찾으면 시드 식별자로 한 번 더 본다. JSON 저장소는 시드를 치환 없이 들고
 * 있어서(lib/board/site.ts 의 주석) 화면의 uuid 와 저장소의 식별자가 갈라져 있다.
 */
export async function loadRiskIssue(siteId: string): Promise<RiskIssue | null> {
  const store = boardStore();
  const 후보 = siteId === BOARD_SITE_ID ? [siteId, BOARD_SITE_SEED_ID] : [siteId];

  for (const sid of 후보) {
    const page = await store.listItems({ siteId: sid, status: "approval" });
    const card = page.items.find(이슈카드인가);
    if (!card) continue;

    const draft = card.draft;
    const targetDocId = card.produces.find((p) => p.form === "회의록")?.into as string;

    // 변경 전 행 — 대상 문서의 최신 상태.
    const 팩트들 = await store.listFacts(sid, "riskAssessmentRow");
    const 문서행 = 최신만(팩트들.filter((f) => f.key.startsWith(`${targetDocId}#`)));
    const 이전행 = new Map<string, 평가행>();
    for (const f of 문서행) {
      const v = f.value as 평가행;
      if (v && typeof v === "object" && typeof v.행id === "string") 이전행.set(v.행id, v);
    }
    const 관리기간 = [...이전행.values()][0]?.관리기간;

    // 근거 차례가 곧 [1][2][3] 번호다: 메일 → 법령 → 회사 양식.
    const mail = 메일근거(card);
    const evidence: RiskIssueEvidence[] = [
      ...(mail ? [mail] : []),
      LAW_38,
      FORM_EQ07,
    ];
    const refIndex = new Map(evidence.map((e) => [e.refId, e.refId]));

    const rows: RiskIssueRowChange[] = draft.rows.map((row) => {
      const before = 이전행.get(row.itemId) ?? null;
      const refs: string[] = [];
      if (mail && row.derivedFrom.contextDocRefs.some((r) => 참조가메일인가(r, mail))) {
        refs.push(mail.refId);
      }
      for (const legal of row.legalReferences) {
        if (refIndex.has(legal.ref)) refs.push(legal.ref);
      }
      for (const ref of row.derivedFrom.contextDocRefs) {
        if (ref !== mail?.refId && refIndex.has(ref)) refs.push(ref);
      }
      return {
        mode: before ? ("수정" as const) : ("신규" as const),
        행id: row.itemId,
        before,
        after: 초안을행으로(row, targetDocId, before, 관리기간),
        refs: [...new Set(refs)],
      };
    });

    return {
      issueId: `issue_${card.itemId}`,
      siteId: sid,
      cardId: card.itemId,
      detectedAt: card.createdAt,
      targetDocId,
      headline: card.title,
      lede: [
        ...(card.trigger ? [card.trigger.condition] : []),
        ...card.invalidates
          .filter((inv) => inv.docId === targetDocId)
          .map((inv) => `${inv.reason} (${inv.scope})`),
      ],
      evidence,
      rows,
    };
  }

  return null;
}

/** 초안의 문서 참조가 이 메일(본문 또는 첨부)을 가리키는지. */
function 참조가메일인가(ref: string, mail: RiskIssueMailEvidence): boolean {
  if (ref === mail.refId) return true;
  const thread = MAIL_THREADS.find((t) => t.id === mail.threadId);
  if (!thread) return false;
  return thread.messages.some((m) => m.첨부.some((a) => a.id === ref));
}
