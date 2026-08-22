import {
  parseRiskRowReviewConflict,
  parseRiskRowReviewResult,
  parseRiskRowReviewStates,
  reviewResultMatchesCommand,
  type RiskRowReviewCommand,
  type RiskRowReviewCommandResult,
  type RiskRowReviewConflict,
  type RiskRowReviewState,
} from "@/lib/risk/row-review-types";

export class RiskRowReviewRequestError extends Error {
  constructor(readonly status: number | null, readonly conflict: RiskRowReviewConflict | null = null) {
    super(conflict?.error ?? (status === null ? "서버에 닿지 못해 행 검토를 저장하지 못했습니다." : `행 검토 요청이 ${status} 로 실패했습니다.`));
    this.name = "RiskRowReviewRequestError";
  }
}

function errorMessage(body: unknown): string | null {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
}

export async function loadRiskRowReviewStates(siteId: string, workItemId: string): Promise<RiskRowReviewState[]> {
  const query = new URLSearchParams({ siteId, workItemId });
  let response: Response;
  try {
    response = await fetch(`/api/risk/row-reviews?${query}`, { cache: "no-store", headers: { accept: "application/json" } });
  } catch {
    throw new RiskRowReviewRequestError(null);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = errorMessage(body);
    const error = new RiskRowReviewRequestError(response.status);
    if (message) error.message = message;
    throw error;
  }
  const rows = parseRiskRowReviewStates(body);
  if (!rows) throw new RiskRowReviewRequestError(502);
  return rows;
}

export async function saveRiskRowReview(command: RiskRowReviewCommand): Promise<RiskRowReviewCommandResult> {
  let response: Response;
  try {
    response = await fetch("/api/risk/row-reviews", {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(command),
    });
  } catch {
    throw new RiskRowReviewRequestError(null);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const conflict = response.status === 409 ? parseRiskRowReviewConflict(body) : null;
    if (conflict) throw new RiskRowReviewRequestError(response.status, conflict);
    const message = errorMessage(body);
    const error = new RiskRowReviewRequestError(response.status);
    if (message) error.message = message;
    throw error;
  }
  const result = parseRiskRowReviewResult(body);
  if (!result || !reviewResultMatchesCommand(result, command)) throw new RiskRowReviewRequestError(502);
  return result;
}
