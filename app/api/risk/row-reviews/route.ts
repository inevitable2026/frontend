import {
  applyRiskRowReview,
  listRiskRowReviewStates,
  RiskRowReviewApprovedLockedError,
  RiskRowReviewCommandReuseError,
  RiskRowReviewNotFoundError,
  RiskRowReviewRowConflictError,
  RiskRowReviewUnavailableError,
  RiskRowReviewVersionConflictError,
} from "@/lib/risk/row-review-store";
import {
  riskRowReviewAccess,
  RiskRowReviewAccessUnavailableError,
  type RiskRowReviewAccess,
} from "@/lib/risk/row-review-access";
import type { RiskRowReviewCommand } from "@/lib/risk/row-review-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function authorizeSite(scope: RiskRowReviewAccess, siteId: string): void {
  if (!scope.siteIds.has(siteId)) throw new RiskRowReviewNotFoundError();
}

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: HEADERS });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const siteId = params.get("siteId")?.trim() ?? "";
  const workItemId = params.get("workItemId")?.trim() ?? "";
  try {
    authorizeSite(riskRowReviewAccess(), siteId);
    return response({ rows: await listRiskRowReviewStates(siteId, workItemId) });
  } catch (error) {
    if (error instanceof TypeError) return response({ error: error.message, code: "invalid_request" }, 400);
    if (error instanceof RiskRowReviewNotFoundError) return response({ error: error.message, code: error.code }, 404);
    if (error instanceof RiskRowReviewAccessUnavailableError) return response({ error: error.message, code: "unavailable" }, 503);
    if (error instanceof RiskRowReviewUnavailableError) return response({ error: error.message, code: error.code }, 503);
    throw error;
  }
}

export async function PUT(request: Request) {
  let command: RiskRowReviewCommand;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "JSON 객체 본문이 필요합니다.", code: "invalid_request" }, 400);
    }
    command = body as RiskRowReviewCommand;
  } catch {
    return response({ error: "JSON 본문이 필요합니다.", code: "invalid_request" }, 400);
  }

  try {
    const scope = riskRowReviewAccess();
    authorizeSite(scope, command.siteId);
    return response(await applyRiskRowReview(command, scope.actor));
  } catch (error) {
    if (error instanceof TypeError) return response({ error: error.message, code: "invalid_request" }, 400);
    if (error instanceof RiskRowReviewNotFoundError) return response({ error: error.message, code: error.code }, 404);
    if (error instanceof RiskRowReviewAccessUnavailableError) return response({ error: error.message, code: "unavailable" }, 503);
    if (error instanceof RiskRowReviewUnavailableError) return response({ error: error.message, code: error.code }, 503);
    if (error instanceof RiskRowReviewVersionConflictError) {
      return response({
        error: error.message, code: error.code, expectedVersion: error.expectedVersion,
        actualVersion: error.actualVersion,
        current: null,
      }, 409);
    }
    if (error instanceof RiskRowReviewRowConflictError) {
      return response({
        error: error.message, code: error.code, expectedRowFingerprint: error.expectedRowFingerprint,
        actualRowFingerprint: error.actualRowFingerprint,
        current: null,
      }, 409);
    }
    if (error instanceof RiskRowReviewCommandReuseError) {
      return response({
        error: error.message, code: error.code,
        current: null,
      }, 409);
    }
    if (error instanceof RiskRowReviewApprovedLockedError) {
      return response({ error: error.message, code: error.code, current: null }, 409);
    }
    throw error;
  }
}
