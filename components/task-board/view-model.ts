// 서버 타입(lib/board/types.ts)을 화면 뷰모델(./types.ts)로 옮겨 담는 어댑터다.
//
// 두 타입 체계를 굳이 나눠 둔 이유는 화면이 DB 컬럼과 감지 엔진의 어휘를 보지 않게 하기
// 위해서다. 서버는 WorkItem 하나에 규칙 번호와 초안 원문을 담아 보내고, 화면은 색띠와
// 배지와 이유 한 줄을 그린다. 그 사이의 판단을 컴포넌트마다 흩어 놓으면 같은 카드가
// 칸반과 브리핑과 캘린더에서 서로 다른 색으로 나오므로, 판단을 이 파일 하나에 모은다.
//
// 이 파일의 함수는 전부 순수 함수다. fetch 도 Date.now() 도 부르지 않는다. 들어온 응답이
// 같으면 언제 불러도 같은 화면이 나와야 접었다 편 근거 패널이 자리를 지키고, 새로 고침
// 전후로 조건 식별자가 달라지지 않는다.
//
// 값을 만들어 내지 않는다는 규칙도 여기서 지킨다. 서버에 대응 필드가 없는 자리(법적 근거 ·
// 제안 · 공정 단계 · 부재 표시)는 null 이나 빈 문자열로 둔다. 그럴듯한 문구를 상수로 박으면
// 다른 현장을 골랐을 때 곧바로 거짓말이 되고, 안전관리 콘솔에서 그것은 기록의 위조와 같은
// 자리에 선다.

import { kstDateOf, ruleLabel, 기한날짜, 기한시각 } from "@/lib/board/briefing";
import type {
  Briefing,
  BriefingEntry,
  Draft,
  RiskRowDraft,
  RiskScoreDraft,
  WeekPage,
  WorkItem,
} from "@/lib/board/types";

import {
  APPROVAL_KIND_BADGE,
  BOARD_COLUMNS,
  BRIEFING_LIVE_LABEL,
  CALENDAR_LEGEND,
  CONDITION_BY_RULE,
  CONSOLE_ACTOR,
  CONSOLE_ACTOR_NAME,
  COUNTER_LABEL,
  DOW_NAMES,
  DRAFT_CARD_TONE,
  DRAFT_KIND_BADGE,
  EXTERNAL_PREFIXES,
  FACT_TYPE_LABEL,
  IMPLEMENTATION_PENDING,
  INVALIDATED_DOC_TITLE,
  MARKER_GROUP_LABEL,
  NOT_DELEGABLE_REASON,
  NO_LEGAL_REFERENCE,
  REFERENCE_FALLBACK_KIND,
  USERS,
  WATCH_SOURCE_COUNT,
  WEEK_DOW,
} from "./presentation";
import type {
  Assignee,
  BoardCalendar,
  BoardCounter,
  BoardCounterKey,
  BoardSiteHeader,
  BoardSnapshot,
  BriefingCondition,
  BriefingMetric,
  BriefingSlot,
  CalendarChip,
  CalendarDay,
  CardTone,
  ConditionSlug,
  DailyBriefing,
  InvalidatedDoc,
  MarkerTone,
  ProducedItem,
  ReferenceDetail,
  RichRun,
  RichText,
  TaskCard,
  TaskDraft,
  TaskKindBadge,
  TaskTag,
} from "./types";

/* ------------------------------------------------------------------ *
 * 들어오는 재료
 * ------------------------------------------------------------------ */

/** GET /api/context/documents 응답 한 줄 가운데 이 화면이 쓰는 칸만 적었다. */
export type ContextDocument = {
  id: string;
  title: string;
  kind: string;
  created_at: string;
};

export type BoardSources = {
  siteId: string;
  /** 보드가 그리는 날. 'YYYY-MM-DD' */
  date: string;
  /** GET /api/context/sites 에서 찾은 현장 이름. 못 찾았으면 대체 문구가 들어온다. */
  siteName: string;
  /** GET /api/board/items 의 items. 날짜로 거르지 않은 현장 전체다. */
  items: WorkItem[];
  week: WeekPage;
  briefing: Briefing;
  /**
   * 이 현장의 문서 목록. **읽지 못했으면 `null` 이고 그것은 빈 배열과 다른 자리에 선다.**
   * 빈 배열로 바꿔 두면 화면이 "창 안에 새 문서가 한 건도 없었다" 고 단언하게 되는데,
   * 실제로는 질의가 실패해 아무것도 확인하지 못한 상태다. 서버의 브리핑도 같은 이유로
   * 문서 수를 0 이 아니라 undefined 로 넘긴다(lib/board/sources.ts 의 창안문서수).
   */
  documents: ContextDocument[] | null;
};

/* ------------------------------------------------------------------ *
 * KST 시각 — Date 객체를 밖으로 내보내지 않는다
 *
 * 서버는 UTC 로 돈다. 'YYYY-MM-DD' 를 Date 로 왕복시키면 하루가 밀리므로, 시각을 다룰 때는
 * 9시간을 더한 뒤 UTC 자리값만 읽고 문자열로 되돌린다. lib/board/briefing.ts 가 서버에서
 * 같은 방식을 쓰고 있어 두 곳의 날짜 판정이 어긋나지 않는다.
 * ------------------------------------------------------------------ */

const KST_OFFSET_MS = 9 * 3_600_000;

type KstParts = {
  ymd: string;
  월: number;
  일: number;
  시: number;
  분: number;
};

function kstParts(value: string | null): KstParts | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + KST_OFFSET_MS);
  return {
    ymd: d.toISOString().slice(0, 10),
    월: d.getUTCMonth() + 1,
    일: d.getUTCDate(),
    시: d.getUTCHours(),
    분: d.getUTCMinutes(),
  };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function hhmm(parts: KstParts): string {
  return `${pad2(parts.시)}:${pad2(parts.분)}`;
}

/** 'YYYY-MM-DD' 의 요일 이름. 문자열을 UTC 자정으로 읽으므로 시간대가 끼어들지 않는다. */
function dowOf(ymd: string): string {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return "";
  return DOW_NAMES[new Date(t).getUTCDay()];
}

