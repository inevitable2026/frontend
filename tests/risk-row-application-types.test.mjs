import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationFingerprint,
  assertRiskRowApplicationCommand,
  targetDocumentId,
  toRiskRowApplicationFact,
} from "../tmp/test-dist/lib/risk/row-application-types.js";

const row = {
  itemId: "RI-01", process: "고소작업", hazard: "추락", hazardClass: "철골",
  currentControl: "안전대", risk: { likelihood: 3, severity: 4, score: 12, level: "높음" },
  measures: [{ measureId: "M-01", text: "난간 설치", type: "공학", owner: "현장", dueDate: "2026-08-23", status: "todo" }],
  residualRisk: { likelihood: 1, severity: 4, score: 4, level: "낮음" },
  legalReferences: [], derivedFrom: { evidenceIds: [], contextDocRefs: [] },
};

test("derives the target document in the UI's documented priority order", () => {
  // 자리표시자를 실제 문서 꼴로 바꿨다. `lib/risk/doc-target.ts` 가 이제 문서 ID 인지
  // 검사하기 때문이다 — "new"·"old" 같은 값은 실제 문서 식별자 중 하나도 그런 모양이
  // 아니고, 그 관대함이 「문서 결재 시스템」 같은 모델 출력을 DB 에 들여보냈다.
  // 우선순위 자체는 그대로다.
  assert.equal(targetDocumentId({ produces: [{ into: "ra_draft_20260819" }], invalidates: [{ docId: "ra_2026_07_regular" }], trigger: { sourceDocRefs: ["nm_20260818_01"] } }), "ra_draft_20260819");
  assert.equal(targetDocumentId({ produces: [], invalidates: [{ docId: "ra_2026_07_regular" }], trigger: { sourceDocRefs: ["nm_20260818_01"] } }), "ra_2026_07_regular");
  assert.equal(targetDocumentId({ produces: [], invalidates: [], trigger: { sourceDocRefs: ["nm_20260818_01"] } }), "nm_20260818_01");
});

test("모델이 지은 문구는 반영 대상 문서가 되지 못한다", () => {
  // 이 값이 통과하면 `key = `${targetDocumentId}#${rowId}`` 로 저장돼, 존재하지 않는
  // 문서에 행이 붙는다. 실제로 프로덕션 34행 중 7행이 그렇게 붙어 있었다.
  assert.equal(targetDocumentId({ produces: [{ into: "문서 결재 시스템" }], invalidates: [], trigger: null }), null);
  assert.equal(targetDocumentId({ produces: [{ into: "카드 c_approval_ra_minutes_20260820" }], invalidates: [], trigger: null }), null);
  // null 이면 호출부가 target_document_missing 으로 막는다.
});

test("maps the meeting draft exactly to an assessment fact without execution confirmation", () => {
  assert.deepEqual(toRiskRowApplicationFact(row, "ra_draft"), {
    회의록: "ra_draft", 행id: "RI-01", 공종분류: "철골", 단위작업: "고소작업", 위험요인: "추락", 대책: ["난간 설치"],
    개선전: { 빈도: 3, 강도: 4, 위험도: 12 }, 개선후: { 빈도: 1, 강도: 4, 위험도: 4 },
  });
});

test("fingerprint is deterministic and binds ordered current row fingerprints", () => {
  const input = {
    siteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae", workItemId: "card", targetDocumentId: "ra",
    rows: [{ rowId: "RI-01", rowFingerprint: "a", reviewRowFingerprint: "a", decision: "approved", version: 1 }],
  };
  assert.equal(applicationFingerprint(input), applicationFingerprint(input));
  assert.notEqual(applicationFingerprint(input), applicationFingerprint({ ...input, rows: [{ ...input.rows[0], version: 2 }] }));
  assert.doesNotThrow(() => assertRiskRowApplicationCommand({ commandId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ab", siteId: input.siteId, workItemId: "card", expectedApplicationFingerprint: "a".repeat(32) }));
  assert.throws(() => assertRiskRowApplicationCommand({ commandId: "bad", siteId: input.siteId, workItemId: "card", expectedApplicationFingerprint: "a".repeat(32) }));
});
