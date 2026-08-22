import type {
  Briefing,
  BriefingEntry,
  Detection,
  RuleId,
  WorkItem,
} from "@/lib/board/types";
import type { BriefingParagraphInput } from "@/lib/generate/narrative";

import { detectionSignature } from "@/lib/detect/engine";

import { 폴백문단들, 폴백항목 } from "./briefing-fallback";

// 브리핑 한 장을 조립한다. **이 파일은 문장을 짓지 않는다.**
//
// 문장은 감지 시점에 lib/generate/narrative.ts 가 쓰고 Detection.narrative 에 실려 온다.
// 여기서 하는 일은 세 가지뿐이다.
//   1. 24시간 창 안에 든 감지와 카드를 고른다
//   2. 숫자를 센다 — 조건 몇 건, 태스크 몇 건, 초안 몇 건
//   3. 어느 카드가 어느 감지에서 나왔는지 가른다
//
// 숫자를 코드가 세는 것은 타협이 아니라 설계다. 세는 일은 틀릴 수 없어야 하고, 모델에게
// 세게 하면 브리핑의 "조건 3건" 과 아래 근거 패널의 항목 수가 어긋나는 날이 온다. 그래서
// 모델에게는 이미 세어 둔 숫자를 재료로 넘기고 문장만 맡긴다.
//
// 서사가 없는 감지는 ./briefing-fallback.ts 의 틀로 채운다. 생성이 실패했거나 아직 이
// 조건을 문장으로 옮긴 적이 없다는 뜻이고, 그때도 화면은 비지 않아야 한다.

// ---------------------------------------------------------------------------
// KST 시각 — Date 객체를 밖으로 내보내지 않는다
// ---------------------------------------------------------------------------

const KST_OFFSET_MS = 9 * 3_600_000;

export function kstNowIso(): string {
  return kstIsoOf(Date.now());
}

