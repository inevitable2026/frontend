import { createHash } from "node:crypto";
import { getStudioWorkflowIdentity, STUDIO_MANIFEST_SHA } from "./studio-manifest.ts";
import type { StudioIdentity } from "./studio.ts";
import { readSweeperHeartbeat, type SweeperProbe } from "./sweeper-health.ts";
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

/**
 * 회수기 하트비트를 몇 분까지 신선하다고 볼 것인가.
 *
 * 예전에 영수증 안에서 쓰던 창과 같은 값이다. 옮긴 것은 **어디서 읽느냐**이지 얼마나
 * 엄격하냐가 아니다. 프로덕션 크론이 5분 주기이므로 두 번을 놓쳐야 막힌다.
 */
const SWEEPER_FRESHNESS_MS = 15 * 60_000;

export async function getStudioLiveReadiness(
  now = Date.now(),
  probe: SweeperProbe = readSweeperHeartbeat,
): Promise<StudioLiveReadiness> {
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
  } else {
    /*
     * 자격 범위(credential-scope) 영수증을 어디서 받아 줄 것인가.
     *
     * 원래는 **프로덕션에서 무조건 거절**했다. 이유가 있다: `api-project-id/v1` 은 영수증을
     * 특정 Studio 프로젝트에 묶어서, 개발 프로젝트로 발급한 영수증이 운영 프로젝트를 열지
     * 못하게 한다. 자격 범위는 그 구분을 못 한다.
     *
     * **그런데 이 계정에는 프로젝트가 없다.** 실측:
     *
     *   GET /v2/agents      에이전트 16개, `project_id` 가 전부 null
     *   GET /v2/projects    404          (/me · /account 도 404)
     *
     * 관측할 project id 가 없으므로 그 증명은 만들 수 없다. 없는 값을 적어 넣으면 게이트가
     * 지키려던 것이 바로 그 자리에서 무너진다.
     *
     * 그래서 통제를 없애지 않고 **같은 모양으로 옮겼다.** `api-project-id` 가 지키던 것은
     * "영수증과 서버가 서로 다른 곳에서 각자 선언한 값이 일치해야 한다" 는 두 겹 구조다.
     * 여기서도 두 겹을 요구한다:
     *
     *   ① 영수증의 `credentialScope.keyFingerprint` 가 **이 서버가 지금 든 키**와 같을 것
     *      — 다른 키로 발급한 영수증은 통하지 않는다
     *   ② 프로덕션이라면 `STUDIO_ALLOW_CREDENTIAL_SCOPE_IN_PRODUCTION` 을 **따로** 켤 것
     *      — 영수증만으로는 절대 열리지 않는다. 사람이 배포 환경에 손으로 켜야 한다
     *
     * 이름을 길게 지은 것은 일부러다. 이 변수가 켜져 있다는 것은 **프로젝트 단위 격리 없이
     * 열려 있다** 는 뜻이고, 환경변수 목록을 보는 사람이 그것을 읽을 수 있어야 한다.
     * 프로젝트가 생기면 `api-project-id/v1` 로 되돌아가고 이 변수를 지운다.
     */
    const 프로덕션 = process.env.NODE_ENV === "production";
    const 열어둠 = 프로덕션
      ? process.env.STUDIO_ALLOW_CREDENTIAL_SCOPE_IN_PRODUCTION === "true"
      : process.env.STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED === "true";
    if (!열어둠) {
      return disabled(
        "이 서버에서는 개발용 접속 설정으로 문서를 분석할 수 없습니다. 시스템 담당자에게 문의해 주세요.",
        프로덕션
          ? "credential scope needs STUDIO_ALLOW_CREDENTIAL_SCOPE_IN_PRODUCTION on a production deployment."
          : "localhost credential scope needs an explicit non-production opt-in.",
      );
    }
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
    Date.parse(receipt.expiresAt) <= now
  ) {
    return disabled(
      "문서 분석 사용 승인 기한이 지났습니다. 시스템 담당자에게 문의해 주세요.",
      "Receipt issue/expiry window is out of range.",
    );
  }

  /*
   * **회수기가 지금 도는지는 영수증에게 묻지 않는다.**
   *
   * 예전에는 `receipt.sweeper.checkedAt` 이 15분 이내인지를 여기서 봤다. 그런데 그 값은
   * 발급 시점에 굳는다 — "그때 살아 있었다" 는 기록이지 "지금 살아 있다" 가 아니다.
   * 게이트가 보증하려는 것은 지금이다: 지금 올린 계약서가 지워질 것인가.
   *
   * 그 결과가 나빴다. 환경변수에 영수증을 넣어 둔 배포는 **15분 뒤 저절로 꺼졌다.**
   * 15분마다 환경변수를 갈아 끼울 수는 없으니, 배포된 곳에서는 사실상 못 켜는 기능이었다.
   *
   * 그래서 갈랐다. 영수증은 **잘 변하지 않는 사실**을 진다 — 에이전트 신원, config 핀,
   * 매니페스트 지문, 정리 마이그레이션 버전. 회수기 생사는 살아 있는 값이므로 매 요청마다
   * 저장소에서 읽는다.
   *
   * **느슨해진 것이 아니다.** 예전에는 한 번 확인하면 그 뒤 회수기가 죽어도 창이 닫힐
   * 때까지 몰랐다. 지금은 회수기가 멎으면 **다음 요청에서 바로 막힌다.**
   */
  const heartbeat = await probe();
  if (!heartbeat) {
    return disabled(
      "문서 정리 기능이 지금 도는지 확인하지 못했습니다. 시스템 담당자에게 문의해 주세요.",
      "Sweeper health row is missing or unreadable.",
    );
  }
  if (heartbeat.recoveryPolicy !== receipt.sweeper.recoveryPolicy) {
    // 영수증은 `cleanup-only-v1` 을 약속했는데 마지막으로 돈 회수기는 그 표식을 남기지
    // 않았다. 무엇이 돌았는지 모르는 상태다.
    return disabled(
      "문서 정리 기능이 승인된 방식으로 돌고 있지 않습니다. 시스템 담당자에게 문의해 주세요.",
      `Sweeper heartbeat policy ${heartbeat.recoveryPolicy ?? "null"} does not match the receipt.`,
    );
  }
  const heartbeatAt = Date.parse(heartbeat.checkedAt);
  if (
    !Number.isFinite(heartbeatAt) ||
    heartbeatAt > now + 60_000 ||
    heartbeatAt < now - SWEEPER_FRESHNESS_MS
  ) {
    return disabled(
      "문서 정리 기능이 멈춰 있습니다. 시스템 담당자에게 문의해 주세요.",
      "Sweeper heartbeat is stale or in the future.",
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
