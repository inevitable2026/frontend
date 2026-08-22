import { createHash } from "node:crypto";
import { getStudioWorkflowIdentity, STUDIO_MANIFEST_SHA } from "./studio-manifest.ts";
import type { StudioIdentity } from "./studio.ts";
import { INGEST_DOCUMENT_KINDS } from "./types.ts";

// v3 separates deployable project identity from a deliberately local-only
// credential scope, and never treats a `model` echo as a config echo.
export const STUDIO_READINESS_SCHEMA_VERSION = 3;

export type StudioLiveReadinessReceipt = {
  schemaVersion: typeof STUDIO_READINESS_SCHEMA_VERSION;
  receiptId: string;
  issuedAt: string;
  expiresAt: string;
  scope: "production-project" | "localhost-development";
  /** Provenance label, never a claimed API account ID for local scope. */
  accountId: string;
  projectIdentity?: { scheme: "api-project-id/v1"; projectId: string; endpoint: string; observedAt: string; requestId?: string };
  credentialScope?: { scheme: "credential-scope/v1"; keyFingerprint: string; inventoryDigest: string; endpoint: string; observedAt: string; requestId?: string };
  topology: "per-kind-agent" | "single-agent-configs";
  physicalStudioSteps: ["document-parse", "information-extract"];
  runtimeOwnership: { studio: ["document-parse", "information-extract"]; application: ["validation", "review"] };
  /** Docs + differential spike prove an explicit request config pin. */
  configPinProof: "documented-explicit-config-pin/v1";
  configPinEvidence: {
    officialDocs: { url: string; sha256: string; retrievedAt: string };
    spike: {
      scheme: "sacrificial-differential-config-pin/v1";
      configAId: string; configBId: string; configCId: string;
      preConfigFingerprint: string; postConfigFingerprint: string;
      aResponse: { agentId: string; initialStatus: "queued" | "in_progress"; stepNames: string[]; status: "completed" };
      bDefaultMutation: { scheme: "config-create-default-observation/v1"; beforeDefaultConfigId: string; afterDefaultConfigId: string; observedVia: "authenticated-agent-get/v1" };
      cDefaultMutation: { scheme: "config-create-default-observation/v1"; beforeDefaultConfigId: string; afterDefaultConfigId: string; responseStatusBeforeMutation: "queued" | "in_progress"; observedVia: "authenticated-agent-get/v1" };
      cleanup: { status: "deleted" }; rollback: { status: "restored" };
    };
  };
  /** The observed response did not echo the selected config. */
  servedConfigEchoVerified: false;
  /** The completed response echoed the provisioned agent ID in `model`. */
  servedAgentVerified: true;
  manifestSha: string;
  outputEnvelopeVersion: "studio-document-envelope/v1";
  responseParserVersion: "studio-response-parser/v2";
  cleanupMigrationVersion: string;
  cleanupMigrationVerified: true;
  sweeper: { healthy: true; checkedAt: string; recoveryPolicy: "cleanup-only-v1" };
  platformBudget: {
    maxDurationMs: number;
    processingDeadlineMs: number;
    cleanupReserveMs: number;
    responseMarginMs: number;
  };
  workflows: Record<
    string,
    {
      agentId: string;
      agentName?: string;
      role?: string;
      configId: string;
      configFingerprint: string;
      servedIdentity: string;
      servedIdentityField: string;
      requestFields: Record<string, unknown>;
    }
  >;
};

export type StudioLiveReadiness =
  | { enabled: true; receipt: StudioLiveReadinessReceipt }
  | {
      enabled: false;
      code: "STUDIO_LIVE_DISABLED";
      /** 화면에 그대로 나가는 문장. 사유마다 서로 다르게 둔다. */
      reason: string;
      /** 화면에 내보내지 않는 원인. 로그·디버깅용. */
      detail: string;
    };

function disabled(reason: string, detail: string): StudioLiveReadiness {
  return { enabled: false, code: "STUDIO_LIVE_DISABLED", reason, detail };
}

