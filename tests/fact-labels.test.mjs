import assert from "node:assert/strict";
import test from "node:test";
import { 근거상태이름, 문서갈래이름 } from "../tmp/test-dist/lib/board/fact-labels.js";

/**
 * 이 표의 값어치는 **모르는 값을 지어내지 않는 것**에 있다.
 *
 * 팩트 안의 영어 코드가 화면 문장에 그대로 붙어 나가던 것을 사람 말로 바꾸는 표인데,
 * 표에 없는 값에 그럴듯한 한국어를 붙이면 그건 누수보다 나쁘다 — 읽는 사람이 뜻을 알
 * 수 없는 것과, 틀린 뜻을 사실로 읽는 것은 다르다.
 */

test("아는 값은 사람 말로 바꾼다", () => {
  assert.equal(근거상태이름("OK"), "근거 정상");
  assert.equal(근거상태이름("DEGRADED"), "근거 흔들림");
  assert.equal(문서갈래이름("email"), "메일");
  assert.equal(문서갈래이름("attachment"), "첨부");
  assert.equal(문서갈래이름("reviewComment"), "검토 의견");
  assert.equal(문서갈래이름("officialNotice"), "공문");
});

test("모르는 값은 그대로 둔다 — 지어내지 않는다", () => {
  assert.equal(근거상태이름("PARTIAL"), "PARTIAL");
  assert.equal(문서갈래이름("voicememo"), "voicememo");
});

test("빈 값은 붙이지 않는다", () => {
  // 문장에 이어붙이는 자리라 빈 문자열을 주면 「… · · …」 처럼 구분자가 겹친다.
  for (const 값 of [null, undefined, ""]) {
    assert.equal(근거상태이름(값), null);
    assert.equal(문서갈래이름(값), null);
  }
});

test("근거 상태는 대소문자를 가리지 않는다", () => {
  // 감지 규칙이 `originState.toUpperCase()` 로 비교한다(`t07-score-gap.ts`).
  // 표시 쪽만 대소문자를 따지면 같은 값이 한 화면에서 두 가지로 보인다.
  assert.equal(근거상태이름("degraded"), "근거 흔들림");
  assert.equal(근거상태이름("ok"), "근거 정상");
});
