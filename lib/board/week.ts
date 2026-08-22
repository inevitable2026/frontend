import { kstDateOf, 기한날짜, 기한시각 } from "./briefing";
import type { WeekDay, WeekPage, WorkItem } from "./types";

// 주간 보드 한 장을 만드는 계산이다. 질의는 하지 않는다 — 카드 목록을 받아서 일곱 칸에
// 나눠 담기만 한다.
//
// 이 파일이 라우트에서 떨어져 나온 이유는 읽는 곳이 둘이기 때문이다. GET /api/board/week 가
// 하나이고, 첫 화면이 한 번에 받아 가는 스냅샷(lib/board/sources.ts)이 다른 하나다.
// 스냅샷은 카드 목록을 이미 들고 있어서 같은 질의를 또 보낼 이유가 없는데, 계산이 라우트
// 안에 있으면 그 질의를 반복하거나 규칙을 두 벌로 적는 수밖에 없다.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// 날짜는 'YYYY-MM-DD' 문자열로만 왕복한다. Date 객체로 돌리면 UTC 로 도는 서버리스
// 함수에서 하루가 밀린다. 아래 계산은 전부 UTC 자정 기준이라 지역 시간대를 타지 않는다.
export function isYmd(value: string): boolean {
  if (!YMD.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function addDays(ymd: string, n: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function mondayOf(ymd: string): string {
  const 요일 = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = 일요일
  return addDays(ymd, -((요일 + 6) % 7));
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

/**
 * 현장 전체 카드에서 이 주에 걸리는 것만 추린다.
 *
 * store.listItems 의 from · to 조건과 같은 뜻이다. 그쪽은 SQL 로 거르고 여기는 같은 판정을
 * 자바스크립트로 한다 — 카드 목록을 이미 들고 있는 호출자가 질의를 한 번 더 보내지 않아도
 * 되게 하려는 것이고, 두 경로의 결과가 갈라지지 않도록 기준을 하나로 적어 둔다.
 */
export function 이번주카드(items: WorkItem[], from: string, to: string): WorkItem[] {
  return items.filter((item) => {
    const 기준 = 기한날짜(item.dueBy) ?? kstDateOf(item.createdAt);
    return 기준 !== null && 기준 >= from && 기준 <= to;
  });
}

/**
 * 주간 보드를 만든다. `from` 은 월요일이 아니어도 되고, 그 주 월요일로 당겨서 쓴다.
 * `items` 는 그 주에 걸리는 카드만 담은 목록이어야 한다 — 현장 전체를 넘길 때는
 * `이번주카드` 를 먼저 통과시킨다.
 */
export function buildWeekPage(siteId: string, fromRaw: string, 후보: WorkItem[]): WeekPage {
  const from = mondayOf(fromRaw);
  const to = addDays(from, 6);

  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => ({
    date: addDays(from, i),
    itemIds: [],
    triggerCount: 0,
    dueCount: 0,
    draftCount: 0,
  }));
  const 칸 = new Map(days.map((d) => [d.date, d]));

  const items: WorkItem[] = [];
  for (const item of 후보) {
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
  return { siteId, from, to, days, items };
}
