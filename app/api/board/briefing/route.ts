import {
  buildBriefing,
  kstIsoOf,
  kstNowIso,
  문단재료만들기,
  문단캐시열쇠,
  type BriefingInput,
} from "@/lib/board/briefing";
import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import type { BoardStore } from "@/lib/board/types";
import { isGenerationConfigured, narrateBriefing } from "@/lib/generate";
import { db } from "@/lib/context/db";
import { triggerRules } from "@/lib/detect/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 캐시가 빗나간 첫 요청만 모델을 부른다. 그 한 번이 기본 상한에 걸리지 않게 열어 둔다.
export const maxDuration = 120;

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

/**
 * 브리핑 맨 위 문단.
 *
 * 캐시를 먼저 본다. 열쇠에 시각이 들어가지 않으므로, 창 안의 감지와 카드가 그대로면 화면을
 * 몇 번을 새로 열어도 같은 문단이 나오고 모델은 한 번만 불린다. 담당자가 브리핑이 어제와
 * 무엇이 달라졌는지를 문장의 변화로 읽기 때문에, 같은 상황에 다른 문장이 나오는 것 자체가
 * 거짓 신호가 된다.
 *
 * 모델이 실패하면 넘겨받은 폴백 문단을 그대로 돌려준다. 그 문단은 어떤 상황에서도 똑같이
 * 나오는 틀이지만 사실과 어긋나지는 않는다 — 화면이 비어 "오늘 아무 일도 없다" 로 읽히는
 * 쪽이 훨씬 나쁘다. 실패한 문단은 캐시에 넣지 않는다. 넣으면 다음 요청이 되살릴 기회를 잃는다.
 */
async function 문단(store: BoardStore, 재료: BriefingInput, 폴백: string[]): Promise<string[]> {
  const 열쇠 = 문단캐시열쇠(재료);

  try {
    const 캐시 = await store.readBriefingNarrative(열쇠);
    if (캐시) return 캐시;
  } catch (error) {
    // 캐시를 못 읽은 것으로 브리핑을 실패시키지 않는다. 모델을 한 번 더 부르면 될 일이다.
    console.error("[board/briefing] 문단 캐시 읽기 실패", error);
  }

  if (!isGenerationConfigured()) return 폴백;

  try {
    const paragraphs = await narrateBriefing(문단재료만들기(재료));
    if (paragraphs.length === 0) return 폴백;
    await store.writeBriefingNarrative(열쇠, 재료.siteId, paragraphs).catch((error: unknown) => {
      console.error("[board/briefing] 문단 캐시 쓰기 실패", error);
    });
    return paragraphs;
  } catch (error) {
    console.error("[board/briefing] 문단 생성 실패", error);
    return 폴백;
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

    const 재료 = {
      siteId,
      at,
      windowHours: WINDOW_HOURS,
      detections,
      items: page.items,
      documentCount,
      labels: RULE_LABELS,
    };

    // 근거 패널은 감지 시점에 저장된 서사를 그대로 쓴다. 세는 일과 조립은
    // lib/board/briefing.ts 가 하고, 이 라우트는 문단만 따로 채워 넣는다.
    const briefing = buildBriefing(재료);
    briefing.paragraphs = await 문단(store, 재료, briefing.paragraphs);

    return Response.json({ briefing }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
