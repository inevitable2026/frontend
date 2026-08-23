import { BOARD_DATE } from "./board/scene.ts";
import { BOARD_SITE_ID } from "./board/site.ts";
import { DOCUMENT_KINDS, type DocumentKind } from "./context/types.ts";

export type { DocumentKind };

export const NAV_VALUES = ["board", "chat", "context", "risk"] as const;
export type ConsoleNav = (typeof NAV_VALUES)[number];
export const RISK_SCREENS = ["queue", "timeline", "new-assessment"] as const;
export type RiskScreen = (typeof RISK_SCREENS)[number];
export type BoardView = "week" | "month";

export type ConsoleUrlState = {
  nav: ConsoleNav;
  siteId: string;
  boardDate: string;
  boardFilterDate: string | null;
  boardView: BoardView;
  contextKind: DocumentKind | null;
  documentId: string | null;
  riskScreen: RiskScreen;
  riskSiteId: string | null;
  cardId: string | null;
  assessmentId: string | null;
  conversationId: string | null;
  /**
   * 시연 모드.
   *
   * **주소에 싣는 이유.** 이 앱은 URL 이 상태의 원천이고(`app/page.tsx` 가 서버에서
   * 파싱해 내려준다), 주소에 실으면 **강제 새로고침에도 남는다** — 시연 중 새로 고쳐도
   * 모드가 유지되어야 한다는 요구가 이 한 줄로 해결된다. localStorage 로 두면 서버
   * 렌더와 어긋난다.
   *
   * 내 브라우저에만 적용된다. 같은 주소를 남에게 보내지 않는 한 남의 화면은 그대로다.
   *
   * **기본값이 켜짐이다.** 이 배포는 지금 시연용이고, 켜는 것을 잊은 채 시연을 시작하면
   * 첫 반영에서 카드가 사라진다 — 그 자리에서 되돌릴 방법이 없다. 그래서 끄는 쪽을
   * 명시하게 했다(`demo=0`). 시연이 끝나면 이 기본값을 되돌린다.
   */
  demo: boolean;
};

/**
 * Applies a console URL update to a known state. Keeping this transition pure lets
 * callers compose back-to-back patches before Next has completed navigation.
 */
