import { StudioError, type StudioWorkflowResult } from "./studio.ts";
import type { StudioLiveReadinessReceipt } from "./live-readiness.ts";
import type { IngestExecution } from "./types.ts";

/**
 * All times are absolute monotonic-wall-clock values anchored once by the
 * stream owner.  Processing never borrows the response or cleanup windows.
 */
export type IngestDeadlines = {
  hostDeadline: number;
  processingDeadline: number;
  cleanupDeadline: number;
};

export function deriveIngestDeadlines(
  receipt: StudioLiveReadinessReceipt,
  startedAt = Date.now(),
): IngestDeadlines {
  const { maxDurationMs, processingDeadlineMs, responseMarginMs, cleanupReserveMs } = receipt.platformBudget;
  const hostDeadline = startedAt + maxDurationMs;
  const processingDeadline = Math.min(
    startedAt + processingDeadlineMs,
    hostDeadline - responseMarginMs - cleanupReserveMs,
  );
  const cleanupDeadline = hostDeadline - responseMarginMs;
  if (
    processingDeadline <= startedAt ||
    cleanupDeadline <= processingDeadline ||
    hostDeadline <= cleanupDeadline
  ) {
    throw new StudioError(
      "HOST_BUDGET_INVALID",
      "문서 분석 시간 배분이 잘못 설정되어 있습니다. 시스템 담당자에게 문의해 주세요.",
    );
  }
  return { hostDeadline, processingDeadline, cleanupDeadline };
}

export function studioExecutionFromWorkflow(workflow: StudioWorkflowResult): IngestExecution {
  return {
    mode: "studio",
    source: "실데이터",
    agent: workflow.agent.name,
    agentId: workflow.provenance.agentId,
    requestedConfigId: workflow.provenance.requestedConfigId,
    boundByReceipt: workflow.provenance.boundByReceipt,
    servedConfigEchoVerified: workflow.provenance.servedConfigEchoVerified,
    fingerprint: workflow.provenance.configFingerprint,
    manifestSha: workflow.provenance.manifestSha,
    responseId: workflow.provenance.responseId,
    servedIdentity: workflow.provenance.servedIdentity,
    steps: workflow.provenance.stepNames,
    cleanup: workflow.cleanup.status,
    validation: { owner: "application", valid: workflow.validation.valid, issueCount: workflow.validation.issues.length },
    review: {
      owner: "application",
      decision: workflow.review.decision,
      issueCount: workflow.review.issues.length,
      evidenceCount: workflow.review.evidence.length,
    },
  };
}

export function studioFailureAccounting(error: unknown): {
  calls: number;
  execution?: IngestExecution;
} {
  if (!(error instanceof StudioError) || !error.failure) return { calls: 0 };
  const failure = error.failure;
  return {
    calls: failure.metrics.logicalCalls,
    execution: {
      mode: "studio",
      source: "실데이터",
      agent: failure.agent.name,
      agentId: failure.provenance.agentId,
      requestedConfigId: failure.provenance.requestedConfigId,
      boundByReceipt: failure.provenance.boundByReceipt,
      servedConfigEchoVerified: failure.provenance.servedConfigEchoVerified,
      fingerprint: failure.provenance.configFingerprint,
      manifestSha: failure.provenance.manifestSha,
      responseId: failure.responseId,
      servedIdentity: failure.provenance.servedIdentity,
      steps: failure.provenance.stepNames,
      cleanup: failure.cleanup.status,
    },
  };
}
