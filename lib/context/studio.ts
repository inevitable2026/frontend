import type { DocumentKind, LayoutElement } from "./types.ts";
import { StudioRunMetrics, type StudioOperation } from "./studio-metrics.ts";
import { parseStudioWorkflowResponse, StudioParseError, type ParsedStudioWorkflow } from "./studio-parser.ts";

const UPSTAGE_BASE = "https://api.upstage.ai/v2";
const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 1_500;

export class StudioError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message = code,
    readonly cause?: unknown,
    readonly failure?: StudioWorkflowFailure,
  ) {
    super(message);
    this.name = "StudioError";
    this.code = code;
  }
}
export { StudioParseError };

export type StudioAgent = { id: string; name: string; role: string };
export type StudioCleanupStatus = "not_started" | "deleted" | "pending" | "failed";
export type StudioIdentity = {
  agentId: string;
  agentName?: string;
  role?: string;
  /** A verified immutable binding/config capability receipt, never an operator label. */
  capabilityReceiptId: string;
  manifestSha: string;
  configFingerprint: string;
  configId?: string;
  /** Capability-proven response field and expected value for immutable served identity. */
  servedIdentity: string;
  servedIdentityField: string;
  /** Account-proven request fields, e.g. `{ config_id: "..." }`; passed through without guessing API fields. */
  requestFields: Record<string, unknown>;
};
export type StudioWorkflowOptions = {
  deadline: number;
  identity: StudioIdentity;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  metrics?: StudioRunMetrics;
  /** Absolute host-owned deadline for DELETE retries; must be after `deadline`. */
  cleanupDeadline: number;
  /** Durable lifecycle checkpoints. Each callback must finish before the next upstream operation. */
  lifecycle?: {
    onFileUploaded?: (fileId: string) => Promise<void>;
    onResponseCreated?: (responseId: string) => Promise<void>;
    /** Invoked only after the completed response's identity has been verified. */
    onServedIdentityValidated?: (servedIdentity: string) => Promise<void>;
    onCleanup?: (cleanup: { status: StudioCleanupStatus; attempts: number }) => Promise<void>;
    assertActive?: () => Promise<void>;
  };
};
export type StudioWorkflowProvenance = {
  manifestSha: string;
  configFingerprint: string;
  /** Config sent in the request; the response did not echo or attest to it. */
  requestedConfigId?: string;
  /** Immutable request binding established by the readiness receipt. */
  boundByReceipt: { id: string; scheme: "request-config-id-v1" };
  /** The observed response shape has no config echo to verify. */
  servedConfigEchoVerified: false;
  agentId: string;
  responseId: string;
  /** Agent identity observed in the response, verified independently of config. */
  servedIdentity?: string;
  stepNames: string[];
};
export type StudioWorkflowResult = {
  agent: StudioAgent; jobId: string; fileId: string; elements: LayoutElement[]; fullText: string; pageCount: number;
  parse: ParsedStudioWorkflow["parse"];
  extracted: ParsedStudioWorkflow["extracted"];
  validation: ParsedStudioWorkflow["validation"];
  review: ParsedStudioWorkflow["review"];
  provenance: StudioWorkflowProvenance; metrics: ReturnType<StudioRunMetrics["snapshot"]>;
  cleanup: { status: StudioCleanupStatus; attempts: number };
};
export type StudioWorkflowFailure = {
  agent: StudioAgent;
  fileId?: string;
  responseId?: string;
  provenance: Omit<StudioWorkflowProvenance, "responseId" | "stepNames"> & {
    responseId?: string;
    stepNames: string[];
  };
  cleanup: { status: StudioCleanupStatus; attempts: number };
  metrics: ReturnType<StudioRunMetrics["snapshot"]>;
};

function apiKey(): string {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new StudioError("API_KEY_MISSING", "UPSTAGE_API_KEY 가 없습니다.");
  return key;
}
function headers(json = true): Record<string, string> {
  const value: Record<string, string> = { Authorization: `Bearer ${apiKey()}` };
  if (json) value["Content-Type"] = "application/json";
  return value;
}
function remaining(now: () => number, deadline: number): number {
  return deadline - now();
}
function retryableStatus(status: number): boolean { return status === 408 || status === 409 || status === 429 || status >= 500; }
function retryDelay(response: Response | undefined, attempt: number, remainingMs: number): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  const requested = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : Math.min(5_000, 250 * 2 ** attempt);
  return Math.max(0, Math.min(requested, Math.max(0, remainingMs - 1)));
}
async function boundedSleep(
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  deadline: number,
  requestedMs: number,
): Promise<void> {
  const left = remaining(now, deadline);
  if (left <= 0) throw new StudioError("DEADLINE_EXCEEDED");
  const delay = Math.max(0, Math.min(requestedMs, left - 1));
  if (delay === 0) return;
  await sleep(delay);
}
function verifiedIdentity(identity: StudioIdentity): StudioIdentity {
  const value = identity;
  const requestFields = value.requestFields && typeof value.requestFields === "object" && !Array.isArray(value.requestFields)
    ? Object.keys(value.requestFields)
    : [];
  if (
    !value.agentId ||
    !value.capabilityReceiptId ||
    !value.manifestSha ||
    !value.configFingerprint ||
    !value.servedIdentity ||
    !value.servedIdentityField ||
    requestFields.length === 0 ||
    requestFields.some((field) => !["config_id", "config_external_id", "revision_id", "version_id"].includes(field))
  ) {
    throw new StudioError("IDENTITY_UNVERIFIED", "검증된 불변 Studio 워크플로우 바인딩이 필요합니다.");
  }
  return value;
}

