import {
  applyRiskRowApplication,
  getRiskRowApplicationDescriptor,
  RiskRowApplicationConflictError,
  RiskRowApplicationNotFoundError,
  RiskRowApplicationUnavailableError,
} from "@/lib/risk/row-application-store";
import { RISK_ROW_APPLICATION_UUID, type RiskRowApplicationCommand } from "@/lib/risk/row-application-types";
import {
  riskRowReviewAccess,
  RiskRowReviewAccessUnavailableError,
  type RiskRowReviewAccess,
} from "@/lib/risk/row-review-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: HEADERS });
}

function authorizeSite(scope: RiskRowReviewAccess, siteId: string): void {
  if (!scope.siteIds.has(siteId)) throw new RiskRowApplicationNotFoundError();
}

function failure(error: unknown): Response {
  if (error instanceof TypeError) return response({ error: error.message, code: "invalid_request" }, 400);
  if (error instanceof RiskRowApplicationNotFoundError) return response({ error: error.message, code: error.code }, 404);
  if (error instanceof RiskRowApplicationConflictError) return response({ error: error.message, code: error.code }, 409);
  if (error instanceof RiskRowReviewAccessUnavailableError) return response({ error: error.message, code: "unavailable" }, 503);
  if (error instanceof RiskRowApplicationUnavailableError) return response({ error: error.message, code: error.code }, 503);
  throw error;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const siteId = params.get("siteId")?.trim() ?? "";
  const workItemId = params.get("workItemId")?.trim() ?? "";
  try {
    if (!RISK_ROW_APPLICATION_UUID.test(siteId) || !workItemId) {
      throw new TypeError("어느 현장의 어느 카드인지 알 수 없습니다. 화면을 새로 고쳐 주세요.");
    }
    authorizeSite(riskRowReviewAccess(), siteId);
    return response(await getRiskRowApplicationDescriptor(siteId, workItemId));
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  let command: RiskRowApplicationCommand;
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "반영 요청을 읽지 못했습니다. 화면을 새로 고친 뒤 다시 반영해 주세요.", code: "invalid_request" }, 400);
    }
    command = body as RiskRowApplicationCommand;
  } catch {
    return response({ error: "반영 요청을 읽지 못했습니다. 화면을 새로 고친 뒤 다시 반영해 주세요.", code: "invalid_request" }, 400);
  }
  try {
    const scope = riskRowReviewAccess();
    authorizeSite(scope, command.siteId);
    const result = await applyRiskRowApplication(command, scope.actor);
    return response(result, result.replayed ? 200 : 201);
  } catch (error) {
    return failure(error);
  }
}
