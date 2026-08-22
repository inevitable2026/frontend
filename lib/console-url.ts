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
};

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
  return `/?${params.toString()}`;
}
