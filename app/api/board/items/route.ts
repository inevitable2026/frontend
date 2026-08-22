import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import {
  WORK_ITEM_STATUS_ORDER,
  type BoardPage,
  type BoardQuery,
  type BoardStore,
  type WorkItemStatus,
} from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

function isYmd(value: string): boolean {
  if (!YMD.test(value)) return false;
  // 2026-02-31 처럼 형식만 맞는 값을 막는다
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/**
 * BoardStore 에 현장 조회가 없다. 카드도 사실도 하나 없을 때만 없는 현장으로 읽는다.
 * 조건에 걸린 카드가 없는 것과 현장 자체가 없는 것은 화면에서 전혀 다른 사건이라
 * 빈 목록과 404 를 뭉뚱그리면 안 된다.
 */
async function 현장있음(store: BoardStore, siteId: string): Promise<boolean> {
  if ((await store.latestSnapshotAt(siteId)) !== null) return true;
  const 전체 = await store.listItems({ siteId });
  return 전체.total > 0;
}

// siteId 는 필수다. 빠뜨리면 다른 현장 카드가 섞여 나오고, 담당자 이름과
// 하도급사 상호가 그대로 붙어 있는 화면에서 그것은 사고다.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const statusRaw = params.get("status")?.trim();
  if (statusRaw && !(WORK_ITEM_STATUS_ORDER as string[]).includes(statusRaw)) {
    return fail("status 는 todo · approval · done 중 하나여야 합니다.", 400);
  }
  const status = statusRaw ? (statusRaw as WorkItemStatus) : undefined;

  const dateRaw = params.get("date")?.trim();
  if (dateRaw && !isYmd(dateRaw)) {
    return fail("date 는 YYYY-MM-DD 형식이어야 합니다.", 400);
  }
  const date = dateRaw || undefined;

  const query: BoardQuery = { siteId };
  if (status) query.status = status;
  if (date) query.date = date;

  const store = boardStore();
  try {
    const page = await store.listItems(query);
    if (page.total === 0 && !(await 현장있음(store, siteId))) {
      return fail("그런 현장이 없습니다.", 404);
    }

    const body: BoardPage = {
      total: page.items.length,
      siteId,
      date: date ?? null,
      items: page.items,
    };
    return Response.json(body, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