export function kstIsoOf(epochMs: number): string {
  return new Date(epochMs + KST_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

/** ISO 시각을 KST 달력 날짜 'YYYY-MM-DD' 로 바꾼다 */
export function kstDateOf(value: string | number): string | null {
  const t = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export type KstClock = { ymd: string; 월: number; 일: number; 시: number; 분: number };

export function kstClock(epochMs: number): KstClock {
  const d = new Date(epochMs + KST_OFFSET_MS);
  return {
    ymd: d.toISOString().slice(0, 10),
    월: d.getUTCMonth() + 1,
    일: d.getUTCDate(),
    시: d.getUTCHours(),
    분: d.getUTCMinutes(),
  };
}

export function 시각말(c: KstClock): string {
  const 오전 = c.시 < 12;
  const 열두시간 = c.시 % 12 === 0 ? 12 : c.시 % 12;
  const 머리 = `${오전 ? "오전" : "오후"} ${열두시간}시`;
  return c.분 === 0 ? 머리 : `${머리} ${c.분}분`;
}

export function 날짜말(대상: KstClock, 기준: KstClock): string {
  const 차 = 일수차(대상.ymd, 기준.ymd);
  if (차 === 0) return "오늘";
  if (차 === 1) return "어제";
  if (차 === 2) return "그저께";
  if (차 === -1) return "내일";
  return `${대상.월}월 ${대상.일}일`;
}

function 일수차(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------
// 규칙 이름표
// ---------------------------------------------------------------------------

export const RULE_LABELS: Record<string, string> = {
  "T-01": "기상 변화",
  "T-02": "환류 미완",
  "T-03": "자재 변경",
  "T-04": "감리 피드백",
  "T-05": "아차사고",
  "T-06": "점검 예고",
  "T-07": "추천값 이격",
  "T-08": "신규 인원",
};

export function ruleLabel(ruleId: RuleId, overrides?: Record<string, string>): string {
  const found = overrides?.[ruleId] ?? RULE_LABELS[ruleId];
  if (found) return found;
  return ruleId.startsWith("S-") ? "주기 도래" : ruleId;
}

// ---------------------------------------------------------------------------
// 브리핑 조립
// ---------------------------------------------------------------------------

export type BriefingInput = {
  siteId: string;
  /** 브리핑을 만드는 시각. 라우트의 at 이 그대로 들어온다 */
  at: string;
  /** 거슬러 올라갈 시간. 기본 24 */
  windowHours?: number;
  /** 현장의 감지 이력. 창 밖의 것이 섞여 있어도 여기서 걸러 낸다 */
  detections: Detection[];
  /** 현장의 카드 전부 */
  items: WorkItem[];
  /**
   * 창 안에 들어온 문서 수.
   *
   * undefined 는 "세지 못했다" 이고 0 은 "한 건도 없다" 이다. 둘을 뭉뚱그리면 문서함이
   * 넘어졌을 때 화면이 확인하지 않은 것을 확인했다고 말한다.
   */
  documentCount?: number;
  labels?: Record<string, string>;
};

export function buildBriefing(input: BriefingInput): Briefing {
  const 셈 = 세기(input);

  return {
    generatedAt: kstIsoOf(셈.기준시각),
    windowHours: 셈.windowHours,
    conditionCount: 셈.conditionCount,
    createdCount: 셈.createdCount,
    draftedCount: 셈.draftedCount,
    confirmationCount: 셈.확인대기,
    // 문단은 라우트가 캐시나 모델에서 받아 덮어쓴다. 여기서는 그 둘이 다 실패했을 때를
    // 위해 틀로 채워 둔다 — 이 자리가 비어 있으면 화면이 오늘 아무 일도 없다고 말한다.
    paragraphs: 폴백문단들({
      감지: 셈.감지,
      전체: input.items,
      기준: 셈.기준,
      창: 셈.창,
      conditionCount: 셈.conditionCount,
      createdCount: 셈.createdCount,
      draftedCount: 셈.draftedCount,
      확인대기: 셈.확인대기,
      documentCount: input.documentCount,
    }),
    entries: 셈.감지.map((d) => 항목만들기(d, 셈.배분.get(d) ?? [], 셈.기준, input.labels)),
  };
}

/**
 * 감지 한 건을 근거 패널 한 칸으로 옮긴다.
 *
 * 생성된 서사가 있으면 그것을 쓴다. 없으면 틀로 채우되 **무효화 칸만은 언제나 코드가
 * 만든다.** 그 칸은 `docId — scope` 라는 좌표이고 규칙이 이미 정확히 짚어 두었으므로,
 * 모델에게 다시 쓰게 하면 문서 이름이 흔들려 담당자가 어느 문서를 열어야 할지 모르게 된다.
 */
function 항목만들기(
  d: Detection,
  소속: WorkItem[],
  기준: KstClock,
  labels?: Record<string, string>,
): BriefingEntry {
  const 무효화 = d.invalidates.map((v) => `${v.docId} — ${v.scope}`);

  if (!d.narrative) return 폴백항목(d, 소속, 기준, labels);

  return {
    ruleId: d.ruleId,
    label: ruleLabel(d.ruleId, labels),
    headline: d.narrative.headline,
    detectedAt: d.detectedAt,
    createdCount: 소속.length,
    itemIds: 소속.map((i) => i.itemId),
    관측: d.narrative.관측,
    대조: d.narrative.대조,
    판단: d.narrative.판단,
    무효화,
    만든것: d.narrative.만든것,
    불확실성: d.narrative.불확실성,
  };
}

/* ------------------------------------------------------------------ *
 * 세기
 * ------------------------------------------------------------------ */

type 셈결과 = {
  windowHours: number;
  기준시각: number;
  창시작: number;
  기준: KstClock;
  창: KstClock;
  감지: Detection[];
  새카드: WorkItem[];
  배분: Map<Detection, WorkItem[]>;
  conditionCount: number;
  createdCount: number;
  draftedCount: number;
  확인대기: number;
};

function 세기(input: BriefingInput): 셈결과 {
  const windowHours = input.windowHours ?? 24;
  const 지금 = Date.parse(input.at);
  const 기준시각 = Number.isFinite(지금) ? 지금 : Date.now();
  const 창시작 = 기준시각 - windowHours * 3_600_000;

  const 감지 = 같은조건접기(
    input.detections
      .filter((d) => {
        const t = Date.parse(d.detectedAt);
        return Number.isFinite(t) && t >= 창시작 && t <= 기준시각;
      })
      .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt)),
  );

  const 새카드 = input.items.filter((i) => {
    const t = Date.parse(i.createdAt);
    return Number.isFinite(t) && t >= 창시작 && t <= 기준시각;
  });

  return {
    windowHours,
    기준시각,
    창시작,
    기준: kstClock(기준시각),
    창: kstClock(창시작),
    감지,
    새카드,
    배분: 카드배분(감지, 새카드),
    conditionCount: 감지.length,
    createdCount: 새카드.length,
    draftedCount: 새카드.filter((i) => i.draft !== null).length,
    확인대기: 새카드.filter((i) => i.trigger?.requiresHumanConfirmation === true).length,
  };
}

/**
 * 같은 조건을 가리키는 감지를 한 건으로 접는다.
 *
 * detection_events 는 실행 기록이라 같은 조건이 여러 행으로 남을 수 있다. 생성이 엎어진
 * 감지는 카드도 문장도 없이 기록만 남고, 다음 실행이 그 조건을 다시 감지해 새 행을 쓰기
 * 때문이다(app/api/board/detect/route.ts 의 previousDetections 주석 참조).
 *
 * 브리핑은 실행 이력이 아니라 **지금 무엇이 조건인가** 를 보여 주는 자리다. 접지 않으면
 * 같은 조건이 근거 패널에 두 번 서고, 첫 문단의 "조건 3건" 이 실제 서로 다른 조건의 수와
 * 어긋난다.
 *
 * 문장이 붙은 쪽을 남긴다. 둘 다 있거나 둘 다 없으면 나중 것을 남긴다 — 같은 조건을 두 번
 * 읽었다면 나중 것이 더 최근의 사실을 본 것이다.
 */
function 같은조건접기(감지: Detection[]): Detection[] {
  const 자리 = new Map<string, Detection>();

  for (const d of 감지) {
    const 열쇠 = detectionSignature(d);
    const 있던것 = 자리.get(열쇠);
    if (!있던것) {
      자리.set(열쇠, d);
      continue;
    }
    if (있던것.narrative && !d.narrative) continue;
    자리.set(열쇠, d);
  }

  // 접고 나서 다시 세운다. Map 은 넣은 차례를 지키므로 정렬이 흐트러지지는 않지만,
  // 나중 것으로 갈아 끼운 자리가 앞에 남아 있어 감지 시각 순서가 어긋날 수 있다.
  return [...자리.values()].sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt));
}

