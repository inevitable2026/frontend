import type {
  Briefing,
  BriefingEntry,
  Detection,
  Evidence,
  FactType,
  RuleId,
  WorkItem,
  WorkItemStatus,
} from "@/lib/board/types";

// 화면 맨 위 브리핑 문단을 조립한다. 언어 모델은 부르지 않는다.
// 숫자는 전부 넘겨받은 감지·카드에서 직접 세고, 문장은 틀에 끼운다.
// 지어낸 문장이 하나라도 섞이면 아래 근거 패널과 어긋나고, 그 순간 브리핑 전체가
// 읽히지 않는 글이 된다.

// ---------------------------------------------------------------------------
// 조사 — 앞 글자의 받침에 따라 고른다
// ---------------------------------------------------------------------------

// 숫자와 알파벳은 한글로 읽었을 때의 끝소리를 따른다. 종성 번호까지 적어 두는 이유는
// "으로/로"가 ㄹ 받침만 따로 가르기 때문이다 — 1(일)로 · 7(칠)로 · L(엘)로.
// 0 은 받침 없음이다.
const 숫자종성: Record<string, number> = {
  "0": 21, // 영 · ㅇ
  "1": 8, // 일 · ㄹ
  "2": 0, // 이
  "3": 16, // 삼 · ㅁ
  "4": 0, // 사
  "5": 0, // 오
  "6": 1, // 육 · ㄱ
  "7": 8, // 칠 · ㄹ
  "8": 8, // 팔 · ㄹ
  "9": 0, // 구
};
const 알파벳종성: Record<string, number> = {
  l: 8, // 엘 · ㄹ
  m: 16, // 엠 · ㅁ
  n: 4, // 엔 · ㄴ
  r: 8, // 알 · ㄹ
};

const 한글시작 = 0xac00;
const 한글끝 = 0xd7a3;

/** 조사 선택을 위해 꼬리의 괄호·따옴표·마침표를 걷어 낸 마지막 글자를 본다 */
function 끝글자(word: string): string | null {
  const 다듬은 = word.trim().replace(/[)\]}>」』》〉"'`.,·\s]+$/u, "");
  return 다듬은.length > 0 ? 다듬은.slice(-1) : null;
}

function 종성(word: string): number | null {
  const last = 끝글자(word);
  if (!last) return null;
  const code = last.charCodeAt(0);
  if (code >= 한글시작 && code <= 한글끝) return (code - 한글시작) % 28;
  if (last >= "0" && last <= "9") return 숫자종성[last] ?? 0;
  if (/[a-z]/i.test(last)) return 알파벳종성[last.toLowerCase()] ?? 0;
  return null;
}

export function 받침있음(word: string): boolean {
  const jong = 종성(word);
  // 판단할 수 없는 글자(기호·한자 등)는 받침 없는 쪽으로 둔다. "를/가/는" 이
  // 어느 쪽에 붙어도 덜 어색하기 때문이다.
  return jong !== null && jong !== 0;
}

export function 을를(word: string): string {
  return 받침있음(word) ? "을" : "를";
}

export function 이가(word: string): string {
  return 받침있음(word) ? "이" : "가";
}

export function 은는(word: string): string {
  return 받침있음(word) ? "은" : "는";
}

export function 과와(word: string): string {
  return 받침있음(word) ? "과" : "와";
}

export function 이라(word: string): string {
  return 받침있음(word) ? "이라" : "라";
}

/** ㄹ 받침은 "으로"가 아니라 "로"를 받는다 */
export function 으로로(word: string): string {
  const jong = 종성(word);
  if (jong === null || jong === 0 || jong === 8) return "로";
  return "으로";
}

