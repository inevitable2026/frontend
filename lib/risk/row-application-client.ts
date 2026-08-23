export type RiskRowApplicationDescriptor = {
  targetDocumentId: string | null;
  applicationFingerprint: string | null;
  eligible: boolean;
  issues: { code: string; message: string }[];
  rowIds: string[];
};

export type RiskRowApplicationCommand = {
  commandId: string;
  siteId: string;
  workItemId: string;
  expectedApplicationFingerprint: string;
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

export class RiskRowApplicationRequestError extends Error {
  constructor(readonly status: number | null, readonly code: string | null = null, message?: string) {
    // HTTP 상태 코드를 문장에 넣지 않는다. `409` 를 읽고 무엇을 할지 아는 사람은 없다.
    // 코드는 `status` 필드로 남으므로 분기와 로그에서는 그대로 쓸 수 있다.
    super(
      message ??
        (status === null
          ? "서버에 닿지 못해 반영을 마치지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."
          : "반영 요청이 처리되지 않았습니다. 화면을 새로 고친 뒤 다시 시도해 주세요."),
    );
    this.name = "RiskRowApplicationRequestError";
  }
}

/**
 * Prevents an older descriptor request from overwriting a newer review state.
 * A stale request resolves to `null`; only the newest request may surface a
 * value or an error to the UI.
 */
export function createLatestRiskRowApplicationLoader(
  load: (siteId: string, workItemId: string) => Promise<RiskRowApplicationDescriptor> = loadRiskRowApplication,
) {
  let generation = 0;

  return {
    invalidate(): void {
      generation += 1;
    },
    async load(siteId: string, workItemId: string): Promise<RiskRowApplicationDescriptor | null> {
      const requestGeneration = ++generation;
      try {
        const descriptor = await load(siteId, workItemId);
        return requestGeneration === generation ? descriptor : null;
      } catch (error) {
        if (requestGeneration !== generation) return null;
        throw error;
      }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function positiveIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry) && entry > 0);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function messageAndCode(value: unknown): { error?: string; code?: string } {
  if (!record(value)) return {};
  return {
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  };
}

export function parseRiskRowApplicationDescriptor(value: unknown): RiskRowApplicationDescriptor | null {
  if (!record(value)) return null;
  if (
    (value.targetDocumentId !== null && !nonempty(value.targetDocumentId)) ||
    (value.applicationFingerprint !== null && !fingerprint(value.applicationFingerprint)) ||
    typeof value.eligible !== "boolean" || !strings(value.rowIds) || !Array.isArray(value.issues) ||
    !value.issues.every((issue) => record(issue) && nonempty(issue.code) && nonempty(issue.message))
  ) return null;
  return value as RiskRowApplicationDescriptor;
}

export function parseRiskRowApplicationResult(value: unknown): RiskRowApplicationResult | null {
  if (!record(value) || typeof value.replayed !== "boolean") return null;
  if (
    !nonempty(value.commandId) || !nonempty(value.siteId) || !nonempty(value.workItemId) ||
    !nonempty(value.targetDocumentId) || !strings(value.rowIds) || !positiveIds(value.factIds) ||
    typeof value.workItemEventId !== "number" || !Number.isSafeInteger(value.workItemEventId) || value.workItemEventId <= 0 ||
    !nonempty(value.actor) || !isoTimestamp(value.appliedAt)
  ) return null;
  return value as RiskRowApplicationResult;
}

export function applicationResultMatchesCommand(result: RiskRowApplicationResult, command: RiskRowApplicationCommand): boolean {
  return result.commandId === command.commandId && result.siteId === command.siteId && result.workItemId === command.workItemId;
}

export function applicationResultMatchesDescriptor(
  result: RiskRowApplicationResult,
  descriptor: RiskRowApplicationDescriptor,
): boolean {
  return descriptor.targetDocumentId === result.targetDocumentId &&
    descriptor.rowIds.length === result.rowIds.length &&
    descriptor.rowIds.every((rowId, index) => rowId === result.rowIds[index]);
}

export async function loadRiskRowApplication(siteId: string, workItemId: string): Promise<RiskRowApplicationDescriptor> {
  const query = new URLSearchParams({ siteId, workItemId });
  let response: Response;
  try {
    response = await fetch(`/api/risk/row-applications?${query}`, { cache: "no-store", headers: { accept: "application/json" } });
  } catch {
    throw new RiskRowApplicationRequestError(null);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { error, code } = messageAndCode(body);
    throw new RiskRowApplicationRequestError(response.status, code ?? null, error);
  }
  const descriptor = parseRiskRowApplicationDescriptor(body);
  if (!descriptor) throw new RiskRowApplicationRequestError(502);
  return descriptor;
}

export async function applyRiskRows(command: RiskRowApplicationCommand): Promise<RiskRowApplicationResult> {
  let response: Response;
  try {
    response = await fetch("/api/risk/row-applications", {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(command),
    });
  } catch {
    throw new RiskRowApplicationRequestError(null);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { error, code } = messageAndCode(body);
    throw new RiskRowApplicationRequestError(response.status, code ?? null, error);
  }
  const result = parseRiskRowApplicationResult(body);
  if (!result || !applicationResultMatchesCommand(result, command)) throw new RiskRowApplicationRequestError(502);
  return result;
}