async function boundedFetch(fetchImpl: typeof fetch, now: () => number, deadline: number, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const budget = remaining(now, deadline);
  if (budget <= 0) throw new StudioError("DEADLINE_EXCEEDED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budget);
  try { return await fetchImpl(input, { ...init, signal: controller.signal }); }
  catch (cause) { if (controller.signal.aborted) throw new StudioError("DEADLINE_EXCEEDED", "Studio 요청 시간이 초과되었습니다.", cause); throw new StudioError("NETWORK_ERROR", "Studio 네트워크 요청에 실패했습니다.", cause); }
  finally { clearTimeout(timeout); }
}

async function requestWithRetry(
  operation: StudioOperation, method: "GET" | "DELETE", url: string, init: RequestInit, options: Required<Pick<StudioWorkflowOptions, "fetch" | "now" | "sleep">>, deadline: number, metrics: StudioRunMetrics,
): Promise<Response> {
  const metric = metrics.begin(operation); let attempts = 0; let lastStatus: number | undefined; let retryReason: string | undefined;
  try {
    for (;;) {
      attempts++;
      try {
        const response = await boundedFetch(options.fetch, options.now, deadline, url, { ...init, method, cache: "no-store" });
        lastStatus = response.status;
        if (response.ok || !retryableStatus(response.status) || attempts > MAX_RETRIES || remaining(options.now, deadline) <= 0) return response;
        retryReason = `HTTP_${response.status}`;
        await boundedSleep(options.sleep, options.now, deadline, retryDelay(response, attempts - 1, remaining(options.now, deadline)));
      } catch (error) {
        if (!(error instanceof StudioError) || error.code === "DEADLINE_EXCEEDED" || attempts > MAX_RETRIES || remaining(options.now, deadline) <= 0) throw error;
        retryReason = error.code;
        await boundedSleep(options.sleep, options.now, deadline, retryDelay(undefined, attempts - 1, remaining(options.now, deadline)));
      }
    }
  } finally { metric.finish({ attempts, retries: Math.max(0, attempts - 1), status: lastStatus, retryReason }); }
}

async function json(response: Response, errorCode: string): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StudioError(errorCode);
  return value as Record<string, unknown>;
}
async function postOnce(operation: StudioOperation, url: string, init: RequestInit, options: Required<Pick<StudioWorkflowOptions, "fetch" | "now">>, deadline: number, metrics: StudioRunMetrics): Promise<Response> {
  const metric = metrics.begin(operation);
  try { const response = await boundedFetch(options.fetch, options.now, deadline, url, { ...init, method: "POST", cache: "no-store" }); metric.finish({ status: response.status }); return response; }
  catch (error) { metric.finish(); throw error; }
}
async function assertOk(response: Response, code: string): Promise<void> {
  if (!response.ok) throw new StudioError(code, `${code} (${response.status})`);
}

