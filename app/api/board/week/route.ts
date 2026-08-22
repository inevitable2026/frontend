import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { addDays, buildWeekPage, isYmd, mondayOf } from "@/lib/board/week";
import type { BoardStore } from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

async function 현장있음(store: BoardStore, siteId: string): Promise<boolean> {
  if ((await store.latestSnapshotAt(siteId)) !== null) return true;
  const 전체 = await store.listItems({ siteId });
  return 전체.total > 0;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const fromRaw = params.get("from")?.trim();
  if (!fromRaw) return fail("from 이 필요합니다.", 400);
  if (!isYmd(fromRaw)) return fail("from 은 YYYY-MM-DD 형식이어야 합니다.", 400);

  // 월요일이 아닌 값이 오면 그 주 월요일로 당긴다. 응답의 from 이 실제로 쓴 값이다.
  const from = mondayOf(fromRaw);
  const to = addDays(from, 6);

  const store = boardStore();
  try {
    const page = await store.listItems({ siteId, from, to });
    if (page.total === 0 && !(await 현장있음(store, siteId))) {
      return fail("그런 현장이 없습니다.", 404);
    }

    // 일곱 칸에 나눠 담는 계산은 lib/board/week.ts 한 곳에만 있다. 첫 화면이 받아 가는
    // 스냅샷도 같은 함수를 부르므로 두 경로의 주간 보드가 갈라지지 않는다.
    return Response.json(buildWeekPage(siteId, from, page.items), { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
