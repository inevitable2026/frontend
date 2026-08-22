import { createHash } from "node:crypto";

import type { RiskRowDraft } from "@/lib/board/types";
import { 대상문서 } from "./doc-target.ts";

export type RiskRowApplicationCommand = {
  commandId: string;
  siteId: string;
  workItemId: string;
  expectedApplicationFingerprint: string | null;
};

export type RiskRowApplicationFactValue = {
  회의록: string;
  행id: string;
  공종분류: string;
  단위작업: string;
  위험요인: string;
  대책: string[];
  개선전: { 빈도: number; 강도: number; 위험도: number };
  개선후: { 빈도: number; 강도: number; 위험도: number };
};

export type RiskRowApplicationResult = {
  commandId: string;
  siteId: string;
  workItemId: string;
  targetDocumentId: string;
  rowIds: string[];
  factIds: number[];
  workItemEventId: number;
  actor: string;
  appliedAt: string;
  replayed: boolean;
};

export type RiskRowApplicationDescriptor = {
  targetDocumentId: string | null;
  applicationFingerprint: string | null;
  eligible: boolean;
  issues: Array<{ code: string; message: string }>;
  rowIds: string[];
};

export const RISK_ROW_APPLICATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertRiskRowApplicationCommand(
  command: RiskRowApplicationCommand,
): asserts command is RiskRowApplicationCommand & { expectedApplicationFingerprint: string } {
  if (!RISK_ROW_APPLICATION_UUID.test(command.commandId) || !RISK_ROW_APPLICATION_UUID.test(command.siteId) || !command.workItemId.trim()) {
    throw new TypeError("commandId, siteId, workItemId 가 올바르지 않습니다.");
  }
  if (typeof command.expectedApplicationFingerprint !== "string" || !/^[0-9a-f]{32}$/i.test(command.expectedApplicationFingerprint)) {
    throw new TypeError("expectedApplicationFingerprint 가 올바르지 않습니다.");
  }
}

/**
 * 반영 대상 문서.
 *
 * 예전에는 **비어 있지 않은 문자열이면 뭐든 통과**시켰고, 그 값이 그대로
 * `key = `${targetDocumentId}#${rowId}`` 와 `source_doc_id` 가 되어 저장됐다. 그래서
 * 「문서 결재 시스템」 같은 모델 출력이 문서 ID 로 DB 에 들어앉았다. 이제 문서 ID 꼴인지
 * 검사한다 — 아니면 `null` 이고, 호출부가 `target_document_missing` 으로 막는다.
 */
export function targetDocumentId(item: {
  produces: Array<{ into?: string }>;
  invalidates: Array<{ docId?: string }>;
  trigger: { sourceDocRefs?: string[] } | null;
}): string | null {
  return 대상문서(item);
}

/** Hash only the immutable material that makes an approved draft safe to apply. */
export function applicationFingerprint(input: {
  siteId: string;
  workItemId: string;
  targetDocumentId: string;
  rows: Array<{
    rowId: string;
    rowFingerprint: string;
    reviewRowFingerprint: string;
    decision: "approved";
    version: number;
  }>;
}): string {
  return createHash("md5").update(JSON.stringify({
    siteId: input.siteId,
    workItemId: input.workItemId,
    targetDocumentId: input.targetDocumentId,
    rows: input.rows.map((row) => ({
      rowId: row.rowId,
      rowFingerprint: row.rowFingerprint,
      reviewRowFingerprint: row.reviewRowFingerprint,
      decision: row.decision,
      version: row.version,
    })),
  })).digest("hex");
}

/** The persisted fact intentionally has no 이행확인: application is not field execution. */
export function toRiskRowApplicationFact(
  row: RiskRowDraft,
  targetDocumentId: string,
): RiskRowApplicationFactValue {
  return {
    회의록: targetDocumentId,
    행id: row.itemId,
    공종분류: row.hazardClass,
    단위작업: row.process,
    위험요인: row.hazard,
    대책: row.measures.map((measure) => measure.text),
    개선전: { 빈도: row.risk.likelihood, 강도: row.risk.severity, 위험도: row.risk.score },
    개선후: {
      빈도: row.residualRisk.likelihood,
      강도: row.residualRisk.severity,
      위험도: row.residualRisk.score,
    },
  };
}
