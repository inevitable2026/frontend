import assert from "node:assert/strict";
import test from "node:test";
import { 대상문서, 무효문서, 문서키인가 } from "../tmp/test-dist/lib/risk/doc-target.js";

/**
 * 여기 적힌 값들은 **프로덕션에서 실제로 관측한 것**이다. 통과해야 하는 쪽은 이 시스템의
 * 문서 식별자 전부이고, 막아야 하는 쪽은 모델이 지어내 DB 에 저장돼 버린 값들이다
 * (`riskAssessmentRow` 34행 중 7행이 아래 가짜에 붙어 있었다).
 */

const 진짜문서 = [
  "ra_2026_08_regular",
  "ra_2026_07_regular",
  "ra_2026_06_regular",
  "ra_draft_20260819",
  "tbm_20260818_pour",
  "council_20260819",
  "nm_20260818_01",
  "notice_20260818_molab",
  "rev_gamri",
  "edu_20260805_new",
  "nearmiss_ledger_2026q3",
  "doc_2_k3f9x1qm",
];

const 모델이지은것 = [
  "문서 결재 시스템",
  "아차사고 대장",
  "감독기관 제출 자료 패키지",
  "카드 c_approval_ra_minutes_20260820",
  "카드 c_tbm_pre_t07",
  "4F 슬래브 거푸집·동바리 자재변경 위험성평가 회의록",
  "4F A~C열 강관동바리(φ48.6×3.2t·4단) 설치상태 확인 기록",
  // 마디가 하나뿐이다. 실제 문서 중 그런 모양은 하나도 없다.
  "record",
];

function 카드(덮어쓰기 = {}) {
  return { produces: [], invalidates: [], trigger: null, ...덮어쓰기 };
}

test("이 시스템의 실제 문서 식별자는 전부 통과한다", () => {
  for (const 키 of 진짜문서) {
    assert.equal(문서키인가(키), true, `${키} 를 막았다`);
  }
});

test("모델이 지은 값은 전부 막는다", () => {
  for (const 값 of 모델이지은것) {
    assert.equal(문서키인가(값), false, `${값} 를 통과시켰다`);
  }
});

test("빈 값·공백·숫자는 문서가 아니다", () => {
  for (const 값 of ["", "   ", null, undefined, 42, {}, ["ra_2026_08_regular"]]) {
    assert.equal(문서키인가(값), false);
  }
});

test("produces.into 가 invalidates 보다 먼저다", () => {
  // card_ra_draft_3rows 에서 겪은 것. 무효화 대상을 열면 0행이 뜨고 화면이 "읽지
  // 못했습니다" 라고 말한다. 읽지 못한 게 아니라 엉뚱한 문서를 연 것이었다.
  const item = 카드({
    produces: [{ into: "ra_draft_20260819" }],
    invalidates: [{ docId: "ra_2026_07_regular" }],
  });
  assert.equal(대상문서(item), "ra_draft_20260819");
});

test("앞 후보가 지어낸 값이면 버리고 다음 후보를 쓴다", () => {
  // 지어낸 값 하나 때문에 멀쩡한 다음 후보까지 버릴 이유가 없다.
  const item = 카드({
    produces: [{ into: "카드 c_approval_ra_minutes_20260820" }],
    invalidates: [{ docId: "ra_2026_08_regular" }],
  });
  assert.equal(대상문서(item), "ra_2026_08_regular");
});

test("후보가 전부 지어낸 값이면 null 이다 — 없는 문서를 열지 않는다", () => {
  const item = 카드({
    produces: [{ into: "문서 결재 시스템" }],
    invalidates: [{ docId: "아차사고 대장" }],
    trigger: { sourceDocRefs: ["record"] },
  });
  assert.equal(대상문서(item), null);
});

test("고를 것이 없으면 null 이다", () => {
  assert.equal(대상문서(카드()), null);
  assert.equal(대상문서(카드({ produces: null, invalidates: null })), null);
});

test("trigger.sourceDocRefs 는 마지막 차례다", () => {
  const item = 카드({ trigger: { sourceDocRefs: ["nm_20260818_01"] } });
  assert.equal(대상문서(item), "nm_20260818_01");
});

test("무효문서에도 같은 검사를 건다", () => {
  assert.equal(무효문서(카드({ invalidates: [{ docId: "ra_2026_07_regular" }] })), "ra_2026_07_regular");
  assert.equal(무효문서(카드({ invalidates: [{ docId: "아차사고 대장" }] })), null);
  assert.equal(무효문서(카드()), null);
});

test("세 화면이 같은 답을 낸다", () => {
  // 예전에는 대기열이 produces.into 를 보고 태스크 보드는 안 봐서, 같은 카드가 화면마다
  // 다른 문서를 열었다 — 실측 19장. 이제 셋 다 이 함수를 부른다.
  const item = 카드({
    produces: [{ into: "ra_draft_20260819" }],
    invalidates: [{ docId: "ra_2026_07_regular" }],
    trigger: { sourceDocRefs: ["nm_20260818_01"] },
  });
  const 답 = 대상문서(item);
  assert.equal(답, "ra_draft_20260819");
  assert.notEqual(답, 무효문서(item));
});
