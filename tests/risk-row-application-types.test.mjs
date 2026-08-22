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
  assert.equal(targetDocumentId({ produces: [{ into: "new" }], invalidates: [{ docId: "old" }], trigger: { sourceDocRefs: ["source"] } }), "new");
  assert.equal(targetDocumentId({ produces: [], invalidates: [{ docId: "old" }], trigger: { sourceDocRefs: ["source"] } }), "old");
  assert.equal(targetDocumentId({ produces: [], invalidates: [], trigger: { sourceDocRefs: ["source"] } }), "source");
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
