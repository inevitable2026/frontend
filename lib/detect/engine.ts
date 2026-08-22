import type {
  Detection,
  DetectionNarrative,
  DetectInput,
  DetectLookup,
  DetectionRun,
  Draft,
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
// 그 카드들은 같은 trigger 를 공유한다.
//
// **어느 카드를 몇 장 만들지, 어느 열에 놓을지, 기한을 언제로 잡을지는 이 파일이 정하지
// 않는다.** 예전에는 FORM_LANE · FORM_SLUG · FORM_DUE · RULE_SHAPING 네 개의 표가 그것을
// 정했고, 그래서 자재가 바뀌면 현장이 어디든 언제나 같은 카드 다섯 장이 같은 기한으로
// 떴다. 지금은 lib/generate/cards.ts 가 근거를 읽고 정하며, 이 파일은 그 계획을 받아
// WorkItem 으로 옮기는 일만 한다.
//
// 옮기는 과정에서 이 파일이 지키는 것은 셋뿐이고, 전부 안전과 식별자에 관한 것이다.
//   1. itemId 는 (규칙 · 카드 key · 근거 서명)으로 결정한다 — 재실행이 안전해야 한다
//   2. 위험도 판정이 걸린 카드는 위임할 수 없다 — 모델이 뭐라 하든 잠근다
//   3. done 이 아닌 카드는 사람 확인이 필요하다 — 모델이 자기 산출물을 면제하지 못한다

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

/**
 * 위험도 판정이 걸린 감지인지 본다.
 *
 * 걸려 있으면 그 감지가 만든 카드 **전부** 를 위임할 수 없다. 숫자를 매기는 책임이
 * 안전관리자에게 있기 때문이다. 모델이 계획에서 delegable 을 true 로 냈더라도 여기서
 * 잠근다 — 안전한 쪽으로만 덮으므로, 모델이 이미 false 로 낸 것을 풀어 주지는 않는다.
 *
 * produces 를 보는 자리가 모델 산출 뒤로 옮겨졌다. 예전에는 규칙이 채운 배열을 봤지만
 * 이제 그 배열도 계획에서 오므로, 판정 시점이 카드를 다 받은 뒤여야 한다.
 */
export function involvesRiskJudgement(detection: Detection, produces: Produces[]): boolean {
  if (produces.some((produce) => produce.form === "회의록")) return true;
  const text = detection.invalidates.map((item) => `${item.scope} ${item.reason}`).join(" ");
  return /위험도|위험성평가|위험성 평가/.test(text);
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

export type ToWorkItemsOptions = {
  /** 무엇을 만들지 정해 둔 계획. lib/generate/cards.ts 가 만든다 */
  plan: CardBlueprint[];
  // 카드가 만들어진 시각. 없으면 감지 시각을 쓴다.
  now?: string;
  assignee?: string | null;
  laneStart?: number;
  laneStep?: number;
};

export function toWorkItems(detection: Detection, options: ToWorkItemsOptions): WorkItem[] {
  const cards = options.plan;
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
      timing: timingOf(detection.ruleId),
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

/**
 * 감지 하나를 사람이 읽을 것과 할 것으로 옮기는 함수.
 *
 * 이 파일은 모델을 직접 부르지 않는다. 부르는 쪽을 주입받는 이유는 두 가지다. 첫째로
 * 규칙 실행과 문장 생성은 실패하는 방식이 전혀 다르다 — 규칙은 사실이 없으면 조용히
 * 판단을 유보하지만 생성은 네트워크와 사용량 제한에 걸린다. 둘째로 이 파일이
 * lib/generate 를 알게 되면 감지 로직을 모델 없이 돌려 볼 방법이 사라진다.
 *
 * null 을 돌려주면 "만들지 못했다" 는 뜻이다. 빈 계획과 구별해야 한다 — 빈 계획은
 * "할 일이 없다" 이고 그 둘은 담당자에게 전혀 다른 상황이다.
 */
export type DetectionGenerator = (detection: Detection) => Promise<{
  cards: CardBlueprint[];
  /** 이 감지가 만들어 낼 산출물 전부. 카드마다 흩어진 produces 를 모은 것이다 */
  produces: Produces[];
  /** 감지를 사람 말로 옮긴 문장. 문장 생성만 실패했으면 null 이고 카드는 그대로 산다 */
  narrative: DetectionNarrative | null;
} | null>;

export type DetectRunOptions = {
  siteId: string;
  now: string;
  facts: SnapshotFact[];
  rules: TriggerRule[];
  /** 감지를 카드와 문장으로 옮기는 쪽. 없으면 감지만 하고 카드는 만들지 않는다 */
  generate?: DetectionGenerator;
  // 없으면 facts 에서 직접 계산한다.
  deltas?: FactDelta[];
  previousDetections?: Detection[];
  runId?: string;
  assignee?: string | null;
};

function runIdOf(now: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(now);
  if (!matched) return `run_${hash32(now)}`;
  return `run_${matched[1]}${matched[2]}${matched[3]}_${matched[4]}${matched[5]}`;
}

export type DetectRunResult = DetectionRun & {
  /**
   * 카드를 만들지 못한 감지의 요약. 비어 있으면 전부 성공한 것이다.
   *
   * 실패를 감추지 않는 이유는 이 경로가 안전관리 기록을 만들기 때문이다. 조건은 감지됐는데
   * 카드가 없으면 담당자는 "할 일이 없다" 고 읽는다. 그것이 사실이 아니라면 화면이
   * 거짓말을 한 것이므로, 라우트가 그 사실을 응답에 실어 보낼 수 있어야 한다.
   */
  generationFailures: Array<{ ruleId: RuleId; summary: string; reason: string }>;
};

/**
 * 이미 카드를 만들어 둔 감지인지 본다.
 *
 * 서명이 같고 서사가 있으면 지난번에 끝까지 성공한 것이다. 서명만 같고 서사가 없으면
 * 그때 생성이 중간에 엎어진 것이므로 다시 시도한다. itemId 가 서명에서 나오므로 다시
 * 만들어도 같은 카드를 덮어쓸 뿐 두 장이 되지 않는다.
 */
function 이미만든것(previous: Detection[] | undefined): Map<string, Detection> {
  const 완료 = new Map<string, Detection>();
  for (const detection of previous ?? []) {
    if (!detection.narrative) continue;
    완료.set(detectionSignature(detection), detection);
  }
  return 완료;
}

export async function runDetect(options: DetectRunOptions): Promise<DetectRunResult> {
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

  const 완료 = 이미만든것(options.previousDetections);
  const created: WorkItem[] = [];
  const seen = new Set<string>();
  const generationFailures: DetectRunResult["generationFailures"] = [];
  const 최종: Detection[] = [];

  for (const detection of detections) {
    const 서명 = detectionSignature(detection);

    // 지난번에 끝까지 성공한 조건은 다시 만들지 않는다. 모델을 부르지 않는 것이 값을
    // 아끼려는 것만은 아니다 — 같은 조건의 문장이 볼 때마다 달라지면 담당자는 브리핑이
    // 어제와 무엇이 달라졌는지를 문장으로 읽을 수 없게 된다.
    const 지난것 = 완료.get(서명);
    if (지난것) {
      최종.push({ ...detection, produces: 지난것.produces, narrative: 지난것.narrative });
      continue;
    }

    if (!options.generate) {
      최종.push(detection);
      continue;
    }

    let 결과: Awaited<ReturnType<DetectionGenerator>>;
    try {
      결과 = await options.generate(detection);
    } catch (error) {
      결과 = null;
      generationFailures.push({
        ruleId: detection.ruleId,
        summary: detection.summary,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (!결과) {
      if (generationFailures.every((f) => f.summary !== detection.summary)) {
        generationFailures.push({
          ruleId: detection.ruleId,
          summary: detection.summary,
          reason: "생성이 아무것도 돌려주지 않았습니다.",
        });
      }
      // 카드 없이 감지만 남긴다. 다음 실행이 다시 시도한다.
      최종.push(detection);
      continue;
    }

    const 채운감지: Detection = {
      ...detection,
      produces: 결과.produces,
      narrative: 결과.narrative,
    };
    최종.push(채운감지);

    for (const item of toWorkItems(채운감지, {
      plan: 결과.cards,
      now: options.now,
      assignee: options.assignee ?? null,
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
    detections: 최종,
    created,
    generationFailures,
  };
}