/**
 * 어느 카드가 어느 감지에서 나왔는지 가른다.
 *
 * 같은 규칙이 한 번에 여러 건 발동한다(T-07 은 어긋난 행 수만큼 감지가 선다). 규칙 번호만
 * 보고 묶으면 세 항목이 서로 남의 카드까지 자기 것이라고 셈해 숫자가 세 배로 부푼다.
 * 카드의 trigger.condition 에 그 감지의 요약이 그대로 실려 있으므로 그것을 열쇠로 쓴다.
 *
 * 어느 감지와도 문구가 맞지 않는 카드(시드로 들어온 것 등)는 같은 규칙의 첫 감지에 붙인다.
 * 한 카드는 반드시 한 항목에만 들어간다 — 두 번 세면 브리핑 숫자를 아무도 믿지 않는다.
 */
export function 카드배분(감지: Detection[], 새카드: WorkItem[]): Map<Detection, WorkItem[]> {
  const 배분 = new Map<Detection, WorkItem[]>(감지.map((d) => [d, [] as WorkItem[]]));

  const 규칙첫감지 = new Map<RuleId, Detection>();
  for (const d of 감지) if (!규칙첫감지.has(d.ruleId)) 규칙첫감지.set(d.ruleId, d);

  for (const item of 새카드) {
    const trigger = item.trigger;
    if (!trigger) continue;
    const 조건 = trigger.condition.trim();
    const 정확 = 감지.find((d) => d.ruleId === trigger.ruleId && d.summary.trim() === 조건);
    const 주인 = 정확 ?? 규칙첫감지.get(trigger.ruleId);
    if (주인) 배분.get(주인)?.push(item);
  }

  return 배분;
}

/* ------------------------------------------------------------------ *
 * 문단 생성에 넘길 재료
 * ------------------------------------------------------------------ */

/**
 * 모델에게 넘길 재료를 만든다.
 *
 * 숫자와 날짜 표현은 전부 여기서 계산해 넣는다. 모델이 세거나 날짜를 따지게 두면 브리핑의
 * 숫자와 아래 근거 패널이 어긋나고, 그 어긋남은 담당자가 확인할 방법이 없다.
 */