async function uploadFile(bytes: Uint8Array, filename: string, mime: string, options: Required<Pick<StudioWorkflowOptions, "fetch" | "now">>, deadline: number, metrics: StudioRunMetrics): Promise<string> {
  const form = new FormData(); form.append("purpose", "user_data"); form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), filename);
  const response = await postOnce("files.upload", `${UPSTAGE_BASE}/files`, { headers: headers(false), body: form }, options, deadline, metrics); await assertOk(response, "FILE_UPLOAD_FAILED");
  const body = await json(response, "FILE_UPLOAD_INVALID"); if (typeof body.id !== "string") throw new StudioError("FILE_UPLOAD_INVALID"); return body.id;
}
function isReadyFileMetadata(body: Record<string, unknown>, fileId: string): boolean {
  return !Object.hasOwn(body, "status") &&
    body.id === fileId &&
    typeof body.bytes === "number" && Number.isFinite(body.bytes) && body.bytes >= 0 &&
    typeof body.created_at === "number" && Number.isFinite(body.created_at) &&
    (body.expires_at === null || (typeof body.expires_at === "number" && Number.isFinite(body.expires_at))) &&
    body.object === "file" &&
    typeof body.purpose === "string" && body.purpose.length > 0;
}
async function waitForFile(fileId: string, options: Required<Pick<StudioWorkflowOptions, "fetch" | "now" | "sleep">>, deadline: number, metrics: StudioRunMetrics): Promise<void> {
  while (remaining(options.now, deadline) > 0) {
    const response = await requestWithRetry("files.readiness", "GET", `${UPSTAGE_BASE}/files/${encodeURIComponent(fileId)}`, { headers: headers(false) }, options, deadline, metrics);
    if (response.status === 409) { await boundedSleep(options.sleep, options.now, deadline, POLL_INTERVAL_MS); continue; }
    await assertOk(response, "FILE_READINESS_FAILED"); const body = await json(response, "FILE_READINESS_INVALID"); const status = typeof body.status === "string" ? body.status.toLowerCase() : "";
    if (["ready", "completed", "uploaded"].includes(status)) return;
    if (isReadyFileMetadata(body, fileId)) return;
    if (["failed", "cancelled", "expired"].includes(status)) throw new StudioError("FILE_NOT_READY_FAILED");
    if (status === "processing" || status === "pending" || status === "queued" || !status) { await boundedSleep(options.sleep, options.now, deadline, POLL_INTERVAL_MS); continue; }
    throw new StudioError("FILE_NOT_READY_UNKNOWN");
  }
  throw new StudioError("FILE_NOT_READY_TIMEOUT");
}
async function deleteFile(fileId: string, options: Required<Pick<StudioWorkflowOptions, "fetch" | "now" | "sleep">>, cleanupDeadline: number, metrics: StudioRunMetrics): Promise<{ status: StudioCleanupStatus; attempts: number }> {
  try {
    const response = await requestWithRetry("files.delete", "DELETE", `${UPSTAGE_BASE}/files/${encodeURIComponent(fileId)}`, { headers: headers(false) }, options, cleanupDeadline, metrics);
    const operation = metrics.snapshot().operations.at(-1);
    return {
      status: response.ok || response.status === 404 ? "deleted" : "failed",
      attempts: operation?.operation === "files.delete" ? operation.attempts : 1,
    };
  } catch {
    const operation = metrics.snapshot().operations.at(-1);
    return {
      status: remaining(options.now, cleanupDeadline) <= 0 ? "pending" : "failed",
      attempts: operation?.operation === "files.delete" ? operation.attempts : 1,
    };
  }
}

