import type { RuleId, WorkItem } from "@/lib/board/types";

import type {
  BadgeTone,
  CardTone,
  CardTrigger,
  ConditionSlug,
  InvalidatedDoc,
  ProducedItem,
  TaskCard,
  TaskKindBadge,
  TaskRationale,
  TaskTag,
} from "./types";

/**
 * 엔진의 `WorkItem` 을 화면의 `TaskCard` 로 옮긴다.
 *
 * 왜 어댑터가 필요한가 — 두 타입 체계가 서로를 모른 채 따로 자랐다.
 * `lib/board/types.ts` 는 감지 엔진의 진실이고 `components/task-board/types.ts` 는
 * 화면의 진실이다. 화면 쪽이 더 풍부하다(`tone`·`kind`·`tags`·`rationale` 은
 * **엔진에 없는 표시용 파생값**이다). 그 파생을 컴포넌트 여기저기서 하면 같은 규칙이
 * 여러 곳에 흩어지므로 **이 파일 하나로 모은다.**
 *
 * 지어내지 않는 것: 엔진이 준 값(제목·요약·조건 문구·근거)은 그대로 옮긴다.
 * 파생하는 것: 색과 배지처럼 화면에만 있는 것.
 */

/** 규칙 번호 ↔ 화면 조건 슬러그. 화면 쪽 유니온이 닫혀 있어 매핑이 필요하다. */
const 조건슬러그: Record<string, ConditionSlug> = {
  "T-01": "weatherChange",
  "T-02": "feedbackPending",
  "T-03": "materialSubstitution",
  "T-04": "supervisorFeedback",
  "T-05": "nearMiss",
  "T-06": "inspectionNotice",
  "T-07": "recommendationGap",
  "T-08": "newWorker",
};

function 슬러그(ruleId: RuleId): ConditionSlug {
  // 주기 규칙(S-*)은 전부 periodicDue 로 모은다. 화면에 그 구분이 없다.
  return 조건슬러그[ruleId] ?? "periodicDue";
}

/**
 * 카드 왼쪽 색띠.
 *
 * 순서가 곧 우선순위다 — 전제가 무너진 것이 가장 급하고, 그다음이 기한,
 * 그다음이 사람 확인 대기다. 이 순서를 바꾸면 화면이 다른 것을 급하다고 말한다.
 */
function 색띠(item: WorkItem, 기준시각: number): CardTone {
  if (item.invalidates.length > 0) return "alert";
  if (item.dueBy) {
    // ISO 가 아닌 기한(사람이 읽는 문장)은 시각을 알 수 없으므로 급함 판정에서 뺀다.
    const ms = ISO밀리초(item.dueBy);
    if (ms !== null && ms - 기준시각 <= 24 * 60 * 60 * 1000) return "due";
  }
  if (item.status === "approval") return "review";
  if (item.status === "done") return "ok";
  return item.timing === "daily" ? "routine" : "review";
}

/** 산출물 서식에 따라 배지 색을 고른다. 문서류는 doc, 나머지는 neutral. */
function 서식색(form: string): BadgeTone {
  return form === "공문" || form === "회의록" || form === "회의자료" ? "doc" : "neutral";
}

/**
 * 엔진 서식(한글 6종) → 화면 서식(영문 슬러그 5종).
 *
 * 두 체계가 따로 자라서 이름도 개수도 다르다. 「기록」에 대응하는 화면 서식이 없어
 * `fieldCheck` 로 보낸다 — **정확한 대응이 아니다.** 다만 산출물을 통째로 빼면 화면의
 * "이 카드가 무엇을 만드는가" 개수가 틀어지므로, 근사시키고 여기에 적어 둔다.
 */
const 서식슬러그: Record<string, ProducedItem["form"]> = {
  회의록: "riskAssessmentRow",
  공문: "officialLetter",
  회의자료: "meetingAgenda",
  TBM자료: "tbmMinutes",
  점검표: "fieldCheck",
  기록: "fieldCheck", // 근사. 화면에 대응 서식이 없다.
};

function 종류배지(item: WorkItem): TaskKindBadge {
  const 첫산출 = item.produces[0]?.form ?? item.draft?.form;
  if (!첫산출) return { label: "확인", tone: "neutral" };
  return { label: 첫산출, tone: 서식색(첫산출) };
}

function 태그들(item: WorkItem): TaskTag[] {
  const tags: TaskTag[] = [];

  // 산출물이 여럿이면 첫 번째는 종류배지가 가져갔으므로 나머지만 태그로.
  for (const p of item.produces.slice(1)) {
    tags.push({ label: p.form, tone: 서식색(p.form) });
  }
  if (item.invalidates.length > 0) {
    tags.push({ label: `무효 ${item.invalidates.length}`, tone: "alert" });
  }
  if (item.blockedBy.length > 0) {
    tags.push({ label: `선행 ${item.blockedBy.length}`, tone: "due" });
  }
  if (item.delegable) tags.push({ label: "위임 가능", tone: "routine" });

  return tags;
}

/**
 * 왜 이 카드가 있는지. 규칙이 만든 문구를 **그대로** 쓴다.
 * 여기서 다시 쓰면 화면과 감지 기록이 다른 말을 하게 된다.
 */
function 사유(item: WorkItem): TaskRationale | null {
  if (!item.trigger) return null;
  return { label: item.trigger.ruleId, text: item.trigger.condition };
}