export function patchConsoleUrlState(
  current: ConsoleUrlState,
  patch: Partial<ConsoleUrlState>,
): ConsoleUrlState {
  const next = { ...current, ...patch };
  if (patch.siteId !== undefined && patch.siteId !== current.siteId) {
    // `demo` 는 여기서 비우지 않는다. 현장을 바꿔도 시연 모드는 유지되는 편이 맞다 —
    // 아래 필드들은 "그 현장에서 열어 둔 것" 이지만 시연 모드는 보는 사람의 설정이다.
    next.documentId = null;
    next.riskSiteId = null;
    next.cardId = null;
    next.assessmentId = null;
    next.conversationId = null;
    next.riskScreen = "queue";
  }
  return next;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function isYmd(value: string): boolean {
  if (!YMD.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const DEFAULT_CONSOLE_URL_STATE: ConsoleUrlState = {
  nav: "board", siteId: BOARD_SITE_ID, boardDate: BOARD_DATE, boardView: "week",
  boardFilterDate: BOARD_DATE, contextKind: null, documentId: null, riskScreen: "queue",
  riskSiteId: null, cardId: null, assessmentId: null,
  conversationId: null, demo: true,
};

type Params = Pick<URLSearchParams, "get"> | Record<string, string | string[] | undefined>;
function value(params: Params, key: string): string | null {
  if ("get" in params && typeof params.get === "function") return params.get(key);
  const raw = (params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
}
function oneOf<T extends readonly string[]>(raw: string | null, values: T, fallback: T[number]): T[number] {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T[number]) : fallback;
}

/** Untrusted query strings become a small, stable console state before use. */
export function parseConsoleUrlState(params: Params): ConsoleUrlState {
  const siteId = value(params, "siteId");
  const requestedBoardDate = value(params, "date");
  const boardDate = requestedBoardDate !== null && isYmd(requestedBoardDate)
    ? requestedBoardDate
    : DEFAULT_CONSOLE_URL_STATE.boardDate;
  const requestedFilterDate = value(params, "filterDate");
  const contextKind = value(params, "kind");
  const documentId = value(params, "documentId");
  const riskSiteId = value(params, "riskSiteId");
  const cardId = value(params, "cardId");
  const assessmentId = value(params, "assessmentId");
  const conversationId = value(params, "conversationId");
  const requestedNav = value(params, "nav");
  const requestedRiskScreen = value(params, "risk");
  return {
    // `tbm` and `workspace` were emitted by an older console. Keep those links safe,
    // but never revive the removed screens.
    nav: requestedNav === "tbm"
      ? DEFAULT_CONSOLE_URL_STATE.nav
      : oneOf(requestedNav, NAV_VALUES, DEFAULT_CONSOLE_URL_STATE.nav),
    siteId: siteId !== null && UUID.test(siteId) ? siteId : DEFAULT_CONSOLE_URL_STATE.siteId,
    boardDate,
    boardFilterDate: requestedFilterDate === "all"
      ? null
      : requestedFilterDate !== null && isYmd(requestedFilterDate)
        ? requestedFilterDate
        : boardDate,
    boardView: oneOf(value(params, "view"), ["week", "month"] as const, "week"),
    contextKind: contextKind !== null && DOCUMENT_KINDS.includes(contextKind as DocumentKind) ? contextKind as DocumentKind : null,
    documentId: documentId !== null && UUID.test(documentId) ? documentId : null,
    riskScreen: requestedRiskScreen === "workspace"
      ? "queue"
      : oneOf(requestedRiskScreen, RISK_SCREENS, "queue"),
    riskSiteId: riskSiteId !== null && UUID.test(riskSiteId) ? riskSiteId : null,
    cardId: cardId !== null && RESOURCE_ID.test(cardId) ? cardId : null,
    assessmentId: assessmentId !== null && RESOURCE_ID.test(assessmentId) ? assessmentId : null,
    conversationId: conversationId !== null && UUID.test(conversationId) ? conversationId : null,
    // **끄는 값만 받는다.** 기본이 켜짐이므로 `demo=0` 만 끈 것으로 읽는다.
    // 예전에는 반대였다(켜는 값만 받음). 시연 배포라 기본을 뒤집었고, 되돌릴 때는
    // 이 줄과 DEFAULT_CONSOLE_URL_STATE 를 함께 되돌려야 한다 — 한쪽만 바꾸면
    // 주소에 아무것도 없을 때와 토글을 끌 때가 어긋난다.
    demo: value(params, "demo") !== "0",
  };
}

/** Canonical serialization deliberately excludes transient component state. */
export function serializeConsoleUrlState(state: ConsoleUrlState): string {
  const params = new URLSearchParams({ nav: state.nav, siteId: state.siteId, date: state.boardDate, view: state.boardView });
  if (state.boardFilterDate === null) params.set("filterDate", "all");
  else if (state.boardFilterDate !== state.boardDate) params.set("filterDate", state.boardFilterDate);
  if (state.contextKind) params.set("kind", state.contextKind);
  if (state.documentId) params.set("documentId", state.documentId);
  if (state.riskScreen !== "queue") params.set("risk", state.riskScreen);
  if (state.riskSiteId) params.set("riskSiteId", state.riskSiteId);
  if (state.cardId) params.set("cardId", state.cardId);
  if (state.assessmentId) params.set("assessmentId", state.assessmentId);
  if (state.conversationId) params.set("conversationId", state.conversationId);
  // 기본이 켜짐이라 꺼졌을 때만 적는다. 기본값이 주소를 더럽히지 않는다.
  if (!state.demo) params.set("demo", "0");
  return `/?${params.toString()}`;
}
