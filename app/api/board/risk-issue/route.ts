import { loadRiskIssue } from "@/lib/board/risk-issue";
import { BOARD_STORE_ERROR_STATUS, isBoardStoreError } from "@/lib/board/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

/**
 * 보드 맨 위의 "위험성평가 이슈" 한 건.
 *
 * 이슈가 없는 것은 오류가 아니라 정상 상태다 — 반영이 끝나면 카드가 확정되어 다음
 * 조회부터 `{ issue: null }` 이 오고, 화면은 섹션을 그리지 않는다. 그래서 404 를 쓰지
 * 않는다: 404 는 "그런 현장이 없다" 처럼 요청 자체가 틀린 경우에만 어울린다.
 */
export async function GET(req: Request) {
  const siteId = new URL(req.url).searchParams.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  try {
    const issue = await loadRiskIssue(siteId);
    return Response.json({ issue }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
