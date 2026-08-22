import { buildBriefing, kstIsoOf, kstNowIso } from "@/lib/board/briefing";
import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { triggerRules } from "@/lib/detect/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

// 브리핑이 거슬러 올라가는 창. 조건은 어제 저녁에 감지되고 화면은 오늘 아침이라
// 하루는 있어야 어제 것이 창 안에 들어온다.
const WINDOW_HOURS = 24;

// 규칙 이름표는 규칙 자신이 들고 있다. 여기서 다시 적으면 두 곳이 갈라진다.
const RULE_LABELS = Object.fromEntries(triggerRules.map((rule) => [rule.id, rule.label]));

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
    const [detections, page] = await Promise.all([
      store.listDetections(siteId, 창시작),
      store.listItems({ siteId }),
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
      labels: RULE_LABELS,
    });

    return Response.json({ briefing }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
