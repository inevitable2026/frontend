import { BoardSourcesError, loadBoardSources } from "@/lib/board/sources";
import { BOARD_STORE_ERROR_STATUS, isBoardStoreError } from "@/lib/board/store";
import { isYmd } from "@/lib/board/week";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

// 첫 화면이 부르는 단 하나의 읽기다. items · week · briefing · sites · documents 다섯을
// 따로 부르면 서버에서 같은 카드 목록을 세 번 읽게 되는데, 그 중복이 그대로 대기 시간이라
// 여기서 한 번에 모아 돌려준다. 모으는 일은 lib/board/sources.ts 가 하고 이 파일은
// 매개변수를 검사해 상태 코드로 옮기기만 한다.
//
// 서버 컴포넌트(app/page.tsx)는 이 라우트를 거치지 않고 같은 함수를 직접 부른다. 자기
// 서버에 HTTP 로 다시 들어가는 왕복이 통째로 낭비이기 때문이다. 이 라우트가 남아 있는
// 이유는 화면이 다시 시도할 때와 서버에서 미리 읽지 못했을 때의 길이 필요해서다.

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const date = params.get("date")?.trim();
  if (!date) return fail("date 가 필요합니다.", 400);
  if (!isYmd(date)) return fail("date 는 YYYY-MM-DD 형식이어야 합니다.", 400);

  const at = params.get("at")?.trim();
  if (at && !Number.isFinite(Date.parse(at))) {
    return fail("at 은 ISO8601 시각이어야 합니다.", 400);
  }

  try {
    const sources = await loadBoardSources(siteId, date, at || undefined);
    return Response.json(sources, { headers: HEADERS });
  } catch (error) {
    if (error instanceof BoardSourcesError) return fail(error.message, 404);
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
