import type { RiskRowDraft } from "@/lib/board/types";

export const RISK_ROW_REVIEW_DECISIONS = ["held", "approved"] as const;

export type RiskRowReviewDecision = (typeof RISK_ROW_REVIEW_DECISIONS)[number];
export type RiskRowReviewDisplayDecision = "pending" | RiskRowReviewDecision;

export type RiskRowReview = {
  siteId: string;
  workItemId: string;
  rowId: string;
  rowFingerprint: string;
  decision: RiskRowReviewDecision;
  version: number;
  actor: string;
  createdAt: string;
  updatedAt: string;
};

export type RiskRowReviewState = {
  rowId: string;
  row: RiskRowDraft;
  rowFingerprint: string;
  decision: RiskRowReviewDisplayDecision;
  version: number;
  actor: string | null;
  updatedAt: string | null;
  invalidatedReview: boolean;
};

export type RiskRowReviewCommand = {
  commandId: string;
  siteId: string;
  workItemId: string;
  rowId: string;
  expectedRowFingerprint: string;
  decision: RiskRowReviewDecision;
  expectedVersion: number;
};

export type RiskRowReviewCommandResult = {
  review: RiskRowReview;
  replayed: boolean;
};

export type RiskRowReviewConflict = {
  error: string;
  code: "version_conflict" | "row_content_conflict" | "command_reuse" | "approved_locked";
  current: RiskRowReviewState | null;
  expectedVersion?: number;
  actualVersion?: number;
  expectedRowFingerprint?: string;
  actualRowFingerprint?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDecision(value: unknown): value is RiskRowReviewDecision {
  return value === "held" || value === "approved";
}

function isSafeVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRiskScore(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.likelihood === "number" && Number.isFinite(value.likelihood) &&
    typeof value.severity === "number" && Number.isFinite(value.severity) &&
    typeof value.score === "number" && Number.isFinite(value.score) &&
    typeof value.level === "string";
}

export function isRiskRowDraft(value: unknown): value is RiskRowDraft {
  if (!isRecord(value)) return false;
  return (
    typeof value.itemId === "string" && value.itemId.length > 0 &&
    typeof value.process === "string" && typeof value.hazard === "string" &&
    typeof value.hazardClass === "string" && typeof value.currentControl === "string" &&
    isRiskScore(value.risk) && isRiskScore(value.residualRisk) &&
    Array.isArray(value.measures) && value.measures.every((measure) =>
      isRecord(measure) && typeof measure.measureId === "string" && typeof measure.text === "string" &&
      typeof measure.type === "string" && typeof measure.owner === "string" &&
      typeof measure.dueDate === "string" && typeof measure.status === "string"
    ) &&
    Array.isArray(value.legalReferences) && value.legalReferences.every((reference) =>
      isRecord(reference) && typeof reference.ref === "string" && typeof reference.citable === "boolean" &&
      typeof reference.note === "string"
    ) &&
    isRecord(value.derivedFrom) && isStringArray(value.derivedFrom.evidenceIds) &&
    isStringArray(value.derivedFrom.contextDocRefs)
  );
}

export function isRiskRowReviewState(value: unknown): value is RiskRowReviewState {
  if (!isRecord(value)) return false;
  return (
    typeof value.rowId === "string" && value.rowId.length > 0 &&
    isRiskRowDraft(value.row) && value.row.itemId === value.rowId &&
    typeof value.rowFingerprint === "string" && value.rowFingerprint.length > 0 &&
    (value.decision === "pending" || isDecision(value.decision)) &&
    isSafeVersion(value.version) &&
    (value.actor === null || typeof value.actor === "string") &&
    (value.updatedAt === null || typeof value.updatedAt === "string") &&
    typeof value.invalidatedReview === "boolean"
  );
}

export function parseRiskRowReviewStates(value: unknown): RiskRowReviewState[] | null {
  if (!isRecord(value) || !Array.isArray(value.rows) || !value.rows.every(isRiskRowReviewState)) return null;
  return value.rows;
}

export function parseRiskRowReviewResult(value: unknown): RiskRowReviewCommandResult | null {
  if (!isRecord(value) || !isRecord(value.review) || typeof value.replayed !== "boolean") return null;
  const review = value.review;
  if (
    typeof review.siteId !== "string" || typeof review.workItemId !== "string" ||
    typeof review.rowId !== "string" || typeof review.rowFingerprint !== "string" ||
    !isDecision(review.decision) || !isSafeVersion(review.version) ||
    typeof review.actor !== "string" || typeof review.createdAt !== "string" ||
    typeof review.updatedAt !== "string"
  ) {
    return null;
  }
  return { review: review as RiskRowReview, replayed: value.replayed };
}

export function reviewResultMatchesCommand(
  result: RiskRowReviewCommandResult,
  command: RiskRowReviewCommand,
): boolean {
  const review = result.review;
  return (
    review.siteId === command.siteId && review.workItemId === command.workItemId &&
    review.rowId === command.rowId && review.rowFingerprint === command.expectedRowFingerprint &&
    review.decision === command.decision && review.version === command.expectedVersion + 1
  );
}

export function parseRiskRowReviewConflict(value: unknown): RiskRowReviewConflict | null {
  if (!isRecord(value) || typeof value.error !== "string") return null;
  if (
    value.code !== "version_conflict" && value.code !== "row_content_conflict" &&
    value.code !== "command_reuse" && value.code !== "approved_locked"
  ) {
    return null;
  }
  if (value.current !== null && value.current !== undefined && !isRiskRowReviewState(value.current)) return null;
  const current = value.current === null || value.current === undefined ? null : value.current;
  return {
    error: value.error,
    code: value.code,
    current,
    ...(isSafeVersion(value.expectedVersion) ? { expectedVersion: value.expectedVersion } : {}),
    ...(isSafeVersion(value.actualVersion) ? { actualVersion: value.actualVersion } : {}),
    ...(typeof value.expectedRowFingerprint === "string" ? { expectedRowFingerprint: value.expectedRowFingerprint } : {}),
    ...(typeof value.actualRowFingerprint === "string" ? { actualRowFingerprint: value.actualRowFingerprint } : {}),
  };
}

export function reviewAsState(review: RiskRowReview, row: RiskRowDraft): RiskRowReviewState {
  return {
    rowId: review.rowId,
    row,
    rowFingerprint: review.rowFingerprint,
    decision: review.decision,
    version: review.version,
    actor: review.actor,
    updatedAt: review.updatedAt,
    invalidatedReview: false,
  };
}
