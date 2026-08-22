import { kstIsoOf, kstNowIso } from "@/lib/board/briefing";
import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import type { SnapshotFact } from "@/lib/board/types";
import { collectFacts, isWeatherApiConfigured, weatherConnector } from "@/lib/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 기상청 단기예보를 불러 강우 사실 한 칸을 갱신한다.
//
// 이 라우트가 따로 있는 이유는 감지 라우트에 붙일 수 없어서다. POST /api/board/detect 는
// 언제나 run.created 를 upsertItems 로 밀어 넣는데, 이 현장에는 시드 카드 열한 장이 이미
// 올라가 있고 엔진이 짓는 itemId 는 시드의 itemId 와 규칙이 달라 영원히 겹치지 않는다.
// 부르는 순간 같은 일이 두 장씩 쌓인다(scripts/seed-board.mjs 의 경고와 같은 이야기다).
//
// 그래서 여기서는 사실만 갱신한다. 카드는 만들지 않고, 감지도 돌리지 않는다. 새 강우값이
// 화면의 근거 문구까지 닿으려면 그 다음에 감지가 한 번 돌아야 하며, 그 시점은 시드 카드를
// 걷어내고 보드의 주인을 엔진으로 넘기는 날이다.
//
//   POST /api/board/weather  { "siteId": "...", "at": "2026-08-22T20:00:00+09:00" }
//   GET  /api/board/weather?siteId=...        저장하지 않고 지금 값만 본다

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

/**
 * 이 현장이 이미 쓰고 있는 강우 사실의 key.
 *
 * 델타는 (factType, key) 쌍으로 이어진다. 시드가 'gimpo_gochon#누적강우량' 을 쓰는데
 * 커넥터가 자기 이름인 '누적강우' 로 새 값을 넣으면 두 사실이 서로 다른 자리에 서고,
 * 이전 값이 없는 첫 관측으로 읽혀 T-01 의 "직전에 이미 임계치를 넘고 있었는가" 판정이
 * 무너진다. 그래서 쓰던 자리를 찾아 그 이름으로 맞춘다.
 */
function 강우자리(facts: SnapshotFact[]): string | null {
  const 강우 = facts
    .filter((fact) => {
      const value = fact.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return "누적강우량mm" in value || "누적강우량" in value;
    })
    .sort((a, b) => 관측시각(a) - 관측시각(b));
  return 강우.length > 0 ? 강우[강우.length - 1].key : null;
}

/**
 * 사실의 관측 시각을 밀리초로 읽는다.
 *
 * `SnapshotFact.observedAt` 의 타입은 string 이지만 Postgres 구현에서는 timestamptz 열이
 * 드라이버를 거치며 Date 객체로 실려 온다. 문자열이라고 믿고 `localeCompare` 를 부르면
 * 그 자리에서 터진다. 읽을 수 없는 값은 맨 앞으로 보내 최신 판정에서 지게 둔다.
 */
function 관측시각(fact: SnapshotFact): number {
  const 밀리초 = Date.parse(String(fact.observedAt));
  return Number.isFinite(밀리초) ? 밀리초 : 0;
}

async function 강우수집(siteId: string, at: Date) {
  // collectFacts 에 커넥터 하나만 넘긴다. 출역 명부와 공정표까지 함께 돌 이유가 없고,
  // 실패·타임아웃·중복키 처리는 그 실행기가 이미 들고 있다.
  const run = await collectFacts(siteId, at, [weatherConnector]);
  const 결과 = run.결과[0] ?? null;
  return { facts: run.facts, 결과 };
}

function 시각확인(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return kstNowIso();
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) return kstIsoOf(Date.parse(raw));
  return undefined;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const at = 시각확인(params.get("at") ?? undefined);
  if (at === undefined) return fail("at 은 ISO8601 시각이어야 합니다.", 400);

  const { facts, 결과 } = await 강우수집(siteId, new Date(Date.parse(at!)));
  return Response.json(
    { 실연동: isWeatherApiConfigured(), 기준시각: at, 결과, facts, 저장함: false },
    { headers: HEADERS },
  );
}

export async function POST(req: Request) {
  let body: { siteId?: unknown; at?: unknown };
  try {
    body = (await req.json()) as { siteId?: unknown; at?: unknown };
  } catch {
    return fail("JSON 본문이 필요합니다.", 400);
  }
  if (!body || typeof body !== "object") return fail("JSON 본문이 필요합니다.", 400);

  const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const at = 시각확인(body.at);
  if (at === undefined) return fail("at 은 ISO8601 시각이어야 합니다.", 400);

  try {
    const store = boardStore();
    const [수집, 기존] = await Promise.all([
      강우수집(siteId, new Date(Date.parse(at!))),
      store.listFacts(siteId, "weatherObservation"),
    ]);

    const 자리 = 강우자리(기존);
    const facts = 수집.facts.map((fact) =>
      자리 && fact.key === "누적강우" ? { ...fact, key: 자리 } : fact,
    );

    const deltas = facts.length > 0 ? await store.appendFacts(facts) : [];

    return Response.json(
      {
        실연동: isWeatherApiConfigured(),
        기준시각: at,
        결과: 수집.결과,
        // 어느 자리에 넣었는지 응답에 남긴다. 이어 붙지 않고 새 자리에 선 경우를
        // 호출한 쪽이 바로 알아볼 수 있어야 한다.
        강우자리: 자리,
        facts,
        deltas,
        저장함: true,
      },
      { status: 201, headers: HEADERS },
    );
  } catch (error) {
    if (isBoardStoreError(error)) {
      return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    }
    throw error;
  }
}
