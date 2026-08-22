import type {
  Detection,
  DetectInput,
  DetectLookup,
  DetectionRun,
  Draft,
  DraftForm,
  FactDelta,
  FactType,
  Invalidation,
  Produces,
  RuleId,
  SnapshotFact,
  TriggerRule,
  WorkItem,
  WorkItemStatus,
  WorkItemTiming,
  WorkItemTrigger,
} from "@/lib/board/types";
import { computeDeltas, factSlot, factTime, latestFacts } from "@/lib/detect/delta";

// 이 파일은 네트워크를 부르지 않는다. 감지 루프 안에서 DB 나 API 를 부르면 규칙 여덟
// 개가 서로의 지연에 묶이고, 같은 시각에 대해 실행할 때마다 다른 답이 나온다. 필요한
// 값은 호출자가 facts · deltas 로 먼저 채워 넣고 규칙은 lookup 으로만 되짚는다.

// 날짜 다루기
//
// 날짜는 KST 'YYYY-MM-DD' 문자열로만 왕복한다. Date 객체로 돌리면 UTC 로 도는 서버리스
// 함수에서 하루가 밀린다. 그래서 문자열 앞 열 글자만 떼어 UTC 자정끼리 비교한다.

const DATE_HEAD = /^(\d{4})-(\d{2})-(\d{2})/;
const DAY_MS = 86_400_000;

export function dayKey(value: string | null | undefined): string {
  const matched = DATE_HEAD.exec(String(value ?? ""));
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : "";
}

