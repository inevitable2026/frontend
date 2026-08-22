import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { 문서차이내기, type 판본 } from "@/lib/risk/diff";
import { 최신만, 행정렬, type 행팩트 } from "@/lib/risk/rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 재평가가 무엇을 바꿨는지.
 *
 * 「바뀐 평가서」만 내려받게 해 두면 받는 사람이 **무엇이 달라졌는지를 문서를 통째로
 * 다시 읽어서** 알아내야 한다. 팩트가 append-only 라 원본이 남아 있으므로 여기서
 * 견줘서 돌려준다.
 */

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const docId = params.get("docId")?.trim();
  if (!docId) return fail("docId 가 필요합니다.", 400);

  try {
    const all = await boardStore().listFacts(siteId, "riskAssessmentRow");
    // 이력을 통째로 쥔 채 넘긴다 — 차이를 내려면 접기 전 판본이 있어야 한다.
    const 이력 = all.filter((f) => f.key.startsWith(`${docId}#`)) as 판본[];
    const 지금 = 행정렬(최신만(이력 as unknown as 행팩트[]) as 행팩트[]);

    if (지금.length === 0) return fail(`${docId} 에서 행을 한 건도 찾지 못했습니다.`, 404);

    return Response.json({ docId, ...문서차이내기(이력, 지금) }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