/** 앞말에 조사를 붙여 돌려준다. 문장 틀 안에서 읽기 쉽도록 둔 겉옷이다 */
export function 조사(word: string, pair: "을/를" | "이/가" | "은/는" | "과/와" | "으로/로"): string {
  switch (pair) {
    case "을/를":
      return `${word}${을를(word)}`;
    case "이/가":
      return `${word}${이가(word)}`;
    case "은/는":
      return `${word}${은는(word)}`;
    case "과/와":
      return `${word}${과와(word)}`;
    case "으로/로":
      return `${word}${으로로(word)}`;
  }
}

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

type KstClock = { ymd: string; 월: number; 일: number; 시: number; 분: number };

function kstClock(epochMs: number): KstClock {
  const d = new Date(epochMs + KST_OFFSET_MS);
  return {
    ymd: d.toISOString().slice(0, 10),
    월: d.getUTCMonth() + 1,
    일: d.getUTCDate(),
    시: d.getUTCHours(),
    분: d.getUTCMinutes(),
  };
}

function 시각말(c: KstClock): string {
  const 오전 = c.시 < 12;
  const 열두시간 = c.시 % 12 === 0 ? 12 : c.시 % 12;
  const 머리 = `${오전 ? "오전" : "오후"} ${열두시간}시`;
  return c.분 === 0 ? 머리 : `${머리} ${c.분}분`;
}