function utcMidnight(key: string): number | null {
  if (!key) return null;
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return null;
  return Date.UTC(year, month - 1, day);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function shiftDay(value: string, days: number): string {
  const base = utcMidnight(dayKey(value));
  if (base === null) return "";
  const moved = new Date(base + days * DAY_MS);
  return `${moved.getUTCFullYear()}-${pad2(moved.getUTCMonth() + 1)}-${pad2(moved.getUTCDate())}`;
}

// to 에서 from 을 뺀 날 수. 같은 날이면 0, to 가 뒤면 양수다.
export function daysBetween(from: string, to: string): number {
  const start = utcMidnight(dayKey(from));
  const end = utcMidnight(dayKey(to));
  if (start === null || end === null) return 0;
  return Math.round((end - start) / DAY_MS);
}

// 되짚기
//
// 규칙은 자기 watches 에 걸린 델타만 받지만, 판정은 거의 언제나 다른 종류의 사실을
// 함께 본다(기상 델타 + 예정공정 + 회의록 행). 그 되짚기가 lookup 이다.

export type CreateLookupInput = {
  siteId: string;
  facts: SnapshotFact[];
  deltas: FactDelta[];
  previousDetections?: Detection[];
};

export function createLookup(input: CreateLookupInput): DetectLookup {
  const scoped = input.facts.filter((fact) => fact.siteId === input.siteId);

  const newest = new Map<string, SnapshotFact>();
  for (const fact of latestFacts(scoped)) newest.set(factSlot(fact), fact);

  const byType = new Map<FactType, SnapshotFact[]>();
  for (const fact of scoped) {
    const bucket = byType.get(fact.factType);
    if (bucket) bucket.push(fact);
    else byType.set(fact.factType, [fact]);
  }

  const lastByRule = new Map<RuleId, Detection>();
  for (const detection of input.previousDetections ?? []) {
    if (detection.siteId !== input.siteId) continue;
    const held = lastByRule.get(detection.ruleId);
    if (!held || factTime(detection.detectedAt) >= factTime(held.detectedAt)) {
      lastByRule.set(detection.ruleId, detection);
    }
  }

  return {
    fact(factType, key) {
      return newest.get(`${input.siteId}::${factType}::${key}`) ?? null;
    },
    factsOf(factType) {
      return byType.get(factType) ?? [];
    },
    deltasOf(factType) {
      return input.deltas.filter((delta) => delta.factType === factType);
    },
    lastDetection(ruleId) {
      return lastByRule.get(ruleId) ?? null;
    },
    daysBetween,
  };
}

// 규칙 흘려보내기

export type RunRulesInput = {
  siteId: string;
  now: string;
  facts: SnapshotFact[];
  deltas: FactDelta[];
  rules: TriggerRule[];
  previousDetections?: Detection[];
};

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function runRules(input: RunRulesInput): Detection[] {
  const lookup = createLookup({
    siteId: input.siteId,
    facts: input.facts,
    deltas: input.deltas,
    previousDetections: input.previousDetections,
  });

  const facts = input.facts.filter((fact) => fact.siteId === input.siteId);
  const out: Detection[] = [];
  const seen = new Set<string>();

  for (const rule of input.rules) {
    const watched = new Set<FactType>(rule.watches);
    const detectInput: DetectInput = {
      siteId: input.siteId,
      now: input.now,
      // 규칙마다 자기가 지켜보는 종류의 델타만 받는다.
      deltas: input.deltas.filter((delta) => watched.has(delta.factType)),
      facts,
      lookup,
    };

    let detections: Detection[];
    try {
      detections = rule.detect(detectInput) ?? [];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${rule.id} 규칙의 감지가 실패했습니다: ${reason}`);
    }

    for (const detection of detections) {
      const normalized: Detection = {
        ...detection,
        ruleId: detection.ruleId ?? rule.id,
        siteId: detection.siteId || input.siteId,
        detectedAt: detection.detectedAt || input.now,
        confidence: clampConfidence(detection.confidence),
        evidence: detection.evidence ?? [],
        invalidates: detection.invalidates ?? [],
        produces: detection.produces ?? [],
      };
      const signature = detectionSignature(normalized);
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push(normalized);
    }
  }

  out.sort((a, b) => factTime(a.detectedAt) - factTime(b.detectedAt));
  return out;
}

// 같은 조건이 같은 서명을 내야 두 번 돌려도 카드가 두 장 생기지 않는다. 그래서 서명에는
// 실행 시각(now)이 들어가지 않고 근거의 좌표만 들어간다.
export function detectionSignature(detection: Detection): string {
  const evidence = detection.evidence
    .map((item) => `${item.factType}:${item.key}:${item.observedAt}`)
    .sort()
    .join("|");
  const invalidated = detection.invalidates
    .map((item) => `${item.docId}:${item.scope}`)
    .sort()
    .join("|");
  return `${detection.siteId}::${detection.ruleId}::${evidence}::${invalidated}`;
}

// 감지를 카드로 옮기기
//
// produces 의 항목 수만큼 카드가 생기는 것이 아니다. 하나의 감지가 여러 카드를 만들고
// 그 카드들은 같은 trigger 를 공유한다. 어느 열로 가는지는 사람이 무엇을 해야 하는지가
// 정한다 — 몸을 움직여야 하면 todo, 문서 초안이면 approval, 판단이 필요 없는 자동
// 처리면 done 이다.

const FORM_LANE: Record<DraftForm, WorkItemStatus> = {
  회의록: "approval",
  공문: "approval",
  회의자료: "approval",
  TBM자료: "approval",
  점검표: "approval",
  // 기록은 현장에서 확인하고 적는 것이라 초안을 미리 만들 수 없다.
  기록: "todo",
};

const FORM_SLUG: Record<DraftForm, string> = {
  회의록: "minutes",
  공문: "letter",
  회의자료: "agenda",
  TBM자료: "tbm",
  점검표: "checklist",
  기록: "record",
};

type DueContext = { 당일: string; 익일: string };

const FORM_DUE: Record<DraftForm, (ctx: DueContext) => string | null> = {
  // 회의록의 기한은 결재 일정이 정하므로 감지가 임의로 못 박지 않는다.
  회의록: () => null,
  공문: (ctx) => `${ctx.당일} 중 발송`,
  회의자료: (ctx) => `${ctx.당일} 회의 전`,
  TBM자료: (ctx) => `${ctx.익일}T06:40:00+09:00`,
  점검표: (ctx) => `${ctx.당일} 작업 착수 전`,
  기록: (ctx) => `${ctx.당일} 작업 착수 전`,
};

type RuleShaping = {
  timing?: WorkItemTiming;
  // 규칙 사양이 준 예상 소요. 감지 한 건 전체의 값이라 대표 카드 한 장에만 붙인다.
  estimatedMinutes?: number;
  dueBy?: (ctx: DueContext, form: DraftForm) => string | null;
};

const RULE_SHAPING = new Map<RuleId, RuleShaping>([
  ["T-01", { estimatedMinutes: 60, dueBy: (ctx) => `${ctx.당일} 작업 착수 전` }],
  ["T-02", { estimatedMinutes: 40, dueBy: (ctx) => `${ctx.익일} 작업 전 (익일 TBM 06:40 이전)` }],
  ["T-03", { estimatedMinutes: 240 }],
  ["T-04", { estimatedMinutes: 180 }],
  ["T-05", { estimatedMinutes: 210, dueBy: (ctx) => `${ctx.익일} TBM 전파 전` }],
  ["T-06", { estimatedMinutes: 90 }],
  ["T-07", { estimatedMinutes: 120 }],
  ["T-08", { estimatedMinutes: 15 }],
]);

export type CardBlueprint = {
  // 감지 안에서 고유한 이름. itemId 를 만드는 재료이고 blockedBy 를 잇는 고리다.
  key: string;
  title: string;
  status: WorkItemStatus;
  summary: string | null;
  produces: Produces[];
  invalidates: Invalidation[];
  draft: Draft | null;
  dueBy: string | null;
  estimatedMinutes: number | null;
  delegable: boolean;
  blockedByKeys: string[];
};

function produceTitle(produce: Produces): string {
  // 규칙은 카드 제목을 Produces.for 에 담는다. 없으면 서식으로 최소한의 이름을 짓는다.
  if (produce.for) return produce.for;
  switch (produce.form) {
    case "회의록":
      return produce.count ? `위험성평가 회의록 ${produce.count}행 초안` : "위험성평가 회의록 초안";
    case "공문":
      return produce.to ? `${produce.to} 앞 공문 초안` : "공문 초안";
    case "회의자료":
      return "협의체 안건 자료";
    case "TBM자료":
      return produce.teams?.length ? `TBM 자료 ${produce.teams.length}건` : "TBM 자료";
    case "점검표":
      return "작업 전 점검표";
    default:
      return "확인 기록";
  }
}

// 위험도 판정이 걸린 감지는 그 감지가 만든 카드 전부를 위임할 수 없다. 숫자를 매기는
// 책임이 안전관리자에게 있기 때문이다.
function involvesRiskJudgement(detection: Detection): boolean {
  if (detection.produces.some((produce) => produce.form === "회의록")) return true;
  const text = detection.invalidates.map((item) => `${item.scope} ${item.reason}`).join(" ");
  return /위험도|위험성평가|위험성 평가/.test(text);
}

export type PlanCardsOptions = {
  // 근거 문서를 파싱해 등록하는 단계는 사람의 판단이 필요 없어 done 으로 들어온다.
  includeAutoCards?: boolean;
  // 기한을 세는 기준 날. 감지 시각과 보드 날짜는 다르다 — 조건은 어제 저녁에 감지되고
  // 사람이 그 카드를 보는 날은 오늘이다. 기한은 사람이 손을 대는 날을 기준으로 센다.
  now?: string;
};

export function planCards(detection: Detection, options: PlanCardsOptions = {}): CardBlueprint[] {
  const base = options.now ?? detection.detectedAt;
  const 당일 = dayKey(base);
  const 익일 = shiftDay(base, 1);
  const shaping = RULE_SHAPING.get(detection.ruleId) ?? {};
  const locked = involvesRiskJudgement(detection);
  const cards: CardBlueprint[] = [];

  if (options.includeAutoCards !== false) {
    const extracted = detection.evidence.filter((item) => item.factType === "documentExtraction");
    if (extracted.length > 0) {
      const docs = [...new Set(extracted.map((item) => item.sourceDocId ?? item.key))];
      cards.push({
        key: "intake",
        title: "근거 문서 파싱과 등록",
        status: "done",
        summary: `사람의 판단이 필요 없는 단계입니다. ${docs.join(" · ")} 를 읽어 근거로 등록했습니다.`,
        produces: [],
        invalidates: [],
        draft: null,
        dueBy: null,
        estimatedMinutes: null,
        delegable: false,
        blockedByKeys: [],
      });
    }
  }

  const used = new Map<string, number>();
  const primaryIndex = cards.length;

  detection.produces.forEach((produce) => {
    const slug = FORM_SLUG[produce.form] ?? "record";
    const seq = (used.get(slug) ?? 0) + 1;
    used.set(slug, seq);

    const status = FORM_LANE[produce.form] ?? "todo";
    const dueBy =
      shaping.dueBy?.({ 당일, 익일 }, produce.form) ?? FORM_DUE[produce.form]({ 당일, 익일 });

    cards.push({
      key: seq === 1 ? slug : `${slug}${seq}`,
      title: produceTitle(produce),
      status,
      summary: detection.summary,
      produces: [produce],
      invalidates: [],
      draft: null,
      dueBy,
      estimatedMinutes: null,
      delegable: !locked,
      blockedByKeys: [],
    });
  });

  const primary = cards[primaryIndex];
  if (primary) {
    // 무효화와 예상 소요는 감지 한 건의 성질이라 대표 카드 한 장이 들고 간다.
    primary.invalidates = detection.invalidates;
    primary.estimatedMinutes = shaping.estimatedMinutes ?? null;
  }

  // TBM 자료는 회의록이 먼저 확정되어야 내용이 정해진다.
  const minutes = cards.filter((card) => card.produces.some((p) => p.form === "회의록"));
  if (minutes.length > 0) {
    for (const card of cards) {
      if (!card.produces.some((p) => p.form === "TBM자료")) continue;
      card.blockedByKeys = minutes.map((item) => item.key);
    }
  }

  return cards;
}

function hash32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(-7);
}

function ruleSlug(ruleId: RuleId): string {
  return ruleId.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type ToWorkItemsOptions = PlanCardsOptions & {
  // 카드가 만들어진 시각. 없으면 감지 시각을 쓴다.
  now?: string;
  assignee?: string | null;
  laneStart?: number;
  laneStep?: number;
  // 기본 계획 대신 직접 짠 계획을 쓸 때.
  plan?: CardBlueprint[];
};

export function toWorkItems(detection: Detection, options: ToWorkItemsOptions = {}): WorkItem[] {
  const cards = options.plan ?? planCards(detection, options);
  if (cards.length === 0) return [];

  const stamp = options.now ?? detection.detectedAt;
  const signature = hash32(detectionSignature(detection));
  const sourceDocRefs = [
    ...new Set(detection.evidence.map((item) => item.sourceDocId).filter((id): id is string => !!id)),
  ];

  const laneStart = options.laneStart ?? 1000;
  const laneStep = options.laneStep ?? 1000;
  const laneSeq = new Map<WorkItemStatus, number>();

  const idOf = (key: string) => `card_${ruleSlug(detection.ruleId)}_${key}_${signature}`;

  return cards.map((card) => {
    const seq = laneSeq.get(card.status) ?? 0;
    laneSeq.set(card.status, seq + 1);

    const trigger: WorkItemTrigger = {
      ruleId: detection.ruleId,
      condition: detection.summary,
      sourceDocRefs,
      confidence: clampConfidence(detection.confidence),
      // done 으로 바로 들어오는 카드만 사람의 확인 없이 끝난다.
      requiresHumanConfirmation: card.status !== "done",
    };

    return {
      itemId: idOf(card.key),
      siteId: detection.siteId,
      timing: RULE_SHAPING.get(detection.ruleId)?.timing ?? timingOf(detection.ruleId),
      status: card.status,
      origin: "machine",
      title: card.title,
      summary: card.summary,
      trigger,
      invalidates: card.invalidates,
      produces: card.produces,
      draft: card.draft,
      confirmedBy: null,
      confirmedAt: null,
      dueBy: card.dueBy,
      estimatedMinutes: card.estimatedMinutes,
      assignee: options.assignee ?? null,
      delegable: card.delegable,
      blockedBy: card.blockedByKeys.map(idOf),
      laneOrder: laneStart + seq * laneStep,
      createdAt: stamp,
      updatedAt: stamp,
    } satisfies WorkItem;
  });
}

function timingOf(ruleId: RuleId): WorkItemTiming {
  return ruleId.startsWith("S-") ? "schedule" : "trigger";
}

// 한 번 돌리기

export type DetectRunOptions = {
  siteId: string;
  now: string;
  facts: SnapshotFact[];
  rules: TriggerRule[];
  // 없으면 facts 에서 직접 계산한다.
  deltas?: FactDelta[];
  previousDetections?: Detection[];
  runId?: string;
  assignee?: string | null;
  includeAutoCards?: boolean;
};

function runIdOf(now: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(now);
  if (!matched) return `run_${hash32(now)}`;
  return `run_${matched[1]}${matched[2]}${matched[3]}_${matched[4]}${matched[5]}`;
}

export function runDetect(options: DetectRunOptions): DetectionRun {
  const facts = options.facts.filter((fact) => fact.siteId === options.siteId);
  const deltas = options.deltas ?? computeDeltas(facts, { siteId: options.siteId });

  const detections = runRules({
    siteId: options.siteId,
    now: options.now,
    facts,
    deltas,
    rules: options.rules,
    previousDetections: options.previousDetections,
  });

  const created: WorkItem[] = [];
  const seen = new Set<string>();
  for (const detection of detections) {
    for (const item of toWorkItems(detection, {
      now: options.now,
      assignee: options.assignee ?? null,
      includeAutoCards: options.includeAutoCards,
    })) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      created.push(item);
    }
  }

  return {
    runId: options.runId ?? runIdOf(options.now),
    siteId: options.siteId,
    startedAt: options.now,
    detections,
    created,
  };
}
