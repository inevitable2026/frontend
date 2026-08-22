import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveIngestDeadlines,
  studioFailureAccounting,
} from "../tmp/test-dist/lib/context/ingest-execution.js";
import { StudioError } from "../tmp/test-dist/lib/context/studio.js";

test("keeps cleanup state and call totals when Studio fails", () => {
  const error = new StudioError("REMOTE_CLEANUP_INCOMPLETE", "cleanup failed", undefined, {
    agent: { id: "agent-1", name: "sitectx-gatea-20260822-general", role: "general" },
    fileId: "file-sensitive-not-exposed",
    responseId: "response-1",
    provenance: {
      manifestSha: "manifest",
      configFingerprint: "fingerprint",
      requestedConfigId: "config-1",
      boundByReceipt: { id: "receipt-1", scheme: "request-config-id-v1" },
      servedConfigEchoVerified: false,
      agentId: "agent-1",
      responseId: "response-1",
      servedIdentity: "config-1",
      stepNames: ["parse", "extract_기타", "validate_기타", "review_기타"],
    },
    cleanup: { status: "failed", attempts: 4 },
    metrics: { logicalCalls: 6, physicalAttempts: 9, retries: 3, operations: [] },
  });

  const accounted = studioFailureAccounting(error);
  assert.equal(accounted.calls, 6);
  assert.equal(accounted.execution.cleanup, "failed");
  assert.equal(accounted.execution.responseId, "response-1");
  assert.equal(accounted.execution.requestedConfigId, "config-1");
  assert.deepEqual(accounted.execution.boundByReceipt, { id: "receipt-1", scheme: "request-config-id-v1" });
  assert.equal(accounted.execution.servedConfigEchoVerified, false);
  assert.equal("config" in accounted.execution, false);
  assert.equal("fileId" in accounted.execution, false);
  assert.equal("validation" in accounted.execution, false);
  assert.equal("review" in accounted.execution, false);
});

test("anchors processing, cleanup, and response windows to one host deadline", () => {
  const startedAt = 1_000_000;
  const deadlines = deriveIngestDeadlines({
    platformBudget: {
      maxDurationMs: 90_000,
      processingDeadlineMs: 55_000,
      cleanupReserveMs: 20_000,
      responseMarginMs: 10_000,
    },
  }, startedAt);

  assert.deepEqual(deadlines, {
    hostDeadline: startedAt + 90_000,
    processingDeadline: startedAt + 55_000,
    cleanupDeadline: startedAt + 80_000,
  });
  assert.equal(deadlines.cleanupDeadline + 10_000, deadlines.hostDeadline);
  assert.ok(deadlines.processingDeadline + 20_000 <= deadlines.cleanupDeadline);
});
