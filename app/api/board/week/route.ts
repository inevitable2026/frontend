import { kstDateOf, 기한날짜, 기한시각 } from "@/lib/board/briefing";
import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import type { BoardStore, WeekDay, WeekPage, WorkItem } from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

// 날짜는 'YYYY-MM-DD' 문자열로만 왕복한다. Date 객체로 돌리면 UTC 로 도는 서버리스
// 함수에서 하루가 밀린다. 아래 계산은 전부 UTC 자정 기준이라 지역 시간대를 타지 않는다.
function isYmd(value: string): boolean {
  if (!YMD.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function addDays(ymd: string, n: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function mondayOf(ymd: string): string {
  const 요일 = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = 일요일
  return addDays(ymd, -((요일 + 6) % 7));
}

async function 현장있음(store: BoardStore, siteId: string): Promise<boolean> {
  if ((await store.latestSnapshotAt(siteId)) !== null) return true;
  const 전체 = await store.listItems({ siteId });
  return 전체.total > 0;
}

// 현장 근무가 시작되는 시각이다. 이 시각보다 앞선 기한은 그날 아침에 손댈 수 없으므로
// 실제로는 전날 처리해야 하는 일이다. 익일 TBM 06:40 자료가 대표적인 경우다.
const 근무시작시 = 8;

/**
 * 카드를 어느 날에 놓을지 정한다.
 *  1. 기한이 이번 주 안이면 기한 날. 다만 기한 시각이 근무 시작(08:00) 이전이면 전날.
 *  2. 기한이 없거나 주 밖이면 만들어진 날.
 *  3. 둘 다 주 밖이면 이 주에 놓지 않는다.
 *
 * 1번의 단서가 핵심이다. 06시 40분에 쓸 자료를 그날 아침에 만들 수는 없으므로, 기한 날이
 * 아니라 손대야 하는 날에 놓아야 보드가 하루치 할 일을 정직하게 보여준다. 「손대야 하는 날」을
 * 필드로 따로 두지 않고 기한에서 유도하는 이유는, 필드를 두면 감지 엔진과 시드와 저장소
 * 세 곳이 그 값을 채워야 하는데 근무 시작 시각이라는 현장 상수 하나로 계산되는 값이기 때문이다.
 *
 * 한 카드는 한 날에만 놓인다. 같은 카드가 두 칸에 뜨면 주간 숫자와 칸반 숫자가 어긋나고,
 * 그때부터 화면의 카운터를 아무도 믿지 않게 된다.
 */
function 손대야하는날(dueBy: string | null): string | null {
  const 기한 = 기한날짜(dueBy);
  if (!기한) return null;

  // 시각이 박히지 않은 기한('2026-08-20 작업 전' 같은 문구)은 앞당기지 않는다. 시각을
  // 모르는 채로 당기면 기한이 하루 이른 것처럼 보여서 없는 급함을 만들어 낸다.
  const t = 기한시각(dueBy);
  if (t === null) return 기한;

  const 시 = new Date(t + 9 * 3_600_000).getUTCHours();
  if (시 >= 근무시작시) return 기한;

  const 전날 = Date.parse(`${기한}T00:00:00Z`) - 86_400_000;
  return new Date(전날).toISOString().slice(0, 10);
}

function 배치(item: WorkItem, from: string, to: string): { date: string; 기한으로: boolean } | null {
  const 기한 = 손대야하는날(item.dueBy);
  if (기한 && 기한 >= from && 기한 <= to) return { date: 기한, 기한으로: true };

  const 생성 = kstDateOf(item.createdAt);
  if (생성 && 생성 >= from && 생성 <= to) return { date: 생성, 기한으로: false };

  return null;
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

    const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => ({
      date: addDays(from, i),
      itemIds: [],
      triggerCount: 0,
      dueCount: 0,
      draftCount: 0,
    }));
    const 칸 = new Map(days.map((d) => [d.date, d]));

    const items: WorkItem[] = [];
    for (const item of page.items) {
      const 자리 = 배치(item, from, to);
      if (!자리) continue;
      const day = 칸.get(자리.date);
      if (!day) continue;

      day.itemIds.push(item.itemId);
      if (item.timing === "trigger") day.triggerCount += 1;
      if (자리.기한으로) day.dueCount += 1;
      if (item.draft !== null) day.draftCount += 1;
      items.push(item);
    }

    // 같은 날 안에서는 시각이 박힌 카드를 먼저, 시각이 없는 것은 열 순서대로 읽는다.
    const 시각 = new Map(items.map((i) => [i.itemId, 기한시각(i.dueBy)] as const));
    const 열순서 = new Map(items.map((i) => [i.itemId, i.laneOrder] as const));
    for (const day of days) {
      day.itemIds.sort((a, b) => {
        const ta = 시각.get(a) ?? null;
        const tb = 시각.get(b) ?? null;
        if (ta !== null && tb !== null && ta !== tb) return ta - tb;
        if (ta !== null && tb === null) return -1;
        if (ta === null && tb !== null) return 1;
        return (열순서.get(a) ?? 0) - (열순서.get(b) ?? 0);
      });
    }

    // 카드 본문은 items 에만 한 번 실린다. days 는 itemIds 로만 가리킨다.
    const body: WeekPage = { siteId, from, to, days, items };
    return Response.json(body, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
