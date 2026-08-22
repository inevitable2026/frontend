import type {
  BriefingEntry,
  Detection,
  Evidence,
  FactType,
  WorkItem,
  WorkItemStatus,
} from "@/lib/board/types";

import {
  kstClock,
  ruleLabel,
  가장급한카드,
  기한시각,
  날짜말,
  시각말,
  type KstClock,
} from "./briefing";

// 브리핑 문장을 틀에 끼워 만드는 옛 방식이다. **지금은 되돌아갈 자리로만 쓴다.**
//
// 문장은 lib/generate/narrative.ts 가 근거를 읽고 쓴다. 그쪽이 실패했을 때 화면이 비는
// 것보다는 틀에 박힌 문장이라도 서 있는 편이 낫기 때문에 이 파일을 지우지 않고 남겼다.
// 담당자에게 브리핑이 비어 있다는 것은 "오늘 아무 일도 없다" 로 읽히고, 그것이 사실이
// 아닐 때 그 화면은 거짓말을 한 것이 된다.
//
// 여기 있는 문장들은 어떤 상황에서도 똑같이 나온다. 자재가 바뀌든 아차사고가 나든 같은
// 다섯 문단 틀에 숫자만 갈아 끼운다. 그것이 이 방식을 그만둔 이유이고, 그럼에도 사실과
// 어긋나지는 않으므로 마지막 안전망으로 쓸 값어치가 있다.
//
// 한 가지는 여기서만 한다. 받침을 세어 조사를 고르는 일이다. 모델은 조사를 스스로
// 맞추지만 이 틀은 문자열을 이어 붙이므로 그 계산이 필요하다.

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

const 상태이름: Record<WorkItemStatus, string> = {
  todo: "할 일",
  approval: "승인 대기",
  done: "완료",
};

// --- 문단 -------------------------------------------------------------------