function 조건(item: WorkItem): CardTrigger | null {
  if (!item.trigger) return null;
  return {
    condition: 슬러그(item.trigger.ruleId),
    sourceDocRefs: item.trigger.sourceDocRefs,
    // 엔진의 트리거에 추출값 자리가 없다. 없는 것을 지어내지 않고 비워 둔다.
    extracted: {},
    confidence: item.trigger.confidence,
    requiresHumanConfirmation: item.trigger.requiresHumanConfirmation,
  };
}

export function 무효화옮기기(item: WorkItem): InvalidatedDoc[] {
  return item.invalidates.map((inv) => ({
    docId: inv.docId,
    // 엔진은 빈 문자열로 "전체"를 표현하고 화면은 null 로 표현한다.
    scope: inv.scope || null,
    reason: inv.reason,
  }));
}

/**
 * **`dueBy` 가 항상 ISO 는 아니다.**
 *
 * `docs/board-contract.md:394-397` — 시각이 확정되지 않은 카드는
 * `"2026-08-19 오전 중 (시각 미상)"` 처럼 **사람이 읽는 문장**으로 들어온다.
 * `new Date()` 를 무조건 부르면 `Invalid Date` 가 난다. 계약이 시킨 대로
 * `/^\d{4}-\d{2}-\d{2}T/` 로 먼저 가른다.
 *
 * 실제로 이 검사를 빼고 짰다가 계약 문서를 읽고 고쳤다.
 */
const ISO시각 = /^\d{4}-\d{2}-\d{2}T/;

function ISO밀리초(dueBy: string): number | null {
  if (!ISO시각.test(dueBy)) return null;
  const ms = new Date(dueBy).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 기한 문구. 화면 오른쪽 아래에 짧게 적는다. */
function 기한표시(dueBy: string | null, 기준시각: number): { label: string | null; hot: boolean } {
  if (!dueBy) return { label: null, hot: false };

  const ms = ISO밀리초(dueBy);
  // ISO 가 아니면 문장 그대로 적는다. 파싱하려 들지 않는다.
  if (ms === null) return { label: dueBy, hot: false };

  const 남은 = ms - 기준시각;
  const 시각 = new Date(ms).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  });
  if (남은 < 0) return { label: `${시각} 지남`, hot: true };
  if (남은 <= 24 * 60 * 60 * 1000) return { label: 시각, hot: true };
  const 날짜 = new Date(ms).toLocaleDateString("ko-KR", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Seoul",
  });
  return { label: `${날짜} ${시각}`, hot: false };
}

/** 담당자 문자열 하나를 화면이 원하는 모양으로. 외부 인원 여부는 알 수 없어 false 로 둔다. */
function 담당자(assignee: string | null) {
  if (!assignee) return null;
  return { id: assignee, name: assignee, initial: assignee.slice(0, 1), external: false };
}

export function 카드로(
  item: WorkItem,
  /** 선행 카드 제목을 찾기 위한 표. 화면이 "무엇을 기다리는지" 를 이름으로 보여야 한다. */
  제목찾기: Map<string, string> = new Map(),
  기준시각 = Date.now(),
): TaskCard {
  const 기한 = 기한표시(item.dueBy, 기준시각);

  return {
    itemId: item.itemId,
    siteId: item.siteId,
    conditionId: item.trigger ? 슬러그(item.trigger.ruleId) : null,
    timing: item.timing,
    status: item.status,
    origin: item.origin,
    laneOrder: item.laneOrder,
    tone: 색띠(item, 기준시각),
    kind: 종류배지(item),
    title: item.title,
    note: item.summary,
    tags: 태그들(item),
    rationale: 사유(item),
    trigger: 조건(item),
    invalidates: 무효화옮기기(item),
    produces: item.produces.map((p) => ({
      form: 서식슬러그[p.form] ?? "fieldCheck",
      // 산출물은 승인을 거쳐야 하는 것과 그냥 할 일인 것으로 갈린다.
      // 엔진에 그 구분이 없으므로 문서류는 승인, 나머지는 todo 로 둔다.
      lane: p.form === "기록" || p.form === "점검표" ? ("todo" as const) : ("approval" as const),
      text: [p.count ? `${p.count}건` : "", p.to ?? p.for ?? p.into ?? "", (p.teams ?? []).join("·")]
        .filter(Boolean)
        .join(" · "),
      // 파생이 실제 카드로 올라가는 것은 아직 구현되지 않았다. 없는 연결을 만들지 않는다.
      cardId: null,
    })),
    // **엔진의 `Draft`(6종)와 화면의 `TaskDraft`(4종)가 다르다.**
    // 그리고 지금 엔진은 항상 `draft: null` 을 낸다(`lib/detect/engine.ts:324,352`) —
    // 이 저장소에 `Draft` 를 만드는 코드가 없다. 화면에 보이는 초안은 `fixtures.ts` 의
    // 손글씨다. 없는 것을 모양만 맞춰 넣지 않고 null 로 둔다. 생성기가 붙을 때 여기를 채운다.
    draft: null,
    blockedBy: item.blockedBy.map((id) => ({ itemId: id, title: 제목찾기.get(id) ?? id })),
    confirmedBy: item.confirmedBy,
    confirmedAt: item.confirmedAt,
    dueBy: item.dueBy,
    dueLabel: 기한.label,
    dueIsHot: 기한.hot,
    estimatedMinutes: item.estimatedMinutes,
    assignee: 담당자(item.assignee),
    delegable: item.delegable,
    // 엔진에 위임 불가 사유가 없다. 지어내지 않는다.
    delegableReason: null,
  };
}
