import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../tmp/test-dist/lib/console-url.js", import.meta.url).href;
const { DEFAULT_CONSOLE_URL_STATE, parseConsoleUrlState, patchConsoleUrlState, serializeConsoleUrlState } = await import(moduleUrl);

test("console URL state round-trips all addressable selections", () => {
  const state = parseConsoleUrlState(new URLSearchParams("nav=context&siteId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae&date=2026-08-20&filterDate=2026-08-22&view=month&kind=%EB%A9%94%EC%9D%BC&documentId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21af&risk=timeline&riskSiteId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae&cardId=card_456&assessmentId=risk_123&conversationId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21b0"));
  assert.deepEqual(state, { nav: "context", siteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae", boardDate: "2026-08-20", boardFilterDate: "2026-08-22", boardView: "month", contextKind: "메일", documentId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21af", riskScreen: "timeline", riskSiteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae", cardId: "card_456", assessmentId: "risk_123", conversationId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21b0" });
  assert.deepEqual(parseConsoleUrlState(new URL(serializeConsoleUrlState(state), "https://console.test").searchParams), state);
});

test("console URL state rejects invalid values and never serializes transient state", () => {
  assert.deepEqual(parseConsoleUrlState(new URLSearchParams("nav=4&siteId=nope&date=2026-02-31&filterDate=never&view=day&kind=nope&documentId=bad/value&risk=nope&riskSiteId=nope&cardId=bad/value&assessmentId=bad/value")), DEFAULT_CONSOLE_URL_STATE);
  assert.equal(serializeConsoleUrlState(DEFAULT_CONSOLE_URL_STATE), "/?nav=board&siteId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae&date=2026-08-19&view=week");
});

test("conversation ID is a UUID and clears when its site changes", () => {
  assert.equal(parseConsoleUrlState(new URLSearchParams("conversationId=not-an-id")).conversationId, null);
  const state = patchConsoleUrlState(DEFAULT_CONSOLE_URL_STATE, { conversationId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21b0" });
  assert.equal(patchConsoleUrlState(state, { siteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21af" }).conversationId, null);
});

test("console URL state rejects impossible months without throwing", () => {
  assert.equal(parseConsoleUrlState(new URLSearchParams("date=2026-13-01")).boardDate, DEFAULT_CONSOLE_URL_STATE.boardDate);
  assert.equal(parseConsoleUrlState(new URLSearchParams("date=2026-00-01")).boardDate, DEFAULT_CONSOLE_URL_STATE.boardDate);
});

test("console URL state preserves an explicitly cleared board date filter", () => {
  const state = parseConsoleUrlState(new URLSearchParams("date=2026-08-20&filterDate=all"));
  assert.equal(state.boardFilterDate, null);
  assert.equal(new URL(serializeConsoleUrlState(state), "https://console.test").searchParams.get("filterDate"), "all");
});

test("back-to-back URL patches compose against the latest pending state", () => {
  const afterNavigation = patchConsoleUrlState(DEFAULT_CONSOLE_URL_STATE, { nav: "context" });
  const afterSelection = patchConsoleUrlState(afterNavigation, { contextKind: "메일" });

  assert.equal(afterSelection.nav, "context");
  assert.equal(afterSelection.contextKind, "메일");
});

test("legacy removed screens fall back without being emitted again", () => {
  const state = parseConsoleUrlState(new URLSearchParams("nav=tbm&risk=workspace&cardId=card_456"));
  assert.equal(state.nav, "board");
  assert.equal(state.riskScreen, "queue");
  assert.equal(state.cardId, "card_456");
  assert.equal(serializeConsoleUrlState(state).includes("workspace"), false);
  assert.equal(serializeConsoleUrlState(state).includes("tbm"), false);
});