export type 문단재료 = {
  /** 창 안의 감지. 전제가 무너진 문서를 세는 데 쓴다 */
  감지: Detection[];
  /** 현장의 카드 전부. 가장 급한 것을 여기서 고른다 */
  전체: WorkItem[];
  기준: KstClock;
  창: KstClock;
  conditionCount: number;
  createdCount: number;
  draftedCount: number;
  /** 사람 확인을 기다리는 카드 수. 화면의 계량 칸과 같은 값이어야 해서 세지 않고 받는다 */
  확인대기: number;
  documentCount?: number;
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
 * 브리핑 머리글. **세 줄까지만 쓴다.**
 *
 * 예전에는 조건마다 한 줄씩 더 붙어 열 줄이 넘는 벽이 섰다. 그러나 조건을 하나씩 펼쳐
 * 보여 주는 일은 아래 조건 패널이 이미 하고 있고, 머리글이 그것을 되풀이하면 목록의
 * 사본이 될 뿐이다. 훑어 읽을 수 없는 요약은 요약이 아니다.
 *
 * 그래서 이 자리는 세 가지만 말한다.
 *   1. 얼마나 되는 일인가 — 조건 · 태스크 · 초안 건수
 *   2. 무엇부터 손대야 하는가 — 가장 급한 카드와 그 기한
 *   3. 사람이 무엇을 봐야 하는가 — 전제가 무너진 문서와 확인을 기다리는 태스크
 *
 * 해당 사항이 없는 줄은 통째로 빠진다. 없는 일을 지어내 세 줄을 채우느니 두 줄로 서는
 * 편이 낫다.
 */
export function 폴백문단들(재료: 문단재료): string[] {
  const out: string[] = [첫줄(재료)];

  const 둘째 = 급한줄(재료);
  if (둘째) out.push(둘째);

  const 셋째 = 확인줄(재료);
  if (셋째) out.push(셋째);

  return out;
}

/** 1. 창 안에서 무엇을 읽고 무엇을 만들었나 */
function 첫줄(재료: 문단재료): string {
  const 창말 = `${날짜말(재료.창, 재료.기준)} ${시각말(재료.창)} 이후`;
  // 문서 수를 세지 못한 자리에는 아무 말도 넣지 않는다. 못 센 것을 0 으로 적으면
  // "한 건도 들어오지 않았다" 가 되어 사실과 어긋난다.
  const 읽은말 =
    재료.documentCount !== undefined && 재료.documentCount > 0
      ? ` 문서 ${재료.documentCount}건에서`
      : "";

  if (재료.conditionCount === 0 && 재료.createdCount === 0) {
    return `${창말} 새로 감지된 조건도 올라온 태스크도 없습니다.`;
  }

  if (재료.conditionCount === 0) {
    const n = `${재료.createdCount}건`;
    return `${창말} 새로 감지된 조건은 없고, 태스크 ${n}${이가(n)} 올라와 있습니다.`;
  }

  // "할 일"은 칸반 열 이름이라 총계에 쓰지 않는다. 열 이름과 총계가 같은 낱말이면
  // 읽는 사람이 승인 대기와 완료까지 할 일 열에 있다고 읽는다.
  const 조건 = `${재료.conditionCount}건`;
  const 태스크 = `${재료.createdCount}건`;
  const 앞 = `${창말}${읽은말} 조건 ${조건}${을를(조건)} 찾아 태스크 ${태스크}${을를(태스크)}`;

  if (재료.draftedCount === 0) return `${앞} 올렸습니다.`;
  const 초안 = `${재료.draftedCount}건`;
  return `${앞} 올렸고, 그 가운데 ${초안}${은는(초안)} 초안까지 써 두었습니다.`;
}

/** 2. 오늘 무엇부터 손대야 하나 */
function 급한줄(재료: 문단재료): string | null {
  const 급한 = 가장급한카드(재료.전체);
  if (!급한) return null;

  const 제목 = `「${급한.item.title}」`;
  const 기한 = 기한말(급한.item, 재료.기준);
  // 카드 요약은 여기에 붙이지 않는다. 한 줄이 두 문장을 넘기는 순간 훑어 읽히지 않고,
  // 그 요약은 카드를 열면 그대로 있다.
  return 기한
    ? `가장 급한 것은 ${제목}이고 기한은 ${기한}입니다.`
    : `가장 급한 것은 ${제목}입니다.`;
}

/**
 * 3. 사람이 직접 봐야 하는 것.
 *
 * 문서 식별자는 적지 않는다. `ra_2026_07_regular` 같은 값이 셋만 이어져도 줄이 기계
 * 좌표로 덮이고, 그 좌표가 필요한 사람은 아래 조건 패널의 무효화 칸을 연다.
 *
 * 확인 대기 수는 화면의 계량 칸이 그리는 값을 그대로 받는다. 한 패널에서 같은 것을 두
 * 숫자로 말하면 그 뒤로 화면의 어떤 숫자도 믿기지 않는다.
 */
function 확인줄(재료: 문단재료): string | null {
  const 무효문서 = new Set(재료.감지.flatMap((d) => d.invalidates.map((v) => v.docId)));

  const 조각: string[] = [];
  if (무효문서.size > 0) 조각.push(`전제가 무너진 문서 ${무효문서.size}건`);
  if (재료.확인대기 > 0) 조각.push(`사람 확인을 기다리는 태스크 ${재료.확인대기}건`);
  if (조각.length === 0) return null;

  const 앞 = 조각.length === 2 ? `${조각[0]}${과와(조각[0])} ${조각[1]}` : 조각[0];
  return `${앞}${이가(앞)} 아래 목록에 있습니다.`;
}

function 기한말(item: WorkItem, 기준: KstClock): string | null {
  if (!item.dueBy) return null;
  const t = 기한시각(item.dueBy);
  if (t === null) return item.dueBy.trim();
  const c = kstClock(t);
  return `${날짜말(c, 기준)} ${시각말(c)}`;
}

// --- 근거 패널 한 건 --------------------------------------------------------

export function 폴백항목(
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
