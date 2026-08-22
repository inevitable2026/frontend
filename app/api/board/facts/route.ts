import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { FACT_TYPES, type FactType, type SnapshotFact } from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 스냅샷 팩트를 읽는다.
 *
 * `/api/board/snapshot` 에 얹지 않고 따로 둔 이유는 **양** 때문이다. 팩트는 이 현장 하나에만
 * 86건이고 위험성평가 행이 그 대부분인데, 첫 화면은 그 가운데 한 건도 쓰지 않는다.
 * 스냅샷에 넣으면 보드를 열 때마다 아무도 안 보는 평가행을 통째로 실어 나르게 된다.
 * 카드를 눌러 평가서를 펼칠 때만 부른다.
 *
 * ## 같은 key 가 여러 번 나오는 것
 *
 * `data/board/seed-facts.json` 의 「키규칙」은 *"같은 (factType, key) 의 앞뒤 두 항목이 곧
 * 델타의 before · after"* 라고 말한다. 즉 **중복은 이력이지 오류가 아니다.** 지금 화면이
 * 물어보는 것은 "지금 상태"이므로 key 마다 **가장 나중 것 하나**로 접는다.
 *
 * 이걸 접지 않으면 실제로 숫자가 어긋난다. `ra_2026_08_regular` 의 이행확인이 빈 행은
 * 접으면 **9행**(카드가 말하는 수)이지만, 접지 않으면 `RI-11` 이 두 번 세어져 **10행**이 된다.
 */
function 최신만(facts: SnapshotFact[]): SnapshotFact[] {
  const 최신 = new Map<string, SnapshotFact>();
  for (const f of facts) {
    const 이전 = 최신.get(f.key);
    // observedAt 이 같으면 나중에 온 것을 쓴다. 배열 순서가 곧 기록 순서다.
    if (!이전 || 이전.observedAt <= f.observedAt) 최신.set(f.key, f);
  }
  return [...최신.values()];
}

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  const factType = params.get("factType")?.trim();
  if (factType && !FACT_TYPES.includes(factType as FactType)) {
    return fail(`factType 이 ${FACT_TYPES.join(" · ")} 가운데 하나여야 합니다.`, 400);
  }

  // 문서 하나로 좁힌다. 평가행 key 는 `문서id#행id` 라 접두사로 고를 수 있다.
  const docId = params.get("docId")?.trim();

  try {
    const all = await boardStore().listFacts(siteId, (factType as FactType) || undefined);
    const 골라낸 = docId ? all.filter((f) => f.key.startsWith(`${docId}#`)) : all;
    const facts = 최신만(골라낸);

    return Response.json(
      {
        siteId,
        factType: factType ?? null,
        docId: docId ?? null,
        /** 접기 전후를 함께 보인다. 숫자가 어긋날 때 어디서 접혔는지 알 수 있어야 한다. */
        총건수: 골라낸.length,
        facts,
      },
      { headers: HEADERS },
    );
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}

/**
 * 팩트를 덧붙인다. **고치는 것도 덧붙이는 것이다.**
 *
 * 평가행을 수정하면 같은 key 로 새 팩트가 하나 더 쌓이고, 읽을 때 마지막 것이 이긴다
 * (위 `최신만`). 덮어쓰지 않으므로 **"8월 5일에는 이랬는데 오늘 이렇게 바뀌었다"** 가
 * 그대로 남는다 — 감지 엔진이 델타를 보는 방식과 같은 방식이다.
 *
 * 이행확인처럼 법적 의미가 있는 값일수록 이 성질이 중요하다. 누가 언제 무엇을 바꿨는지
 * 되짚을 수 없는 이행확인은 이행확인이 아니다.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("본문이 JSON 이 아닙니다.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("본문이 객체여야 합니다.", 400);

  const b = body as Record<string, unknown>;
  const siteId = typeof b.siteId === "string" ? b.siteId.trim() : "";
  const factType = typeof b.factType === "string" ? b.factType.trim() : "";
  const key = typeof b.key === "string" ? b.key.trim() : "";

  if (!siteId) return fail("siteId 가 필요합니다.", 400);
  if (!FACT_TYPES.includes(factType as FactType)) {
    return fail(`factType 이 ${FACT_TYPES.join(" · ")} 가운데 하나여야 합니다.`, 400);
  }
  if (!key) return fail("key 가 필요합니다.", 400);
  if (b.value === undefined) return fail("value 가 필요합니다.", 400);

  // observedAt 은 서버가 찍는다. 화면이 보낸 시각을 믿으면 이력의 순서를 화면이 정하게 된다.
  const fact: SnapshotFact = {
    siteId,
    factType: factType as FactType,
    key,
    value: b.value,
    observedAt: new Date().toISOString(),
    sourceDocId: typeof b.sourceDocId === "string" ? b.sourceDocId : null,
    confidence: typeof b.confidence === "number" ? b.confidence : 1,
  };

  try {
    const deltas = await boardStore().appendFacts([fact]);
    return Response.json({ ok: true, fact, deltas }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