function 날짜말(대상: KstClock, 기준: KstClock): string {
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
// 근거 여섯 칸 가운데 관측·대조를 가르는 기준
// 밖에서 들어온 사실은 관측, 우리가 이미 들고 있던 상태는 대조다.
// ---------------------------------------------------------------------------

const 관측계: ReadonlySet<FactType> = new Set<FactType>([
  "weatherObservation",
  "documentExtraction",
  "externalReviewComment",
  "nearMissReport",
  "officialNotice",
  "tbmMinutesFeedback",
  "attendanceRoster",
  "riskRecommendation",
]);

function 근거줄(e: Evidence, 기준: KstClock): string {
  const 본문 = e.excerpt.trim().replace(/[.。]\s*$/u, "");
  const 출처 = e.sourceDocId ?? `${e.factType} · ${e.key}`;
  const t = Date.parse(e.observedAt);
  if (!Number.isFinite(t)) return `${본문} — ${출처}`;
  const c = kstClock(t);
  return `${본문} — ${날짜말(c, 기준)} ${시각말(c)} · ${출처}`;
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
   * 창 안에 들어온 문서 수. 세지 못했으면 넘기지 않는다 — 0 을 넘기면 "한 건도 없었다"
   * 가 되어 문장이 사실과 어긋난다.
   */
  documentCount?: number;
  labels?: Record<string, string>;
};

const 상태이름: Record<WorkItemStatus, string> = {
  todo: "할 일",
  approval: "승인 대기",
  done: "완료",
};

export function buildBriefing(input: BriefingInput): Briefing {
  const windowHours = input.windowHours ?? 24;
  const 지금 = Date.parse(input.at);
  const 기준시각 = Number.isFinite(지금) ? 지금 : Date.now();
  const 창시작 = 기준시각 - windowHours * 3_600_000;

  const 기준 = kstClock(기준시각);
  const 창 = kstClock(창시작);

  const 감지 = input.detections
    .filter((d) => {
      const t = Date.parse(d.detectedAt);
      return Number.isFinite(t) && t >= 창시작 && t <= 기준시각;
    })
    .sort((a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt));

  const 새카드 = input.items.filter((i) => {
    const t = Date.parse(i.createdAt);
    return Number.isFinite(t) && t >= 창시작 && t <= 기준시각;
  });

  const conditionCount = 감지.length;
  const createdCount = 새카드.length;
  const draftedCount = 새카드.filter((i) => i.draft !== null).length;

  const 배분 = 카드배분(감지, 새카드);
  const entries = 감지.map((d) => 항목만들기(d, 배분.get(d) ?? [], 기준, input.labels));

  return {
    generatedAt: kstIsoOf(기준시각),
    windowHours,
    conditionCount,
    createdCount,
    draftedCount,
    paragraphs: 문단들({
      감지,
      배분,
      새카드,
      전체: input.items,
      기준,
      창,
      conditionCount,
      createdCount,
      draftedCount,
      documentCount: input.documentCount,
      labels: input.labels,
    }),
    entries,
  };
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
function 카드배분(감지: Detection[], 새카드: WorkItem[]): Map<Detection, WorkItem[]> {
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

// --- 문단 -------------------------------------------------------------------

type 문단재료 = {
  감지: Detection[];
  /** 어느 감지에서 어느 카드가 나왔는지. 조건을 중요한 순서로 세울 때 쓴다 */
  배분: Map<Detection, WorkItem[]>;
  새카드: WorkItem[];
  전체: WorkItem[];
  기준: KstClock;
  창: KstClock;
  conditionCount: number;
  createdCount: number;
  draftedCount: number;
  documentCount?: number;
  labels?: Record<string, string>;
};

/**
 * 감지 요약에 박혀 있는 기계 표기 시각을 사람이 읽는 말로 바꾼다.
 *
 * 규칙이 만드는 요약은 `2026-08-21T18:00:00+09:00` 같은 값을 문장 안에 그대로 넣는다.
 * 근거 패널에서는 그 정확성이 쓸모가 있지만 머리글은 훑어 읽는 자리여서, 시각 하나가
 * 스무 글자를 차지하면 정작 무슨 일인지가 묻힌다. 날짜만 있는 표기도 같이 다듬는다.
 */
const ISO_시각 = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const ISO_날짜 = /(\d{4})-(\d{2})-(\d{2})(?![\d:T-])/g;

function 시각다듬기(문장: string, 기준: KstClock): string {
  const 다듬은 = 문장.replace(ISO_시각, (전체) => {
    const t = Date.parse(전체);
    if (!Number.isFinite(t)) return 전체;
    const c = kstClock(t);
    return `${날짜말(c, 기준)} ${시각말(c)}`;
  });
  return 다듬은.replace(ISO_날짜, (전체) => {
    const t = Date.parse(`${전체}T00:00:00+09:00`);
    if (!Number.isFinite(t)) return 전체;
    // 오늘·어제에 해당하면 날짜말이 그렇게 돌려주고, 그 편이 더 짧고 분명하다.
    return 날짜말(kstClock(t), 기준);
  });
}

/**
 * 머리글에 내용을 적어 줄 조건의 최대 수.
 *
 * 전부 적으면 머리글이 아래 목록의 사본이 되고, 하나도 적지 않으면 숫자만 남아 무슨 일이
 * 있었는지 알 수 없다. 넷까지 적고 나머지는 몇 건이 더 있는지만 밝힌다.
 */
const 요약할조건수 = 4;

function 문단들(재료: 문단재료): string[] {
  const out: string[] = [];
  const 창말 = `${날짜말(재료.창, 재료.기준)} ${시각말(재료.창)} 이후`;
  // 문서 수를 세지 못한 자리에는 아무 말도 넣지 않는다. 못 센 것을 0 으로 적으면
  // "한 건도 들어오지 않았다" 가 되어 사실과 어긋난다.
  const 읽은말 =
    재료.documentCount !== undefined && 재료.documentCount > 0
      ? ` 들어온 문서 ${재료.documentCount}건을 읽어`
      : "";

  // 1. 무엇을 감지했고 무엇을 올렸나
  if (재료.conditionCount === 0 && 재료.createdCount === 0) {
    out.push(`${창말}${읽은말} 새로 감지된 조건은 없습니다. 올라온 태스크도 없습니다.`);
  } else if (재료.conditionCount === 0) {
    const n = `${재료.createdCount}건`;
    out.push(
      `${창말}${읽은말} 새로 감지된 조건은 없습니다. 다만 태스크 ${n}${은는(n)} 올라와 있습니다.`,
    );
  } else {
    const 조건 = `${재료.conditionCount}건`;
    // "할 일"은 칸반 열 이름이라 여기서는 쓰지 않는다. 열 이름과 총계가 같은 낱말이면
    // 읽는 사람이 승인 대기와 완료까지 할 일 열에 있다고 읽는다.
    const 태스크 = `${재료.createdCount}건`;
    out.push(
      `${창말}${읽은말} 조건 ${조건}${을를(조건)} 찾았고, 오늘 처리해야 할 태스크 ${태스크}${을를(태스크)} 올렸습니다.`,
    );
  }

  // 2. 초안이 붙은 것
  if (재료.createdCount > 0) {
    if (재료.draftedCount > 0) {
      const n = `${재료.draftedCount}건`;
      out.push(`이 가운데 ${n}${은는(n)} 문서 초안까지 써 두었으니 검토하고 승인해 주십시오.`);
    } else {
      out.push("초안이 붙은 것은 없습니다. 모두 사람이 직접 확인해야 하는 항목입니다.");
    }
  }

  // 3. 가장 급한 것
  const 급한 = 가장급한카드(재료.전체);
  if (급한) {
    const 기한 = 기한말(급한.item, 재료.기준);
    out.push(
      기한
        ? `가장 급한 것은 「${급한.item.title}」입니다. 기한은 ${기한}입니다.`
        : `가장 급한 것은 「${급한.item.title}」입니다.`,
    );
    if (급한.item.summary) out.push(급한.item.summary.trim());
  }

  // 4. 무엇을 감지했나 — 조건마다 그 내용을 한 줄로 적는다.
  //
  // 첫 줄의 "조건 3건" 은 몇 건인지만 말할 뿐 무슨 일이 있었는지는 말하지 않는다. 그것을
  // 알려고 아래 항목을 하나씩 펼쳐 봐야 한다면 브리핑이 있을 이유가 없다. 카드를 많이
  // 만든 조건일수록 오늘 손이 많이 가므로 그 순서로 세우고, 같으면 먼저 감지된 것을
  // 앞에 둔다.
  if (재료.conditionCount > 0) {
    const 중요한순 = [...재료.감지].sort((a, b) => {
      const 카드차 = (재료.배분.get(b)?.length ?? 0) - (재료.배분.get(a)?.length ?? 0);
      if (카드차 !== 0) return 카드차;
      return Date.parse(a.detectedAt) - Date.parse(b.detectedAt);
    });

    for (const d of 중요한순.slice(0, 요약할조건수)) {
      const 이름 = ruleLabel(d.ruleId, 재료.labels);
      const 요약 = 시각다듬기(d.summary.trim(), 재료.기준).replace(/[.。]\s*$/u, "");
      if (!요약) continue;
      const 딸린 = 재료.배분.get(d)?.length ?? 0;
      const 초안 = 재료.배분.get(d)?.filter((i) => i.draft !== null).length ?? 0;
      const 꼬리 =
        딸린 === 0
          ? ""
          : 초안 > 0
            ? ` 태스크 ${딸린}건이 여기서 나왔고 그 가운데 ${초안}건에는 초안이 붙어 있습니다.`
            : ` 태스크 ${딸린}건이 여기서 나왔습니다.`;
      out.push(`${이름} — ${요약}.${꼬리}`);
    }

    const 남은 = 재료.conditionCount - Math.min(재료.conditionCount, 요약할조건수);
    if (남은 > 0) {
      const n = `${남은}건`;
      out.push(`나머지 조건 ${n}${은는(n)} 아래 목록에 그대로 있습니다.`);
    }
  }

  // 5. 무너진 전제
  const 무효문서 = [...new Set(재료.감지.flatMap((d) => d.invalidates.map((v) => v.docId)))];
  if (무효문서.length > 0) {
    const n = `${무효문서.length}건`;
    out.push(`이 조건들이 전제를 무너뜨린 문서는 ${n}입니다 — ${무효문서.join(" · ")}.`);
  }

  // 6. 사람 확인이 걸린 것
  const 확인대기 = 재료.새카드.filter((i) => i.trigger?.requiresHumanConfirmation === true).length;
  if (확인대기 > 0) {
    const n = `${확인대기}건`;
    out.push(`${n}${은는(n)} 기계의 판단만으로 확정할 수 없어 사람 확인을 기다립니다.`);
  }

  return out;
}

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

function 기한말(item: WorkItem, 기준: KstClock): string | null {
  if (!item.dueBy) return null;
  const t = 기한시각(item.dueBy);
  if (t === null) return item.dueBy.trim();
  const c = kstClock(t);
  return `${날짜말(c, 기준)} ${시각말(c)}`;
}

function 가장급한카드(items: WorkItem[]): { item: WorkItem; at: number } | null {
  let best: { item: WorkItem; at: number } | null = null;
  for (const item of items) {
    if (item.status === "done") continue;
    const t = 기한시각(item.dueBy);
    if (t === null) continue;
    if (!best || t < best.at) best = { item, at: t };
  }
  return best;
}

// --- 근거 패널 한 건 --------------------------------------------------------

function 항목만들기(
  d: Detection,
  소속: WorkItem[],
  기준: KstClock,
  labels?: Record<string, string>,
): BriefingEntry {
  const 관측: string[] = [];
  const 대조: string[] = [];
  for (const e of d.evidence) {
    (관측계.has(e.factType) ? 관측 : 대조).push(근거줄(e, 기준));
  }

  const 판단 = [...new Set(d.invalidates.map((v) => v.reason.trim()).filter(Boolean))];
  if (판단.length === 0 && d.summary.trim()) 판단.push(d.summary.trim());

  const 무효화 = d.invalidates.map((v) => `${v.docId} — ${v.scope}`);

  const 만든것 = 만든것줄(소속, d);

  const 불확실성: string[] = [];
  if (Number.isFinite(d.confidence)) 불확실성.push(`확신도 ${d.confidence}`);
  if (소속.some((i) => i.trigger?.requiresHumanConfirmation === true)) {
    불확실성.push("사람 확인이 필요합니다. 기계가 혼자 확정하지 않습니다.");
  }
  if (소속.length > 0 && 소속.every((i) => i.draft === null)) {
    불확실성.push("초안 없이 할 일만 올렸습니다. 현장 확인이 먼저입니다.");
  }

  return {
    ruleId: d.ruleId,
    label: ruleLabel(d.ruleId, labels),
    // 머리글과 같은 문장이 여기에도 선다. 한쪽만 다듬으면 같은 조건이 두 표기로 갈라져
    // 읽는 사람이 서로 다른 일로 읽는다.
    headline: 시각다듬기(d.summary.trim(), 기준),
    detectedAt: d.detectedAt,
    createdCount: 소속.length,
    itemIds: 소속.map((i) => i.itemId),
    관측,
    대조,
    판단,
    무효화,
    만든것,
    불확실성,
  };
}

function 만든것줄(소속: WorkItem[], d: Detection): string[] {
  const out: string[] = [];

  if (소속.length > 0) {
    const 묶음 = new Map<WorkItemStatus, number>();
    for (const i of 소속) 묶음.set(i.status, (묶음.get(i.status) ?? 0) + 1);
    const 순서: WorkItemStatus[] = ["approval", "todo", "done"];
    out.push(
      순서
        .filter((s) => 묶음.has(s))
        .map((s) => `${상태이름[s]} ${묶음.get(s)}건`)
        .join(" · "),
    );
  }

  for (const p of d.produces) {
    const 꼬리 = [
      p.count !== undefined ? `${p.count}건` : null,
      p.to ? `수신 ${p.to}` : null,
      p.for ? `대상 ${p.for}` : null,
      p.into ? `편입 ${p.into}` : null,
      p.teams && p.teams.length > 0 ? `팀 ${p.teams.join(" · ")}` : null,
    ].filter(Boolean);
    out.push(꼬리.length > 0 ? `${p.form} — ${꼬리.join(" · ")}` : p.form);
  }

  return out;
}