function addDays(ymd: string, n: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 현장 근무가 시작되는 시각. app/api/board/week/route.ts 의 같은 상수다. */
const 근무시작시 = 8;

/**
 * 카드를 실제로 손대야 하는 날. week 라우트의 손대야하는날() 을 그대로 옮겼다.
 *
 * 06시 40분에 쓸 자료를 그날 아침에 만들 수는 없으므로, 근무 시작 이전이 기한인 카드는
 * 전날로 당겨 읽는다. 캘린더의 칩과 카드의 기한 강조가 이 판정을 공유해야 주간 화면과
 * 칸반이 같은 말을 한다.
 */
function 손대야하는날(dueBy: string | null): string | null {
  const 기한 = 기한날짜(dueBy);
  if (!기한) return null;

  // 시각이 박히지 않은 기한('2026-08-20 작업 전' 같은 문구)은 앞당기지 않는다.
  const t = 기한시각(dueBy);
  if (t === null) return 기한;

  const 시 = new Date(t + KST_OFFSET_MS).getUTCHours();
  if (시 >= 근무시작시) return 기한;
  return addDays(기한, -1);
}

/* ------------------------------------------------------------------ *
 * 서식 있는 짧은 글
 *
 * 서버는 근거를 한 줄 문자열로 보낸다. 모양은 `본문 — 시점말 · 출처` 이고, 출처는 문서
 * 식별자이거나 `${factType} · ${key}` 다. 화면은 HTML 문자열을 밀어 넣지 않으므로 이 줄을
 * 조각 배열로 되가른다. 되가르는 자리를 여기 하나로 모아 두어야 브리핑의 여섯 칸이 전부
 * 같은 규칙으로 읽힌다.
 * ------------------------------------------------------------------ */

const text = (value: string): RichRun => ({ kind: "text", text: value });
const strong = (value: string): RichRun => ({ kind: "strong", text: value });
const refRun = (refId: string): RichRun => ({ kind: "ref", refId });

/**
 * 수량 표현만 굵게 만든다.
 *
 * 단위를 가진 숫자는 그 자체로 판단의 근거라 눈에 먼저 들어와야 한다. 단위가 없는 숫자
 * (확신도 0.91 같은 값)는 여기서 걸리지 않고 따로 다룬다. ㎡ 와 ㎜ 를 m 보다 앞에 두는 것은
 * 정규식이 왼쪽부터 맞춰 보기 때문이며, 순서를 바꾸면 '1,850㎡' 가 '1,850m' 로 끊긴다.
 */
const QUANTITY_SOURCE = "\\d[\\d,.]*\\s*(?:건|행|명|쪽|㎜|㎡|mm|m|%|분|시간|단|층)";

/** 시계 읽기의 분. "오전 8시 10분" 의 10분은 수량이 아니라 시각이라 굵게 만들지 않는다. */
const CLOCK_MINUTE = /\d\s*시\s*$/;

function 수량조각(value: string): RichRun[] {
  const runs: RichRun[] = [];
  const pattern = new RegExp(QUANTITY_SOURCE, "g");
  let last = 0;
  let found = pattern.exec(value);
  while (found !== null) {
    const 시각의분 = found[0].endsWith("분") && CLOCK_MINUTE.test(value.slice(0, found.index));
    if (!시각의분) {
      if (found.index > last) runs.push(text(value.slice(last, found.index)));
      runs.push(strong(found[0]));
      last = found.index + found[0].length;
    }
    found = pattern.exec(value);
  }
  if (last < value.length) runs.push(text(value.slice(last)));
  return runs.length > 0 ? runs : [text(value)];
}

/** 확신도 줄만 숫자를 굵게 만든다. 단위가 없어 수량 정규식에 걸리지 않는다. */
const CONFIDENCE_LINE = /^확신도 (\d(?:\.\d+)?)$/;

type 근거조각 = { 본문: string; 시점말: string | null; 출처: string | null };

/**
 * 근거줄을 본문 · 시점말 · 출처로 가른다.
 *
 * 마지막 ' — ' 를 경계로 삼는다. 본문 안에 ' — ' 가 들어 있는 줄(감리 지적 요약이 그렇다)이
 * 있어서 첫 번째를 잡으면 본문이 중간에서 끊긴다. 반대로 꼬리에는 ' — ' 가 들어가지 않는다.
 * 꼬리를 다시 가를 때는 **첫** ' · ' 를 쓴다. 출처가 `${factType} · ${key}` 형식이면 그 안에
 * ' · ' 가 한 번 더 들어 있으므로 마지막을 잡으면 종류 이름만 남고 열쇠를 잃는다.
 */
function 근거줄가르기(line: string): 근거조각 {
  const 경계 = line.lastIndexOf(" — ");
  if (경계 < 0) return { 본문: line.trim(), 시점말: null, 출처: null };

  const 본문 = line.slice(0, 경계).trim();
  const 꼬리 = line.slice(경계 + 3).trim();
  const 사이 = 꼬리.indexOf(" · ");
  // 관측 시각을 읽지 못한 줄은 서버가 꼬리에 출처만 적는다.
  if (사이 < 0) return { 본문, 시점말: null, 출처: 꼬리 || null };
  return { 본문, 시점말: 꼬리.slice(0, 사이).trim(), 출처: 꼬리.slice(사이 + 3).trim() || null };
}

function 첫문장(value: string): string {
  const 문장 = 문장들(value);
  return 문장.length > 0 ? 문장[0] : value.trim();
}

/**
 * 문장 경계로 가른다. 마침표 뒤에 공백이 오는 자리만 경계로 본다.
 * '8.2m' 처럼 숫자 사이의 마침표는 뒤에 공백이 없어 걸리지 않는다.
 */
function 문장들(value: string): string[] {
  const 다듬은 = value.trim();
  if (!다듬은) return [];
  const out: string[] = [];
  let 시작 = 0;
  for (let i = 0; i < 다듬은.length - 1; i += 1) {
    const 글자 = 다듬은[i];
    if (글자 !== "." && 글자 !== "!" && 글자 !== "?") continue;
    if (!/\s/.test(다듬은[i + 1])) continue;
    out.push(다듬은.slice(시작, i + 1).trim());
    시작 = i + 1;
  }
  const 나머지 = 다듬은.slice(시작).trim();
  if (나머지) out.push(나머지);
  return out;
}

/* ------------------------------------------------------------------ *
 * 참조 사전
 *
 * 근거줄 꼬리의 출처와 무효화 줄의 문서 식별자마다 팝오버 한 칸을 세운다. 화면에는 `[1]`
 * 번호만 나가고 식별자는 드러나지 않으므로, 여기 담기는 제목과 발췌가 담당자가 근거를 확인할
 * 유일한 창구다. 그래서 비어 있는 칸을 만들지 않고 최소한 본문 한 문단은 넣는다.
 * ------------------------------------------------------------------ */

type ReferenceIndex = Map<string, ReferenceDetail>;

/**
 * 근거줄 본문 앞머리에 붙은 내부 식별자를 걷어 낸다.
 *
 * 서버는 사실 하나를 `nearmiss_ledger_2026q3 · 작성중` 처럼 열쇠를 앞세워 적는다. 그 문장을
 * 그대로 팝오버 제목에 올리면 담당자가 알 필요 없는 내부 식별자가 화면에 드러난다
 * (types.ts 의 ReferenceDetail 주석이 금지하는 자리다). 발췌에는 원문을 그대로 남기고
 * 제목에서만 앞머리를 떼어 낸다.
 */
function 식별자벗기기(본문: string, refId: string): string {
  const 사이 = refId.indexOf(" · ");
  const 열쇠 = 사이 > 0 ? refId.slice(사이 + 3).trim() : refId.trim();
  const 다듬은 = 본문.trim();
  if (!열쇠 || !다듬은.startsWith(열쇠)) return 다듬은;
  return 다듬은
    .slice(열쇠.length)
    .replace(/^\s*(?:·|—|-|:)\s*/, "")
    .trim();
}

function 참조등록(
  index: ReferenceIndex,
  documents: Map<string, ContextDocument>,
  refId: string,
  본문: string,
  시점말: string | null,
  제목: string | null = null,
): void {
  const 문서 = documents.get(refId) ?? null;
  const 기존 = index.get(refId);

  if (기존) {
    // 같은 근거가 두 칸에 나오면 발췌만 덧붙인다. 제목과 종류는 처음 본 것을 지킨다.
    if (본문 && !기존.excerpt.includes(본문)) 기존.excerpt.push(본문);
    if (시점말 && !기존.meta.some((항목) => 항목.term === "관측")) {
      기존.meta.unshift({ term: "관측", value: 시점말 });
    }
    return;
  }

  const meta: ReferenceDetail["meta"] = [];
  if (시점말) meta.push({ term: "관측", value: 시점말 });
  if (문서) {
    meta.push({ term: "종류", value: 문서.kind });
    const 등록 = kstDateOf(문서.created_at);
    if (등록) meta.push({ term: "등록", value: 등록 });
  }

  const kindLabel = 참조종류(refId, 문서);
  // 내부 식별자를 팝오버 제목으로 내보내지 않는다. 문서함에서 제목을 찾지 못하면 부르는
  // 쪽이 정해 준 제목을 쓰고, 그것도 없으면 식별자를 뗀 본문의 첫 문장을 쓴다. 셋 다
  // 비면 종류 이름표로 내려간다 — 어느 갈래에서도 refId 는 화면에 나가지 않는다.
  const 본문제목 = 첫문장(식별자벗기기(본문, refId));

  index.set(refId, {
    refId,
    kindLabel,
    title: 문서?.title ?? 제목 ?? (본문제목 || kindLabel),
    meta,
    excerpt: 본문 ? [본문] : [],
    // 근거의 출처 등급을 기록하는 자리가 Evidence 에도 documents 에도 없다.
    origin: null,
  });
}

function 참조종류(refId: string, 문서: ContextDocument | null): string {
  if (문서) return 문서.kind;
  const 사이 = refId.indexOf(" · ");
  if (사이 > 0) return FACT_TYPE_LABEL[refId.slice(0, 사이)] ?? REFERENCE_FALLBACK_KIND;
  return FACT_TYPE_LABEL[refId] ?? REFERENCE_FALLBACK_KIND;
}

/** 근거줄 하나를 조각 배열로 만들고, 꼬리의 출처를 참조 사전에 등록한다. */
function 근거문단(
  line: string,
  index: ReferenceIndex,
  documents: Map<string, ContextDocument>,
): RichText {
  const { 본문, 시점말, 출처 } = 근거줄가르기(line);
  const runs: RichRun[] = [...수량조각(본문)];
  if (시점말) runs.push(text(` (${시점말})`));
  if (출처) {
    참조등록(index, documents, 출처, 본문, 시점말);
    runs.push(refRun(출처));
  }
  return runs;
}

/** 근거줄 형식이 아닌 칸(판단 · 불확실성)은 수량만 굵게 만든다. */
function 평문문단(line: string): RichText {
  const 확신도 = CONFIDENCE_LINE.exec(line.trim());
  if (확신도) return [text("확신도 "), strong(확신도[1])];
  return 수량조각(line.trim());
}

function 슬롯(paragraphs: RichText[]): BriefingSlot | null {
  return paragraphs.length > 0 ? { paragraphs } : null;
}

/* ------------------------------------------------------------------ *
 * 카드
 * ------------------------------------------------------------------ */

function 조건이름(ruleId: string | undefined): ConditionSlug {
  if (!ruleId) return "periodicDue";
  // 주기 규칙은 번호가 늘어날 수 있어 접두어로만 가른다.
  return CONDITION_BY_RULE[ruleId] ?? "periodicDue";
}

function 규칙색(ruleId: string): "alert" | "due" {
  return ruleId.startsWith("S-") ? "due" : "alert";
}

/**
 * 카드 왼쪽 색띠.
 *
 * 위에서부터 처음 걸리는 갈래를 쓴다. 끝난 일은 색을 뺏고, 승인 열은 무엇을 판단해야 하는지에
 * 따라 나누며, 그 밖에는 조건이 만든 것인지 주기가 만든 것인지로 가른다.
 */
function 카드색(item: WorkItem): CardTone {
  if (item.status === "done") return "ok";
  if (item.status === "approval") {
    return item.draft ? DRAFT_CARD_TONE[item.draft.form] : "review";
  }
  const ruleId = item.trigger?.ruleId;
  if (ruleId?.startsWith("T-")) return "alert";
  if (ruleId?.startsWith("S-")) return "due";
  if (item.timing === "daily") return "ok";
  return "routine";
}

/** 카드 상단 유형 배지. 색띠와 같은 순서로 가르되 이름표는 서식 이름을 그대로 쓴다. */
function 카드유형(item: WorkItem): TaskKindBadge {
  if (item.status === "done") {
    return item.timing === "daily"
      ? { label: "매일", tone: "ok" }
      : { label: "자동", tone: "ok" };
  }
  if (item.status === "approval") {
    return item.draft ? DRAFT_KIND_BADGE[item.draft.form] : { ...APPROVAL_KIND_BADGE };
  }
  const ruleId = item.trigger?.ruleId;
  if (ruleId?.startsWith("T-")) return { label: "조건 발생", tone: "alert" };
  if (ruleId?.startsWith("S-")) return { label: "기한", tone: "due" };
  if (item.timing === "schedule") return { label: "일정", tone: "routine" };
  return { label: "매일", tone: "ok" };
}

/**
 * 카드 태그 최대 세 개.
 *
 * 조건 이름 · 예상 소요 · 초안의 분량 · 완료 카드의 근거 문서 순으로 담고 세 개에서 끊는다.
 * '분' 이 든 태그가 있으면 task-card.tsx 가 예상 소요 배지를 따로 붙이지 않으므로,
 * 두 번째 자리의 문구를 바꿀 때는 그 판정도 함께 봐야 한다.
 */
function 카드태그(item: WorkItem): TaskTag[] {
  const tags: TaskTag[] = [];

  if (item.trigger) {
    // 규칙 번호(`T-03` · `S-02`)는 감지 엔진의 어휘다. 카드 표면에는 사람이 읽는 이름을
    // 적고, 번호가 필요한 대조는 근거 서랍의 "왜 생겼나" 가 받는다 — evidence-drawer.tsx 가
    // 같은 이름표 옆에 번호를 title 로 달아 둔다. TaskTag 에는 title 자리가 없어 이 배지에는
    // 번호를 달지 못한다.
    //
    // 이름표는 lib/board/briefing.ts 의 ruleLabel 에서 끌어온다. presentation.ts 의
    // CONDITION_BY_RULE 은 T-01~T-08 만 아는 조건 슬러그 표이고, 이것만이 규칙 파일이 없는
    // S- 규칙까지 이름을 안다(주기 도래).
    tags.push({ label: ruleLabel(item.trigger.ruleId), tone: 규칙색(item.trigger.ruleId) });
  }
  if (item.estimatedMinutes !== null) {
    tags.push({ label: `${item.estimatedMinutes}분`, tone: "neutral" });
  }

  const draft = item.draft;
  if (draft) {
    switch (draft.form) {
      case "회의록":
        tags.push({ label: `회의록 ${draft.rows.length}행`, tone: "doc" });
        break;
      case "공문":
        tags.push({ label: `수신 ${draft.수신}`, tone: "neutral" });
        break;
      case "회의자료":
        tags.push({ label: `안건 ${draft.안건.length}건`, tone: "doc" });
        break;
      case "TBM자료":
        // 통역이 필요한 인원이 없으면 이 줄은 아무것도 알리지 않는다.
        if (draft.통역필요인원 > 0) {
          tags.push({ label: `통역 ${draft.통역필요인원}명`, tone: "alert" });
        }
        break;
      case "점검표":
        tags.push({ label: `점검 ${draft.항목.length}건`, tone: "doc" });
        break;
      case "기록":
        break;
    }
  }

  const 근거 = item.trigger?.sourceDocRefs[0];
  if (item.status === "done" && 근거) tags.push({ label: 근거, tone: "doc" });

  return tags.slice(0, 3);
}

function 담당자(assignee: string | null): Assignee | null {
  if (!assignee) return null;
  const 이름 = USERS[assignee]?.name ?? assignee.replace(/^user_/, "");
  return {
    id: assignee,
    name: 이름,
    initial: 이름.slice(0, 1),
    external: EXTERNAL_PREFIXES.some((prefix) => assignee.startsWith(prefix)),
  };
}

/** 확정자 문자열을 화면에 적을 이름으로 바꾼다. 사전에 없으면 온 값을 그대로 쓴다. */
export function 확정자이름(value: string | null): string | null {
  if (!value) return null;
  // 로그인이 없는 화면에서 누른 확정이다. 누른 사람을 확인할 방법이 없어 사람 이름 대신
  // 어디서 확정했는지를 적는다.
  if (value === CONSOLE_ACTOR) return CONSOLE_ACTOR_NAME;
  if (!value.startsWith("user_")) return value;
  return USERS[value]?.name ?? value.replace(/^user_/, "");
}

/**
 * 카드 오른쪽 아래 기한 문구.
 *
 * 열을 가리지 않는다. 예전에는 승인 열을 비웠는데 그 근거였던 "태그가 이미 기한을 말한다"
 * 를 카드태그() 가 지키지 않는다 — 태그는 규칙 번호와 분량만 만들고 기한을 말하는 태그를
 * 하나도 만들지 않는다. 그래서 오늘 오후 두 시가 기한인 승인 카드에서 기한이 화면 어디에도
 * 나오지 않았고, dueIsHot 으로 계산된 급함도 색을 입힐 자리가 없어 사라졌다.
 *
 * ISO 시각인지, 보드 날짜인지, 사람이 쓴 문장인지에 따라 여섯 갈래로 나뉜다. 서버 dueBy 가
 * 늘 ISO 는 아니라서 '2026-08-19 오전 중 (시각 미상)' 같은 문장이 그대로 들어온다.
 */
function 기한문구(item: WorkItem, boardDate: string): string | null {
  if (!item.dueBy) {
    const 확정 = kstParts(item.confirmedAt);
    return 확정 ? hhmm(확정) : null;
  }

  const t = 기한시각(item.dueBy);
  if (t !== null) {
    const parts = kstParts(item.dueBy);
    if (!parts) return null;
    if (parts.ymd === boardDate) return hhmm(parts);
    if (parts.ymd === addDays(boardDate, 1) && parts.시 < 근무시작시) return "익일 작업 전";
    return `${parts.월}/${parts.일} ${hhmm(parts)}`;
  }

  // 문장형 기한. 앞머리 날짜와 괄호 묶음을 걷어 내고 남은 말만 적는다.
  const 날짜 = 기한날짜(item.dueBy);
  const 남은 = item.dueBy
    .trim()
    .replace(/^\d{4}-\d{2}-\d{2}\s*/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
  if (!남은) return null;
  if (날짜 === addDays(boardDate, 1)) return `익일 ${남은}`;
  return 남은;
}

/**
 * 기한 문구를 경고색으로 적을지.
 * 근무 시작 이전이라 전날 손대야 하는 카드이거나, 기한이 이미 지난 카드가 참이다.
 */
function 기한급함(dueBy: string | null, boardDate: string): boolean {
  const 기한 = 기한날짜(dueBy);
  if (!기한) return false;
  if (기한 < boardDate) return true;
  return 손대야하는날(dueBy) !== 기한;
}

/* ---------------- 초안 ---------------- */

function 위험도문구(score: RiskScoreDraft): string {
  return `빈도 ${score.likelihood} × 강도 ${score.severity} = ${score.score} (${score.level})`;
}

/**
 * 위험성평가 회의록 초안. 첫 행 하나를 여섯 줄로 편다.
 *
 * 고칠 수 있는 칸을 개선 전후 위험도 둘로 좁힌 것은 계약 때문이다. 위험도 점수는 제품이
 * 확정하지 않고 사람이 고친 차이가 이력으로 남아야 한다. 위험요인과 대책은 근거에서 온
 * 문장이라 이 자리에서 고칠 값이 아니다.
 */
function 회의록초안(draft: Extract<Draft, { form: "회의록" }>, item: WorkItem): TaskDraft | null {
  const row: RiskRowDraft | undefined = draft.rows[0];
  if (!row) return null;

  const 근거 = row.legalReferences
    .filter((참조) => 참조.citable)
    .map((참조) => 참조.ref)
    .join(" · ");

  return {
    form: "riskAssessmentRow",
    ready: true,
    generatedAt: item.updatedAt || item.createdAt,
    into: draft.supersedes ?? item.produces[0]?.into ?? "",
    rowCount: draft.rows.length,
    rows: [
      { label: "④ 위험요인", value: row.hazard, editable: false },
      { label: "⑤ 개선 전", value: 위험도문구(row.risk), editable: true },
      { label: "⑥ 대책", value: row.measures.map((대책) => 대책.text).join(" / "), editable: false },
      { label: "⑦ 개선 후", value: 위험도문구(row.residualRisk), editable: true },
      { label: "⑧ 근거", value: 근거 || NO_LEGAL_REFERENCE, editable: false },
      { label: "⑩ 이행확인", value: IMPLEMENTATION_PENDING, editable: false },
    ],
  };
}

function 초안옮기기(item: WorkItem): TaskDraft | null {
  const draft = item.draft;
  if (!draft) return null;
  const generatedAt = item.updatedAt || item.createdAt;

  switch (draft.form) {
    case "회의록":
      return 회의록초안(draft, item);
    case "공문":
      // 첨부 목록은 화면 초안 미리보기에 자리가 없어 버린다.
      return {
        form: "officialLetter",
        ready: true,
        generatedAt,
        to: draft.수신,
        subject: draft.제목,
        body: draft.본문,
      };
    case "회의자료": {
      const rows = draft.안건.flatMap((안건) => {
        const 줄 = [{ label: `안건 ${안건.번호}`, value: 안건.제목, editable: true }];
        if (안건.문항.length > 0) {
          줄.push({ label: "물을 것", value: 안건.문항.join(" / "), editable: true });
        }
        return 줄;
      });
      return {
        form: "meetingAgenda",
        ready: true,
        generatedAt,
        meetingAt: draft.회의시각,
        // 카드 안 미리보기라 네 줄에서 끊는다. 나머지는 승인 뒤 실제 문서에서 본다.
        items: rows.slice(0, 4),
      };
    }
    case "TBM자료":
      // 서버는 팀 하나당 초안 한 장을 만든다. 그래서 teams 는 늘 한 줄짜리 배열이다.
      return {
        form: "tbmMinutes",
        ready: true,
        generatedAt,
        useAt: draft.사용시각,
        teams: [{ team: draft.팀, focus: draft.항목[0] ?? "", control: draft.항목[1] ?? "" }],
        slogan: draft.구호,
      };
    case "점검표":
    case "기록":
      // 화면에 대응하는 미리보기가 없다. 존재는 배지와 태그로만 남기고 승인·기각 단추는
      // 내보내지 않는다. 다른 서식에 옮겨 담으면 라벨과 내용이 어긋난 초안이 뜬다.
      return null;
  }
}

/* ---------------- 카드 한 장 ---------------- */

function 카드옮기기(
  item: WorkItem,
  boardDate: string,
  제목찾기: (itemId: string) => string | null,
): TaskCard {
  const 문장 = item.summary ? 문장들(item.summary) : [];
  const 남은문장 = 문장.slice(1).join(" ").trim();

  const invalidates: InvalidatedDoc[] = item.invalidates.map((무효) => ({
    docId: 무효.docId,
    // 서버 scope 는 문자열, 화면은 null 을 "문서 전체"로 읽는다.
    scope: 무효.scope.trim() || null,
    reason: 무효.reason,
  }));

  return {
    itemId: item.itemId,
    siteId: item.siteId,
    // 조건은 브리핑을 조립하면서 뒤에서 채운다.
    conditionId: null,
    timing: item.timing,
    status: item.status,
    origin: item.origin,
    laneOrder: item.laneOrder,
    tone: 카드색(item),
    kind: 카드유형(item),
    title: item.title,
    note: 남은문장 || null,
    tags: 카드태그(item),
    rationale: 문장.length > 0 ? { text: 문장[0] } : null,
    trigger: item.trigger
      ? {
          condition: 조건이름(item.trigger.ruleId),
          sourceDocRefs: item.trigger.sourceDocRefs,
          // 추출된 값은 SnapshotFact 안에 있고 카드까지 실어 오는 경로가 없다.
          // 화면의 어느 컴포넌트도 이 칸을 읽지 않아 비워도 그림이 달라지지 않는다.
          extracted: {},
          confidence: item.trigger.confidence,
          requiresHumanConfirmation: item.trigger.requiresHumanConfirmation,
        }
      : null,
    invalidates,
    // "만든 것" 줄은 브리핑의 조건이 소유하고 카드는 그 줄이 가리키는 끝점이다.
    produces: [],
    draft: 초안옮기기(item),
    blockedBy: item.blockedBy.map((itemId) => ({
      itemId,
      title: 제목찾기(itemId) ?? "선행 카드",
    })),
    confirmedBy: 확정자이름(item.confirmedBy),
    confirmedAt: item.confirmedAt,
    dueBy: 기한값(item.dueBy),
    dueLabel: 기한문구(item, boardDate),
    dueIsHot: 기한급함(item.dueBy, boardDate),
    estimatedMinutes: item.estimatedMinutes,
    assignee: 담당자(item.assignee),
    delegable: item.delegable,
    delegableReason: item.delegable ? null : NOT_DELEGABLE_REASON,
  };
}

/**
 * 화면이 쓰는 dueBy.
 * 화면의 날짜 거르기는 앞 열 자리만 견주므로, 문장형 기한은 앞머리 날짜만 남긴다.
 * ISO 는 시각까지 그대로 두어야 캘린더가 같은 판정을 낸다.
 */
function 기한값(dueBy: string | null): string | null {
  if (!dueBy) return null;
  if (기한시각(dueBy) !== null) return dueBy.trim();
  return 기한날짜(dueBy);
}

/* ------------------------------------------------------------------ *
 * 브리핑
 * ------------------------------------------------------------------ */

/**
 * 조건 식별자. 여닫기 상태의 열쇠라 같은 브리핑을 다시 읽어도 같은 값이 나와야 한다.
 *
 * 규칙 번호와 감지 시각만으로는 모자란다. 한 규칙이 한 번에 여러 건 발동하고(T-07 은
 * 어긋난 행 수만큼 감지가 선다) 그것들의 감지 시각이 같은 분에 찍히면 열쇠가 겹친다.
 * 그러면 React 가 같은 key 를 가진 형제를 만나 목록에서 항목을 지우거나 겹쳐 그린다.
 *
 * 그래서 머리글과 자리 번호를 함께 섞는다. 머리글은 같은 조건이면 같은 값이라 열쇠를
 * 안정적으로 만들고(감지 시점에 한 번 쓰여 저장된 뒤로 바뀌지 않는다), 자리 번호는 머리글
 * 마저 같은 두 조건이 나란히 섰을 때 마지막으로 갈라 준다.
 *
 * 자리 번호만 쓰지 않는 이유는 그 값이 목록이 바뀔 때마다 밀리기 때문이다. 조건 하나가
 * 새로 감지되면 아래 것들의 번호가 전부 하나씩 밀리고, 담당자가 펼쳐 둔 패널이 엉뚱한
 * 조건으로 옮겨 간다. 머리글이 앞에 있으면 그 일이 거의 일어나지 않는다.
 */
function 조건식별자(entry: BriefingEntry, 순번: number): string {
  const parts = kstParts(entry.detectedAt);
  const 시각 = parts
    ? `${parts.ymd.replace(/-/g, "")}_${pad2(parts.시)}${pad2(parts.분)}`
    : "unknown";
  const 규칙 = entry.ruleId.toLowerCase().replace("-", "");
  return `cond_${규칙}_${시각}_${짧은해시(entry.headline)}_${순번}`;
}

/** FNV-1a. 열쇠 꼬리에 붙일 짧고 안정적인 값이면 충분하다 */
function 짧은해시(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

function 감지시각문구(detectedAt: string): string {
  const parts = kstParts(detectedAt);
  if (!parts) return "";
  return `${pad2(parts.월)}.${pad2(parts.일)} ${hhmm(parts)}`;
}

/** 조건이 만든 카드. 완료 카드는 승인·Todo 두 레인만 있는 타입이라 뺀다. */
function 만든것(itemIds: string[], cards: Map<string, TaskCard>): ProducedItem[] {
  const out: ProducedItem[] = [];
  for (const itemId of itemIds) {
    const card = cards.get(itemId);
    if (!card || card.status === "done") continue;
    const 요약 = card.rationale?.text ?? null;
    out.push({
      form: card.draft?.form ?? "fieldCheck",
      lane: card.status === "approval" ? "approval" : "todo",
      text: 요약 ? `${card.title} — ${요약}` : card.title,
      cardId: card.itemId,
    });
  }
  return out;
}

/** 무효화 줄 `docId — scope` 를 참조 조각과 범위 문장으로 가른다. */
function 무효화문단(
  line: string,
  판단: string[],
  index: ReferenceIndex,
  documents: Map<string, ContextDocument>,
): RichText {
  const 사이 = line.indexOf(" — ");
  const docId = (사이 < 0 ? line : line.slice(0, 사이)).trim();
  const scope = 사이 < 0 ? "" : line.slice(사이 + 3).trim();

  // 무효화된 문서의 발췌 자리에는 같은 조건의 판단 문장을 담는다. 왜 전제를 잃었는지가
  // 그 문서에 대해 담당자가 알아야 하는 전부다. 다만 제목은 그 판단으로 짓지 않는다 —
  // 한 문서를 여러 조건이 함께 무효화하므로, 먼저 등록한 조건의 판단이 제목으로 굳으면
  // 다른 조건 아래에서 같은 근거를 열었을 때 남의 판단이 제목으로 뜬다.
  참조등록(index, documents, docId, 판단.join(" "), null, INVALIDATED_DOC_TITLE);

  const runs: RichRun[] = [refRun(docId)];
  if (scope) runs.push(text(` ${scope}`));
  return runs;
}

function 조건옮기기(
  entry: BriefingEntry,
  순번: number,
  cards: Map<string, TaskCard>,
  index: ReferenceIndex,
  documents: Map<string, ContextDocument>,
): BriefingCondition {
  const 관측 = entry.관측.map((line) => 근거문단(line, index, documents));
  const 대조 = entry.대조.map((line) => 근거문단(line, index, documents));
  const 판단 = entry.판단.map((line) => 평문문단(line));
  const 무효화 = entry.무효화.map((line) => 무효화문단(line, entry.판단, index, documents));
  const 불확실성 = entry.불확실성.map((line) => 평문문단(line));

  return {
    conditionId: 조건식별자(entry, 순번),
    code: entry.ruleId,
    kindLabel: entry.label,
    condition: 조건이름(entry.ruleId),
    tone: 규칙색(entry.ruleId),
    headline: entry.headline,
    detectedAt: entry.detectedAt,
    detectedAtLabel: 감지시각문구(entry.detectedAt),
    producedCount: entry.createdCount,
    // buildBriefing 이 감지 시각 오름차순으로 보내므로 가장 먼저 감지된 조건이 펼쳐진다.
    defaultOpen: 순번 === 0,
    slots: {
      observation: 슬롯(관측),
      comparison: 슬롯(대조),
      judgement: 슬롯(판단),
      invalidation: 슬롯(무효화),
      // BriefingEntry 에 법적 근거 칸이 없다. 감지 규칙이 법령 원문 조회 결과를 Detection 에
      // 싣지 않으므로 만들어 낼 재료 자체가 없고, 선택 칸이라 줄이 통째로 사라진다.
      legalBasis: null,
      produced: 만든것(entry.itemIds, cards),
      uncertainty: 슬롯(불확실성),
      // 제안에 해당하는 필드가 서버에 없다. 없는 제안을 지어내면 브리핑 전체가 읽히지 않는다.
      suggestion: null,
    },
    // "왜 이 순서로 붙였나" 같은 덧말은 사람이 쓴 해설이고 감지 엔진은 그런 문장을 만들지 않는다.
    note: null,
  };
}

function 브리핑머리(briefing: Briefing): string {
  const parts = kstParts(briefing.generatedAt);
  if (!parts) return `최근 ${briefing.windowHours}시간`;
  return `${parts.ymd} (${dowOf(parts.ymd)}) ${hhmm(parts)} · 최근 ${briefing.windowHours}시간`;
}

/**
 * 브리핑 머리글. 서버가 보낸 줄을 **잇지 않고 줄인 채로** 넘긴다.
 *
 * 예전에는 공백 하나로 이어 한 덩어리를 만들었는데, 조건의 내용까지 머리글에 들어오면서
 * 그 덩어리가 예닐곱 문장짜리 벽이 되었다. 무엇이 급한지 눈으로 훑을 수 없으면 요약이
 * 아니다. 지금은 서버가 세 줄까지만 보내고(lib/generate/schemas.ts 의 상한), 한 줄이
 * 한 가지만 말한다. 근거 표시는 여기에 넣지 않는다 — 이 자리는 요약이고 근거는 아래
 * 조건 패널이 소유한다.
 */
function 머리글(briefing: Briefing): RichText[] {
  const 문단들 = briefing.paragraphs.map((문단) => 문단.trim()).filter(Boolean);
  if (문단들.length === 0) return [[text("새로 감지된 조건이 없습니다.")]];
  return 문단들.map((문단) => 수량조각(문단));
}

/**
 * 브리핑 계량 여섯 칸.
 *
 * "사람 확인 필요" 는 서버가 센 값을 그대로 쓴다. 예전에는 화면이 카드 목록에서 다시 셌는데,
 * 서버의 buildBriefing 은 창 안의 새 카드 전부를 세어 머리글 문장에 적고 화면은 완료 카드를
 * 빼고 세어, 같은 패널 안에서 머리글은 6건 계량 칸은 5 를 말했다. 한 화면이 같은 것을 두
 * 숫자로 말하면 그 뒤로 어떤 숫자도 믿기지 않는다.
 *
 * `새문서수` 가 null 이면 문서함을 읽지 못한 것이다. 0 으로 바꾸지 않고 null 인 채로 넘겨
 * 화면이 "확인하지 못했다" 를 그리게 한다.
 */
function 계량(briefing: Briefing, 새문서수: number | null): BriefingMetric[] {
  return [
    // 소스 연동이 상수라서 소스 수도 상수다.
    { key: "sources", value: WATCH_SOURCE_COUNT, label: "읽은 소스", tone: "neutral" },
    { key: "documents", value: 새문서수, label: "새 문서", tone: "neutral" },
    { key: "conditions", value: briefing.conditionCount, label: "감지한 조건", tone: "neutral" },
    { key: "tasks", value: briefing.createdCount, label: "만든 태스크", tone: "neutral" },
    { key: "drafts", value: briefing.draftedCount, label: "쓴 초안", tone: "ai" },
    {
      key: "confirmations",
      value: briefing.confirmationCount,
      label: "사람 확인 필요",
      tone: "neutral",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 캘린더
 * ------------------------------------------------------------------ */

function 기간문구(from: string, to: string): string {
  const 앞 = kstParts(`${from}T00:00:00+09:00`);
  const 뒤 = kstParts(`${to}T00:00:00+09:00`);
  if (!앞 || !뒤) return `${from} – ${to}`;
  if (앞.월 === 뒤.월) return `${앞.월}월 ${앞.일}일 – ${뒤.일}일`;
  return `${앞.월}월 ${앞.일}일 – ${뒤.월}월 ${뒤.일}일`;
}

/**
 * 그날 칸에 놓인 카드 한 장의 색.
 * 조건이 만든 것이 먼저고, 그다음이 AI 초안이며, 기한 때문에 그날에 놓인 것이 그다음이다.
 */
function 칩색(item: WorkItem, date: string): MarkerTone {
  if (item.trigger?.ruleId.startsWith("T-")) return "alert";
  if (item.draft !== null) return "ai";
  if (손대야하는날(item.dueBy) === date) return "due";
  return "daily";
}

/** 칩은 두 개까지만 적는다. 한 무리가 여러 건이면 건수로, 한 건이면 제목으로 적는다. */
const CHIP_ORDER: MarkerTone[] = ["alert", "due", "ai", "daily"];
const CHIP_TITLE_LIMIT = 14;

function 칩만들기(items: WorkItem[], date: string): { chips: CalendarChip[]; 덮은수: number } {
  const 무리 = new Map<MarkerTone, WorkItem[]>();
  for (const item of items) {
    const tone = 칩색(item, date);
    const 모임 = 무리.get(tone);
    if (모임) 모임.push(item);
    else 무리.set(tone, [item]);
  }

  const chips: CalendarChip[] = [];
  let 덮은수 = 0;
  for (const tone of CHIP_ORDER) {
    if (chips.length >= 2) break;
    const 모임 = 무리.get(tone);
    if (!모임 || 모임.length === 0) continue;
    덮은수 += 모임.length;
    chips.push({
      tone,
      text:
        모임.length > 1
          ? `${MARKER_GROUP_LABEL[tone]} ${모임.length}건`
          : 자르기(모임[0].title, CHIP_TITLE_LIMIT),
    });
  }
  return { chips, 덮은수 };
}

function 자르기(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function 캘린더(week: WeekPage, selectedDate: string): BoardCalendar {
  const 카드 = new Map(week.items.map((item) => [item.itemId, item] as const));

  const days: CalendarDay[] = week.days.map((day, 순번) => {
    const items = day.itemIds
      .map((itemId) => 카드.get(itemId))
      .filter((item): item is WorkItem => item !== undefined);
    const { chips, 덮은수 } = 칩만들기(items, day.date);

    return {
      date: day.date,
      // week 라우트가 from 을 월요일로 당겨 주므로 순번이 곧 요일이다.
      dow: WEEK_DOW[순번] ?? dowOf(day.date),
      dayNumber: Number(day.date.slice(8, 10)),
      count: day.itemIds.length,
      // 칸반의 날짜 거르기가 이 목록을 그대로 쓴다. 기한이 없는 카드는 생성일에 놓이는데
      // 화면이 dueBy 만 보고 거르면 캘린더가 "1건" 이라고 말한 날의 칸반이 통째로 빈다.
      itemIds: day.itemIds,
      chips,
      moreCount: Math.max(0, day.itemIds.length - 덮은수),
      isToday: day.date === selectedDate,
      isWeekend: 순번 === 5 || 순번 === 6,
      // 담당자의 다른 현장 출장 일정을 담은 테이블도 필드도 없다.
      isAway: false,
    };
  });

  return {
    rangeLabel: 기간문구(week.from, week.to),
    totalCount: week.days.reduce((합, day) => 합 + day.itemIds.length, 0),
    days,
    legend: CALENDAR_LEGEND,
  };
}

/* ------------------------------------------------------------------ *
 * 헤더
 * ------------------------------------------------------------------ */

/**
 * 헤더 카운터 세 칸의 판정.
 *
 * BoardHeader 가 카드 목록에서 다시 세므로 규칙을 두 곳에 적으면 곧바로 갈라진다. 그래서
 * 판정을 여기 한 곳에 두고 헤더가 불러다 쓴다.
 *
 * "오늘 기한" 은 카드색이 아니라 **기한 날짜**로 센다. 카드색(tone)은 승인 열에서 초안의
 * 서식으로 정해지므로(회의자료·점검표가 due 색이다) 기한과 아무 관계가 없다. 그 색으로 세면
 * 오늘 두 시가 기한인 카드가 빠지고 기한이 아예 없는 점검표 초안이 대신 들어온다.
 */
export function 카운터규칙(boardDate: string): readonly {
  key: BoardCounterKey;
  label: string;
  tone: BoardCounter["tone"];
  match: (card: TaskCard) => boolean;
}[] {
  return [
    {
      key: "condition",
      label: COUNTER_LABEL.condition,
      tone: "alert",
      match: (card) => card.status === "todo" && card.tone === "alert",
    },
    {
      key: "due",
      label: COUNTER_LABEL.due,
      tone: "due",
      match: (card) =>
        card.status !== "done" && card.dueBy !== null && card.dueBy.slice(0, 10) === boardDate,
    },
    {
      key: "approval",
      label: COUNTER_LABEL.approval,
      tone: "ai",
      match: (card) => card.status === "approval",
    },
  ];
}

function 카운터(cards: TaskCard[], boardDate: string): BoardCounter[] {
  return 카운터규칙(boardDate).map((규칙) => ({
    key: 규칙.key,
    value: cards.filter(규칙.match).length,
    label: 규칙.label,
    tone: 규칙.tone,
  }));
}

function 헤더(
  siteId: string,
  siteName: string,
  cards: TaskCard[],
  boardDate: string,
): BoardSiteHeader {
  return {
    siteId,
    name: siteName,
    // 공정 단계는 현장 스냅샷의 scheduleActiveTasks 에서 읽을 값인데 그 사실을 내보내는
    // 라우트가 없고 public.sites 에는 code · name · created_at 뿐이다. 빈 문자열이면
    // 헤더의 span 이 자리째 사라진다.
    phase: "",
    counters: 카운터(cards, boardDate),
  };
}

/* ------------------------------------------------------------------ *
 * 한 장 조립
 * ------------------------------------------------------------------ */

function 칸반제목(date: string): string {
  const parts = kstParts(`${date}T00:00:00+09:00`);
  if (!parts) return date;
  return `${parts.월}월 ${parts.일}일 ${dowOf(date)}요일`;
}

/**
 * 브리핑 창 안에 들어온 문서 수. 창 밖이면 0 이 나오고 그 0 은 사실이다.
 * 문서함을 읽지 못했으면(`null`) 0 을 만들지 않고 null 을 그대로 올려 보낸다.
 */
function 새문서수(documents: ContextDocument[] | null, briefing: Briefing): number | null {
  if (documents === null) return null;
  const 끝 = Date.parse(briefing.generatedAt);
  if (!Number.isFinite(끝)) return null;
  const 시작 = 끝 - briefing.windowHours * 3_600_000;
  return documents.filter((문서) => {
    const t = Date.parse(문서.created_at);
    return Number.isFinite(t) && t >= 시작 && t <= 끝;
  }).length;
}

export function toBoardSnapshot(src: BoardSources): BoardSnapshot {
  const 제목 = new Map(src.items.map((item) => [item.itemId, item.title] as const));
  const cards = src.items.map((item) =>
    카드옮기기(item, src.date, (itemId) => 제목.get(itemId) ?? null),
  );
  const 카드사전 = new Map(cards.map((card) => [card.itemId, card] as const));

  const references: ReferenceIndex = new Map();
  const 문서사전 = new Map((src.documents ?? []).map((문서) => [문서.id, 문서] as const));

  const conditions = src.briefing.entries.map((entry, 순번) =>
    조건옮기기(entry, 순번, 카드사전, references, 문서사전),
  );

  // 카드가 어느 조건에서 나왔는지는 브리핑의 itemIds 를 뒤집어 얻는다. 어느 항목에도 없으면
  // 일상 업무이거나 창 밖에서 온 카드이므로 null 로 둔다.
  src.briefing.entries.forEach((entry, 순번) => {
    const conditionId = conditions[순번].conditionId;
    for (const itemId of entry.itemIds) {
      const card = 카드사전.get(itemId);
      if (card && card.conditionId === null) card.conditionId = conditionId;
    }
  });

  const briefing: DailyBriefing = {
    stampLabel: 브리핑머리(src.briefing),
    liveLabel: BRIEFING_LIVE_LABEL,
    lede: 머리글(src.briefing),
    metrics: 계량(src.briefing, 새문서수(src.documents, src.briefing)),
    conditions,
  };

  return {
    site: 헤더(src.siteId, src.siteName, cards, src.date),
    briefing,
    calendar: 캘린더(src.week, src.date),
    columns: BOARD_COLUMNS,
    cards,
    references: Object.fromEntries(references),
    selectedDate: src.date,
    kanbanTitle: 칸반제목(src.date),
  };
}
