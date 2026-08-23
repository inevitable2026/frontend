import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../tmp/test-dist/lib/console-url.js", import.meta.url).href;
const { DEFAULT_CONSOLE_URL_STATE, parseConsoleUrlState, patchConsoleUrlState, serializeConsoleUrlState } = await import(moduleUrl);

test("console URL state round-trips all addressable selections", () => {
  const state = parseConsoleUrlState(new URLSearchParams("nav=context&siteId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae&date=2026-08-20&filterDate=2026-08-22&view=month&kind=%EB%A9%94%EC%9D%BC&documentId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21af&risk=timeline&riskSiteId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae&cardId=card_456&assessmentId=risk_123&conversationId=0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21b0&demo=1"));
  assert.deepEqual(state, { nav: "context", siteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae", boardDate: "2026-08-20", boardFilterDate: "2026-08-22", boardView: "month", contextKind: "메일", documentId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21af", riskScreen: "timeline", riskSiteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae", cardId: "card_456", assessmentId: "risk_123", conversationId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21b0", demo: true });
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

/**
 * 시연 모드는 **보는 사람의 설정**이라 다른 필드와 규칙이 다르다.
 *
 * ⑴ 켜는 값만 받는다 — 주소를 손으로 고쳐 `demo=true` 라 적어도 켜지지 않는다. 시연은
 *    명시적으로 켠 사람에게만 켜져야 한다.
 * ⑵ 현장을 바꿔도 유지된다 — 다른 필드들은 "그 현장에서 열어 둔 것" 이지만 이것은 아니다.
 * ⑶ 꺼져 있으면 주소에 남기지 않는다 — 기본값이 주소를 더럽히지 않는다.
 */
test("시연 모드는 끄는 값만 받는다 — 기본이 켜짐이다", () => {
  // **기본이 뒤집혀 있다.** 이 배포는 시연용이라, 켜는 것을 잊은 채 시작하면 첫 반영에서
  // 카드가 사라지고 그 자리에서 되돌릴 방법이 없다. 그래서 끄는 쪽을 명시하게 했다.
  // 시연이 끝나면 이 시험과 `parseConsoleUrlState`·`DEFAULT_CONSOLE_URL_STATE` 를 함께 되돌린다.
  assert.equal(parseConsoleUrlState(new URLSearchParams("demo=0")).demo, false);
  for (const 켜짐 of ["", "demo=1", "demo=true", "demo=on", "demo="]) {
    assert.equal(parseConsoleUrlState(new URLSearchParams(켜짐)).demo, true, 켜짐);
  }
});

test("시연 모드는 현장을 바꿔도 유지된다", () => {
  const 켜둔것 = patchConsoleUrlState(DEFAULT_CONSOLE_URL_STATE, { demo: true, cardId: "card_reeval_crane_radius" });
  const 다른현장 = patchConsoleUrlState(켜둔것, { siteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21af" });
  assert.equal(다른현장.demo, true);
  // 카드는 그 현장의 것이므로 함께 비워진다 — 시연 모드와 성격이 다르다.
  assert.equal(다른현장.cardId, null);
});

test("기본값은 주소에 남기지 않는다 — 끈 것만 적는다", () => {
  assert.equal(new URL(serializeConsoleUrlState(DEFAULT_CONSOLE_URL_STATE), "https://console.test").searchParams.get("demo"), null);
  const 끈것 = patchConsoleUrlState(DEFAULT_CONSOLE_URL_STATE, { demo: false });
  assert.equal(new URL(serializeConsoleUrlState(끈것), "https://console.test").searchParams.get("demo"), "0");
});
