import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRiskRowReviewConflict,
  parseRiskRowReviewResult,
  parseRiskRowReviewStates,
  reviewResultMatchesCommand,
  reviewAsState,
} from "../tmp/test-dist/lib/risk/row-review-types.js";

const row = {
  itemId: "RI-01", process: "고소작업", hazard: "추락", hazardClass: "추락",
  currentControl: "안전대", risk: { likelihood: 3, severity: 4, score: 12, level: "높음" },
  measures: [{ measureId: "M-01", text: "난간 설치", type: "공학", owner: "현장", dueDate: "2026-08-23", status: "todo" }],
  residualRisk: { likelihood: 1, severity: 4, score: 4, level: "낮음" },
  legalReferences: [{ ref: "산안법", citable: true, note: "" }],
  derivedFrom: { evidenceIds: ["E-01"], contextDocRefs: ["D-01"] },
};
const state = {
  rowId: "RI-01", row, rowFingerprint: "abc", decision: "held", version: 2,
  actor: "console", updatedAt: "2026-08-23T00:00:00.000Z", invalidatedReview: false,
};

test("parses hydrated pending, held, and approved states", () => {
  const pending = { ...state, rowId: "RI-02", row: { ...row, itemId: "RI-02" }, decision: "pending", actor: null, updatedAt: null };
  assert.deepEqual(parseRiskRowReviewStates({ rows: [state, pending] }), [
    state,
    pending,
  ]);
  assert.equal(parseRiskRowReviewStates({ rows: [{ ...state, version: -1 }] }), null);
  assert.equal(parseRiskRowReviewStates({ rows: [{ ...state, row: { ...row, hazard: null } }] }), null);
});

test("reduces a persisted review into authoritative client state", () => {
  const review = {
    siteId: "site", workItemId: "work", rowId: "RI-01", rowFingerprint: "abc",
    decision: "approved", version: 3, actor: "console",
    createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:01:00.000Z",
  };
  assert.deepEqual(reviewAsState(review, row), {
    rowId: "RI-01", row, rowFingerprint: "abc", decision: "approved", version: 3,
    actor: "console", updatedAt: "2026-08-23T00:01:00.000Z", invalidatedReview: false,
  });
});

test("parses idempotent command results and stale conflict hydration", () => {
  const review = {
    siteId: "site", workItemId: "work", rowId: "RI-01", rowFingerprint: "abc",
    decision: "approved", version: 3, actor: "console",
    createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:01:00.000Z",
  };
  assert.deepEqual(parseRiskRowReviewResult({ review, replayed: true }), { review, replayed: true });
  assert.deepEqual(parseRiskRowReviewConflict({
    error: "stale", code: "version_conflict", expectedVersion: 2, actualVersion: 3, current: state,
  }), { error: "stale", code: "version_conflict", expectedVersion: 2, actualVersion: 3, current: state });
  assert.equal(parseRiskRowReviewConflict({ error: "bad", code: "unknown", current: null }), null);
});

test("binds a successful response to the exact submitted command", () => {
  const command = {
    commandId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ab",
    siteId: "site", workItemId: "work", rowId: "RI-01", expectedRowFingerprint: "abc",
    decision: "approved", expectedVersion: 2,
  };
  const result = {
    review: {
      siteId: "site", workItemId: "work", rowId: "RI-01", rowFingerprint: "abc",
      decision: "approved", version: 3, actor: "local-console",
      createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:01:00.000Z",
    },
    replayed: false,
  };
  assert.equal(reviewResultMatchesCommand(result, command), true);
  assert.equal(reviewResultMatchesCommand({ ...result, review: { ...result.review, rowId: "RI-02" } }, command), false);
  assert.equal(reviewResultMatchesCommand({ ...result, review: { ...result.review, version: 4 } }, command), false);
});