export async function runStudioWorkflow(kind: DocumentKind, bytes: Uint8Array, filename: string, mime: string, supplied: StudioWorkflowOptions): Promise<StudioWorkflowResult> {
  const options = { fetch: supplied.fetch ?? fetch, now: supplied.now ?? Date.now, sleep: supplied.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) };
  if (
    !Number.isFinite(supplied.deadline) ||
    !Number.isFinite(supplied.cleanupDeadline) ||
    supplied.deadline <= options.now() ||
    supplied.cleanupDeadline <= supplied.deadline
  ) {
    throw new StudioError("HOST_BUDGET_INVALID", "Studio 정리 기한은 처리 기한 뒤여야 합니다.");
  }
  const identity = verifiedIdentity(supplied.identity); const metrics = supplied.metrics ?? new StudioRunMetrics(options.now); const agent: StudioAgent = { id: identity.agentId, name: identity.agentName ?? identity.agentId, role: identity.role ?? "pinned Studio workflow" };
  let fileId: string | undefined; let cleanup: { status: StudioCleanupStatus; attempts: number } = { status: "not_started", attempts: 0 };
  let responseId: string | undefined;
  let servedIdentity: string | undefined;
  let stepNames: string[] = [];
  let completedResult: Omit<StudioWorkflowResult, "cleanup" | "metrics"> | undefined;
  let primaryError: unknown;
  let lifecycleOwnershipLost = false;
  const assertActive = async () => {
    try {
      await supplied.lifecycle?.assertActive?.();
    } catch (error) {
      lifecycleOwnershipLost = true;
      throw error;
    }
  };
  try {
    await assertActive();
    fileId = await uploadFile(bytes, filename, mime, options, supplied.deadline, metrics);
    await supplied.lifecycle?.onFileUploaded?.(fileId);
    await assertActive();
    await waitForFile(fileId, options, supplied.deadline, metrics);
    await assertActive();
    const created = await postOnce("responses.create", `${UPSTAGE_BASE}/responses`, {
      headers: headers(),
      body: JSON.stringify({
        ...identity.requestFields,
        model: identity.agentId,
        input: [{ role: "user", content: [{ type: "input_file", file_id: fileId }] }],
        include: ["all"],
      }),
    }, options, supplied.deadline, metrics);
    await assertOk(created, "RESPONSE_CREATE_FAILED"); const job = await json(created, "RESPONSE_CREATE_INVALID"); if (typeof job.id !== "string") throw new StudioError("RESPONSE_CREATE_INVALID");
    responseId = job.id;
    await supplied.lifecycle?.onResponseCreated?.(responseId);
    let completed: Record<string, unknown> | undefined;
    while (remaining(options.now, supplied.deadline) > 0) {
      await assertActive();
      const response = await requestWithRetry("responses.get", "GET", `${UPSTAGE_BASE}/responses/${encodeURIComponent(job.id)}?include[]=all`, { headers: headers(false) }, options, supplied.deadline, metrics);
      await assertOk(response, "RESPONSE_GET_FAILED"); const body = await json(response, "RESPONSE_GET_INVALID"); const status = typeof body.status === "string" ? body.status.toLowerCase() : "";
      if (status === "completed") { completed = body; break; }
      if (["failed", "cancelled", "expired"].includes(status)) throw new StudioError("RESPONSE_FAILED");
      if (!["queued", "in_progress", "processing", "pending"].includes(status)) throw new StudioError("RESPONSE_STATUS_UNKNOWN");
      await boundedSleep(options.sleep, options.now, supplied.deadline, POLL_INTERVAL_MS);
    }
    if (!completed) throw new StudioError("RESPONSE_TIMEOUT");
    const parsed = parseStudioWorkflowResponse(completed, kind);
    const responseServedIdentity = completed[identity.servedIdentityField];
    const servedModel = completed.model;
    if (
      typeof responseServedIdentity !== "string" ||
      responseServedIdentity !== identity.servedIdentity ||
      (typeof servedModel === "string" && servedModel !== identity.agentId)
    ) {
      throw new StudioError("SERVED_IDENTITY_MISMATCH");
    }
    servedIdentity = responseServedIdentity;
    await supplied.lifecycle?.onServedIdentityValidated?.(servedIdentity);
    stepNames = parsed.steps.map((step) => step.stepName);
    completedResult = { agent, jobId: job.id, fileId, elements: parsed.parse.elements, fullText: parsed.parse.fullText, pageCount: parsed.parse.elements.reduce((max, element) => Math.max(max, element.page), 0) || 1, parse: parsed.parse, extracted: parsed.extracted, validation: parsed.validation, review: parsed.review, provenance: { manifestSha: identity.manifestSha, configFingerprint: identity.configFingerprint, requestedConfigId: identity.configId, boundByReceipt: { id: identity.capabilityReceiptId, scheme: "request-config-id-v1" }, servedConfigEchoVerified: false, agentId: identity.agentId, responseId: job.id, servedIdentity, stepNames } };
  } catch (error) {
    primaryError = error;
  } finally {
    if (fileId && !lifecycleOwnershipLost) {
      // A reclaimed runner must leave remote cleanup to the durable sweeper.
      // It may not issue DELETE after losing its fence.
      await assertActive();
      cleanup = await deleteFile(fileId, options, supplied.cleanupDeadline, metrics);
      await supplied.lifecycle?.onCleanup?.(cleanup);
    }
  }
  const failure: StudioWorkflowFailure = {
    agent,
    fileId,
    responseId,
    provenance: {
      manifestSha: identity.manifestSha,
      configFingerprint: identity.configFingerprint,
      requestedConfigId: identity.configId,
      boundByReceipt: { id: identity.capabilityReceiptId, scheme: "request-config-id-v1" },
      servedConfigEchoVerified: false,
      agentId: identity.agentId,
      responseId,
      servedIdentity,
      stepNames,
    },
    cleanup,
    metrics: metrics.snapshot(),
  };
  if (cleanup.status !== "deleted") {
    throw new StudioError(
      "REMOTE_CLEANUP_INCOMPLETE",
      `Studio 원격 파일 정리가 ${cleanup.status} 상태입니다.`,
      primaryError,
      failure,
    );
  }
  if (primaryError) {
    if (primaryError instanceof StudioParseError) {
      throw new StudioError(primaryError.code, primaryError.message, primaryError, failure);
    }
    if (primaryError instanceof StudioError) {
      throw new StudioError(primaryError.code, primaryError.message, primaryError.cause, failure);
    }
    throw new StudioError("WORKFLOW_FAILED", "Studio 워크플로우가 실패했습니다.", primaryError, failure);
  }
  if (!completedResult) throw new StudioError("WORKFLOW_INCOMPLETE");
  return { ...completedResult, cleanup, metrics: metrics.snapshot() };
}
