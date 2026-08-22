import { buildBriefing, kstIsoOf, kstNowIso } from "@/lib/board/briefing";
import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { db } from "@/lib/context/db";
import { triggerRules } from "@/lib/detect/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

// 브리핑이 거슬러 올라가는 창. 조건은 어제 저녁에 감지되고 화면은 오늘 아침이라
// 하루는 있어야 어제 것이 창 안에 들어온다.
const WINDOW_HOURS = 24;

// 규칙 이름표는 규칙 자신이 들고 있다. 여기서 다시 적으면 두 곳이 갈라진다.
const RULE_LABELS = Object.fromEntries(triggerRules.map((rule) => [rule.id, rule.label]));

/**
 * 창 안에 들어온 문서 수. 브리핑 첫 문장의 "문서 N건을 읽어" 가 이 값을 쓴다.
 *
 * 문서함은 보드 store 와 다른 곳(`lib/context/db`)에 있고, 보드가 JSON store 로 돌 때는
 * 아예 없을 수도 있다. 그래서 실패는 삼키고 `undefined` 로 돌린다 — 0 으로 돌리면 브리핑이
 * "한 건도 들어오지 않았다" 고 적어 사실과 어긋난다.
 */
async function 읽은문서수(siteId: string, 창시작: string, 기준: string): Promise<number | undefined> {
  try {
    const sql = db();
    const [row] = await sql<Array<{ n: string }>>`
      select count(*)::text as n from documents
       where site_id = ${siteId} and created_at >= ${창시작} and created_at <= ${기준}
    `;
    const n = Number(row?.n);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const atRaw = params.get("at")?.trim();
  if (atRaw && !Number.isFinite(Date.parse(atRaw))) {
    return fail("at 은 ISO8601 시각이어야 합니다.", 400);
  }
  const at = atRaw ? kstIsoOf(Date.parse(atRaw)) : kstNowIso();

  // listDetections 의 since 는 문자열끼리 비교한다. UTC 표기로 넘기면 같은 순간이라도
  // 자릿수가 어긋나 어제 것이 통째로 빠지므로 KST 표기로 맞춰 넘긴다.
  const 창시작 = kstIsoOf(Date.parse(at) - WINDOW_HOURS * 3_600_000);

  const store = boardStore();
  try {
    const [detections, page, documentCount] = await Promise.all([
      store.listDetections(siteId, 창시작),
      store.listItems({ siteId }),
      읽은문서수(siteId, 창시작, at),
    ]);

    if (page.total === 0 && detections.length === 0) {
      if ((await store.latestSnapshotAt(siteId)) === null) {
        return fail("그런 현장이 없습니다.", 404);
      }
    }

    // 문장은 여기서 지어내지 않는다. 조립은 lib/board/briefing.ts 한 곳에서만 한다.
    const briefing = buildBriefing({
      siteId,
      at,
      windowHours: WINDOW_HOURS,
      detections,
      items: page.items,
      documentCount,
      labels: RULE_LABELS,
    });

    return Response.json({ briefing }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