const MIN_CLEANUP_RESERVE_MS = 15_000;
const STREAM_MAX_DURATION_MS = 300_000;
const MAX_DOCS_AGE_MS = 24 * 60 * 60_000;
const DEPLOYMENT_DOC_URL = "https://console.upstage.ai/docs/studio/deployment.md";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validIsoDate(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function validHttpsEndpoint(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function validProjectIdentity(value: unknown): boolean {
  const identity = record(value);
  return Boolean(identity && Object.keys(identity).every((key) => ["scheme", "projectId", "endpoint", "observedAt", "requestId"].includes(key)) && identity.scheme === "api-project-id/v1" && nonEmptyString(identity.projectId) && validHttpsEndpoint(identity.endpoint) && validIsoDate(identity.observedAt) && (identity.requestId === undefined || nonEmptyString(identity.requestId)));
}

function validCredentialScope(value: unknown): boolean {
  const scope = record(value);
  return Boolean(scope && Object.keys(scope).every((key) => ["scheme", "keyFingerprint", "inventoryDigest", "endpoint", "observedAt", "requestId"].includes(key)) && scope.scheme === "credential-scope/v1" && /^sha256:[a-f0-9]{64}$/.test(String(scope.keyFingerprint)) && /^sha256:[a-f0-9]{64}$/.test(String(scope.inventoryDigest)) && validHttpsEndpoint(scope.endpoint) && validIsoDate(scope.observedAt) && (scope.requestId === undefined || nonEmptyString(scope.requestId)));
}

function validConfigPinEvidence(value: unknown, issuedAt: unknown): boolean {
  const evidence = record(value); const docs = record(evidence?.officialDocs); const spike = record(evidence?.spike); const response = record(spike?.aResponse); const b = record(spike?.bDefaultMutation); const c = record(spike?.cDefaultMutation); const cleanup = record(spike?.cleanup); const rollback = record(spike?.rollback);
  const issuedAtMs = typeof issuedAt === "string" ? Date.parse(issuedAt) : NaN;
  const retrievedAtMs = typeof docs?.retrievedAt === "string" ? Date.parse(docs.retrievedAt) : NaN;
  return Boolean(
    evidence && Object.keys(evidence).every((key) => ["officialDocs", "spike"].includes(key)) &&
    docs && Object.keys(docs).every((key) => ["url", "sha256", "retrievedAt"].includes(key)) && docs.url === DEPLOYMENT_DOC_URL && /^sha256:[a-f0-9]{64}$/.test(String(docs.sha256)) && validIsoDate(docs.retrievedAt) && Number.isFinite(issuedAtMs) && retrievedAtMs <= issuedAtMs && retrievedAtMs >= issuedAtMs - MAX_DOCS_AGE_MS &&
    spike && Object.keys(spike).every((key) => ["scheme", "configAId", "configBId", "configCId", "preConfigFingerprint", "postConfigFingerprint", "aResponse", "bDefaultMutation", "cDefaultMutation", "cleanup", "rollback"].includes(key)) &&
    spike.scheme === "sacrificial-differential-config-pin/v1" && [spike.configAId, spike.configBId, spike.configCId].every(nonEmptyString) && new Set([spike.configAId, spike.configBId, spike.configCId]).size === 3 && nonEmptyString(spike.preConfigFingerprint) && spike.preConfigFingerprint === spike.postConfigFingerprint &&
    response && Object.keys(response).every((key) => ["agentId", "initialStatus", "stepNames", "status"].includes(key)) && nonEmptyString(response.agentId) && ["queued", "in_progress"].includes(String(response.initialStatus)) && response.status === "completed" && Array.isArray(response.stepNames) && response.stepNames.length === 2 && response.stepNames.every(nonEmptyString) &&
    b && Object.keys(b).every((key) => ["scheme", "beforeDefaultConfigId", "afterDefaultConfigId", "observedVia"].includes(key)) && b.scheme === "config-create-default-observation/v1" && b.beforeDefaultConfigId === spike.configAId && b.afterDefaultConfigId === spike.configBId && b.observedVia === "authenticated-agent-get/v1" &&
    c && Object.keys(c).every((key) => ["scheme", "beforeDefaultConfigId", "afterDefaultConfigId", "responseStatusBeforeMutation", "observedVia"].includes(key)) && c.scheme === "config-create-default-observation/v1" && c.beforeDefaultConfigId === spike.configBId && c.afterDefaultConfigId === spike.configCId && c.responseStatusBeforeMutation === response.initialStatus && c.observedVia === "authenticated-agent-get/v1" &&
    cleanup?.status === "deleted" && rollback?.status === "restored",
  );
}

function validBudget(value: unknown): value is StudioLiveReadinessReceipt["platformBudget"] {
  const budget = record(value);
  if (!budget) return false;
  const maxDurationMs = budget.maxDurationMs;
  const processingDeadlineMs = budget.processingDeadlineMs;
  const cleanupReserveMs = budget.cleanupReserveMs;
  const responseMarginMs = budget.responseMarginMs;
  if (
    typeof maxDurationMs !== "number" ||
    typeof processingDeadlineMs !== "number" ||
    typeof cleanupReserveMs !== "number" ||
    typeof responseMarginMs !== "number" ||
    ![maxDurationMs, processingDeadlineMs, cleanupReserveMs, responseMarginMs].every(
      (part) => Number.isFinite(part) && part > 0,
    )
  ) {
    return false;
  }
  return (
    cleanupReserveMs >= MIN_CLEANUP_RESERVE_MS &&
    maxDurationMs <= STREAM_MAX_DURATION_MS &&
    processingDeadlineMs + cleanupReserveMs + responseMarginMs <= maxDurationMs
  );
}

export function parseStudioLiveReadinessReceipt(raw: string): StudioLiveReadinessReceipt | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const receipt = record(value);
  const sweeper = record(receipt?.sweeper);
  const workflows = record(receipt?.workflows);
  if (
    !receipt ||
    Object.keys(receipt).some((key) => ![
      "schemaVersion",
      "receiptId",
      "issuedAt",
      "expiresAt",
      "scope",
      "accountId",
      "projectIdentity",
      "credentialScope",
      "topology",
      "physicalStudioSteps",
      "runtimeOwnership",
      "configPinProof",
      "configPinEvidence",
      "servedConfigEchoVerified",
      "servedAgentVerified",
      "manifestSha",
      "outputEnvelopeVersion",
      "responseParserVersion",
      "cleanupMigrationVersion",
      "cleanupMigrationVerified",
      "sweeper",
      "platformBudget",
      "workflows",
    ].includes(key)) ||
    receipt.schemaVersion !== STUDIO_READINESS_SCHEMA_VERSION ||
    !nonEmptyString(receipt.receiptId) ||
    !validIsoDate(receipt.issuedAt) ||
    !validIsoDate(receipt.expiresAt) ||
    !["production-project", "localhost-development"].includes(String(receipt.scope)) ||
    !nonEmptyString(receipt.accountId) ||
    (receipt.scope === "localhost-development" && receipt.accountId !== "localhost-development") ||
    (receipt.scope === "production-project" ? !validProjectIdentity(receipt.projectIdentity) || receipt.credentialScope !== undefined : !validCredentialScope(receipt.credentialScope) || receipt.projectIdentity !== undefined) ||
    !["per-kind-agent", "single-agent-configs"].includes(String(receipt.topology)) ||
    JSON.stringify(receipt.physicalStudioSteps) !== JSON.stringify(["document-parse", "information-extract"]) ||
    !record(receipt.runtimeOwnership) ||
    JSON.stringify(record(receipt.runtimeOwnership)?.studio) !== JSON.stringify(["document-parse", "information-extract"]) ||
    JSON.stringify(record(receipt.runtimeOwnership)?.application) !== JSON.stringify(["validation", "review"]) ||
    receipt.configPinProof !== "documented-explicit-config-pin/v1" ||
    !validConfigPinEvidence(receipt.configPinEvidence, receipt.issuedAt) ||
    receipt.servedConfigEchoVerified !== false ||
    receipt.servedAgentVerified !== true ||
    !nonEmptyString(receipt.manifestSha) ||
    receipt.outputEnvelopeVersion !== "studio-document-envelope/v1" ||
    receipt.responseParserVersion !== "studio-response-parser/v2" ||
    !nonEmptyString(receipt.cleanupMigrationVersion) ||
    receipt.cleanupMigrationVerified !== true ||
    !sweeper ||
    sweeper.healthy !== true ||
    sweeper.recoveryPolicy !== "cleanup-only-v1" ||
    !validIsoDate(sweeper.checkedAt) ||
    !validBudget(receipt.platformBudget) ||
    !workflows ||
    Object.keys(workflows).length !== INGEST_DOCUMENT_KINDS.length ||
    INGEST_DOCUMENT_KINDS.some((kind) => !(kind in workflows))
  ) {
    return null;
  }
  for (const kind of INGEST_DOCUMENT_KINDS) {
    const workflow = workflows[kind];
    const item = record(workflow);
    const requestFields = record(item?.requestFields);
    const manifestIdentity = getStudioWorkflowIdentity(kind);
    if (
      !item ||
      Object.keys(item).some((key) => ![
        "agentId",
        "agentName",
        "role",
        "configId",
        "configFingerprint",
        "servedIdentity",
        "servedIdentityField",
        "requestFields",
      ].includes(key)) ||
      !nonEmptyString(item.agentId) ||
      (nonEmptyString(item.agentName) && item.agentName !== manifestIdentity.agentLogicalName) ||
      !nonEmptyString(item.configFingerprint) ||
      !nonEmptyString(item.servedIdentity) ||
      !nonEmptyString(item.servedIdentityField) ||
      item.servedIdentityField !== "model" ||
      !requestFields ||
      Object.keys(requestFields).length !== 1 ||
      requestFields.config_id !== item.configId ||
      !nonEmptyString(item.configId) ||
      item.servedIdentity !== item.agentId
    ) {
      return null;
    }
  }
  return receipt as StudioLiveReadinessReceipt;
}

export function getStudioLiveReadiness(now = Date.now()): StudioLiveReadiness {
  if (process.env.STUDIO_LIVE_INGEST_ENABLED !== "true") {
    return disabled(
      "문서 분석 기능이 꺼져 있습니다. 시스템 담당자에게 문의해 주세요.",
      "STUDIO_LIVE_INGEST_ENABLED is not 'true'.",
    );
  }
  const rawReceipt = process.env.STUDIO_LIVE_READINESS_RECEIPT_JSON;
  if (!rawReceipt) {
    return disabled(
      "문서 분석 사용 승인 정보가 등록되어 있지 않습니다. 시스템 담당자에게 문의해 주세요.",
      "STUDIO_LIVE_READINESS_RECEIPT_JSON is unset.",
    );
  }
  const receipt = parseStudioLiveReadinessReceipt(rawReceipt);
  if (!receipt) {
    return disabled(
      "문서 분석 사용 승인 정보를 읽지 못했습니다. 시스템 담당자에게 문의해 주세요.",
      "Readiness receipt failed schema validation.",
    );
  }
  if (receipt.manifestSha !== STUDIO_MANIFEST_SHA) {
    return disabled(
      "문서 분석 사용 승인 정보가 지금 설치된 버전과 맞지 않습니다. 시스템 담당자에게 문의해 주세요.",
      "Receipt manifestSha does not match the deployed manifest.",
    );
  }
  const requiredMigration = process.env.STUDIO_REQUIRED_CLEANUP_MIGRATION;
  if (!requiredMigration) {
    return disabled(
      "문서 정리 기능의 필수 버전이 서버에 지정되어 있지 않습니다. 시스템 담당자에게 문의해 주세요.",
      "STUDIO_REQUIRED_CLEANUP_MIGRATION is unset.",
    );
  }
  if (receipt.scope === "production-project") {
    const expectedProjectId = process.env.STUDIO_EXPECTED_PROJECT_ID;
    if (!expectedProjectId || receipt.projectIdentity?.projectId !== expectedProjectId) {
      return disabled(
        "문서 분석 서비스 계정이 사용 승인 정보와 다릅니다. 시스템 담당자에게 문의해 주세요.",
        "Receipt projectIdentity does not match STUDIO_EXPECTED_PROJECT_ID.",
      );
    }
  } else if (process.env.NODE_ENV === "production" || process.env.STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED !== "true") {
    return disabled(
      "이 서버에서는 개발용 접속 설정으로 문서를 분석할 수 없습니다. 시스템 담당자에게 문의해 주세요.",
      "localhost credential scope needs an explicit non-production opt-in.",
    );
  } else {
    const key = process.env.UPSTAGE_API_KEY;
    const expectedFingerprint = key ? `sha256:${createHash("sha256").update(key).digest("hex")}` : "";
    if (!expectedFingerprint || receipt.credentialScope?.keyFingerprint !== expectedFingerprint) {
      return disabled(
        "문서 분석 서비스 접속 정보가 사용 승인 정보와 다릅니다. 시스템 담당자에게 문의해 주세요.",
        "Receipt credentialScope keyFingerprint does not match the current key.",
      );
    }
  }
  if (receipt.cleanupMigrationVersion !== requiredMigration) {
    return disabled(
      "문서 정리·삭제 기능이 필수 버전과 다릅니다. 시스템 담당자에게 문의해 주세요.",
      "Receipt cleanupMigrationVersion does not match the required migration.",
    );
  }
  if (
    Date.parse(receipt.issuedAt) > now + 60_000 ||
    Date.parse(receipt.issuedAt) < now - 24 * 60 * 60_000 ||
    Date.parse(receipt.expiresAt) <= now ||
    Date.parse(receipt.sweeper.checkedAt) > now + 60_000 ||
    Date.parse(receipt.sweeper.checkedAt) < now - 15 * 60_000
  ) {
    return disabled(
      "문서 분석 사용 승인 기한이 지났습니다. 시스템 담당자에게 문의해 주세요.",
      "Receipt window or sweeper heartbeat is out of range.",
    );
  }
  return { enabled: true, receipt };
}

export function getStudioIdentityFromReceipt(
  receipt: StudioLiveReadinessReceipt,
  kind: string,
): StudioIdentity | null {
  const workflow = receipt.workflows[kind];
  if (!workflow) return null;
  return {
    agentId: workflow.agentId,
    agentName: workflow.agentName,
    role: workflow.role,
    capabilityReceiptId: receipt.receiptId,
    manifestSha: receipt.manifestSha,
    configFingerprint: workflow.configFingerprint,
    configId: workflow.configId,
    servedIdentity: workflow.servedIdentity,
    servedIdentityField: workflow.servedIdentityField,
    requestFields: workflow.requestFields,
  };
}