export function 문단재료만들기(input: BriefingInput): BriefingParagraphInput {
  const 셈 = 세기(input);
  const 급한 = 가장급한카드(input.items);

  return {
    창표현: `${날짜말(셈.창, 셈.기준)} ${시각말(셈.창)}`,
    conditionCount: 셈.conditionCount,
    createdCount: 셈.createdCount,
    draftedCount: 셈.draftedCount,
    documentCount: input.documentCount,
    확인대기: 셈.확인대기,
    급한것: 급한
      ? { title: 급한.item.title, 기한표현: 기한말(급한.item, 셈.기준) }
      : null,
    무효문서: [...new Set(셈.감지.flatMap((d) => d.invalidates.map((v) => v.docId)))],
    조건요약: 셈.감지.map((d) => `${ruleLabel(d.ruleId, input.labels)} — ${d.summary.trim()}`),
  };
}

/**
 * 문단 캐시의 열쇠.
 *
 * **시각이 들어가지 않는다.** at 은 요청마다 달라지는데 그것을 열쇠에 넣으면 창 안의 내용이
 * 하나도 바뀌지 않아도 매번 빗나가 모델을 다시 부르게 된다. 대신 창 안 감지들의 좌표와
 * 카드 수를 넣는다 — 그 둘이 같으면 문단도 같아야 한다.
 */
const LEDE_REVISION = "v2-3line";

export function 문단캐시열쇠(input: BriefingInput): string {
  const 셈 = 세기(input);
  const 조건 = 셈.감지
    .map((d) => `${d.ruleId}:${d.detectedAt}:${d.evidence.map((e) => `${e.factType}/${e.key}`).sort().join(",")}`)
    .sort()
    .join("|");
  const 재료 = [
    // 머리글의 판 번호. 문단을 몇 줄로 쓰는지가 바뀌면 옛 열쇠로 저장해 둔 문단은 더 이상
    // 지금 규칙의 산물이 아니다. 이 값을 올리지 않으면 창 안의 내용이 그대로인 현장에서는
    // 어제 캐시된 열 줄짜리 머리글이 계속 나온다.
    LEDE_REVISION,
    input.siteId,
    셈.windowHours,
    셈.conditionCount,
    셈.createdCount,
    셈.draftedCount,
    input.documentCount ?? "?",
    조건,
  ].join("::");
  return `brief_${fnv1a(재료)}`;
}

/** 열쇠를 짧게 줄인다. 감지 좌표를 그대로 이으면 기본키에 넣기에 너무 길어진다 */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 한 자리로는 충돌이 걱정되므로 길이도 함께 실어 붙인다.
  return `${h.toString(36).padStart(7, "0")}_${text.length.toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * 기한
 * ------------------------------------------------------------------ */

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;
const LEADING_YMD = /^(\d{4}-\d{2}-\d{2})/;

/**
 * dueBy 가 항상 ISO 는 아니다. "2026-08-19 오전 중 (시각 미상)" 같은 문장이 그대로 들어온다.
 * ISO 인 것만 시각으로 다루고 나머지는 앞머리 날짜만 읽는다.
 */
export function 기한시각(dueBy: string | null): number | null {
  if (!dueBy) return null;
  const s = dueBy.trim();
  if (ISO_INSTANT.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function 기한날짜(dueBy: string | null): string | null {
  if (!dueBy) return null;
  const t = 기한시각(dueBy);
  if (t !== null) return kstDateOf(t);
  const m = LEADING_YMD.exec(dueBy.trim());
  return m ? m[1] : null;
}

export function 기한말(item: WorkItem, 기준: KstClock): string | null {
  if (!item.dueBy) return null;
  const t = 기한시각(item.dueBy);
  if (t === null) return item.dueBy.trim();
  const c = kstClock(t);
  return `${날짜말(c, 기준)} ${시각말(c)}`;
}

export function 가장급한카드(items: WorkItem[]): { item: WorkItem; at: number } | null {
  let best: { item: WorkItem; at: number } | null = null;
  for (const item of items) {
    if (item.status === "done") continue;
    const t = 기한시각(item.dueBy);
    if (t === null) continue;
    if (!best || t < best.at) best = { item, at: t };
  }
  return best;
}
