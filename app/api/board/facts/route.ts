import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { 최신만 } from "@/lib/risk/rows";
import { FACT_TYPES, type FactType, type SnapshotFact } from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 스냅샷 팩트를 읽는다.
 *
 * `/api/board/snapshot` 에 얹지 않고 따로 둔 이유는 **양** 때문이다. 팩트는 이 현장 하나에만
 * 86건이고 위험성평가 행이 그 대부분인데, 첫 화면은 그 가운데 한 건도 쓰지 않는다.
 * 카드를 눌러 평가서를 펼칠 때만 부른다.
 *
 * 같은 key 를 접는 규칙은 `lib/risk/rows.ts` 의 `최신만` 에 있다 — 화면과 같은 규칙을
 * 써야 숫자가 어긋나지 않아서 한곳에 둔다.
 */

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  /*
   * `factType` 을 **필수**로 받는다.
   *
   * 없이도 되게 두면 이 라우트가 현장 하나의 팩트를 통째로 덤프하는 입구가 된다.
   * 이 콘솔에 인증이 없다는 것은 문서화된 결정이지만(`docs/board-contract.md:425`),
   * 그렇다고 새 라우트가 그 표면을 넓힐 이유는 없다. 화면은 언제나 종류를 정해서
   * 부른다 — 안 정하고 부르는 쪽이 없다.
   */
  const factType = params.get("factType")?.trim();
  if (!factType) return fail("factType 이 필요합니다.", 400);
  if (!FACT_TYPES.includes(factType as FactType)) {
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
 * 이 라우트가 **쓸 수 있는 종류.**
 *
 * 처음에는 `FACT_TYPES` 14종을 전부 받았다. 그런데 팩트 전량은 `app/api/board/detect`
 * 가 규칙 엔진에 그대로 먹이므로, 쓰는 사람 없이 열어 둔 종류는 **감지 결과를 임의로
 * 흔들 수 있는 입구**로만 남는다.
 *
 * 이 콘솔에 인증이 없다는 것은 문서화된 결정이지만(`docs/board-contract.md:425`,
 * `docs/handoff-board.md:309`), 그건 기존 표면을 감수한다는 뜻이지 새 라우트가 그것을
 * 넓혀도 된다는 뜻이 아니다. **화면이 실제로 쓰는 것만** 연다.
 *
 * 지금 둘이다 — 평가행(이행확인)과 결재 상태. 결재 상태를 연 이유는 §`결재상태인가`.
 */
const 쓰기허용 = ["riskAssessmentRow", "documentApprovalState"] as const;
type 쓰기종류 = (typeof 쓰기허용)[number];

/** 결재 상태가 가질 수 있는 값. 시드가 쓰는 것과 같다. */
const 결재상태값 = ["작성중", "결재대기", "결재완료"] as const;

/**
 * 결재 상태 값의 모양.
 *
 * 이 종류를 연 이유: 이행확인을 전부 채워도 결재 상태가 그대로였다. 화면은
 * "결재 상신을 올릴 수 있습니다" 라고 적으면서 **그 사실을 어디에도 기록하지 않았다.**
 * `제출가능` 필드를 읽는 코드가 레포에 한 줄도 없었다.
 *
 * `문서` 는 사람이 읽는 이름이고 `key` 는 문서 id 라 서로 다르다. 대조하지 않는다.
 */
function 결재상태인가(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.문서 !== "string" || !r.문서.trim()) return false;
  if (!결재상태값.includes(r.상태 as (typeof 결재상태값)[number])) return false;
  if (typeof r.제출가능 !== "boolean") return false;
  // 미비는 있어도 되고 없어도 되지만, 있으면 문자열 배열이어야 한다. 화면이 그대로 그린다.
  if (r.미비 !== undefined && (!Array.isArray(r.미비) || r.미비.some((x) => typeof x !== "string"))) {
    return false;
  }
  return true;
}

/**
 * 평가행 값의 모양을 본다. **뜻까지 보지는 않고, 소비자가 깨지지 않을 만큼만 본다.**
 *
 * 값 검증이 없으면 문자열이나 숫자를 넣어 이 값을 읽는 쪽(`lib/risk/rows.ts`,
 * `lib/detect/rules/*`)을 그대로 넘어뜨릴 수 있다.
 */
function 평가행인가(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.회의록 !== "string" || !r.회의록.trim()) return false;
  if (typeof r.행id !== "string" || !r.행id.trim()) return false;
  // 이행확인은 세 상태뿐이다. 다른 값이 들어오면 이행상태읽기가 조용히 "빈칸"으로 읽는다.
  if (r.이행확인 !== undefined && r.이행확인 !== true && r.이행확인 !== false && r.이행확인 !== "불일치") {
    return false;
  }
  return true;
}

/**
 * 팩트를 덧붙인다. **고치는 것도 덧붙이는 것이다.**
 *
 * 평가행을 수정하면 같은 key 로 새 팩트가 하나 더 쌓이고, 읽을 때 마지막 것이 이긴다
 * (위 `최신만`). 덮어쓰지 않으므로 **"8월 5일에는 이랬는데 오늘 이렇게 바뀌었다"** 가
 * 그대로 남는다 — 감지 엔진이 델타를 보는 방식과 같은 방식이다.
 *
 * **다만 "누가" 는 아직 안 남는다.** `SnapshotFact`(`lib/board/types.ts:213`)에 actor
 * 자리가 없다. 되짚을 수 있는 것은 무엇이 언제 바뀌었는지까지다 — 이행확인처럼 법적
 * 의미가 있는 값에는 모자란 이력이고, 스키마를 고쳐야 채워진다.
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
  if (!쓰기허용.includes(factType as 쓰기종류)) {
    return fail(`이 경로로는 ${쓰기허용.join(" · ")} 만 쓸 수 있습니다.`, 400);
  }
  if (!key) return fail("key 가 필요합니다.", 400);

  // 종류마다 값 모양을 따로 본다. 한쪽 검사를 다른 쪽에 쓰면 검사를 안 하는 것과 같다.
  let sourceDocId: string;
  if (factType === "riskAssessmentRow") {
    if (!평가행인가(b.value)) {
      return fail(
        'value 가 평가행 모양이 아닙니다. 회의록·행id 가 필요하고 이행확인은 true·false·"불일치" 중 하나여야 합니다.',
        400,
      );
    }
    // key 는 `문서id#행id` 다. 값과 어긋나면 다른 문서의 행을 덮어쓰게 된다.
    if (key !== `${b.value.회의록}#${b.value.행id}`) {
      return fail(`key 가 값과 어긋납니다. "${b.value.회의록}#${b.value.행id}" 여야 합니다.`, 400);
    }
    sourceDocId = String(b.value.회의록);
  } else {
    if (!결재상태인가(b.value)) {
      return fail(
        `value 가 결재 상태 모양이 아닙니다. 문서·제출가능(불리언)이 필요하고 상태는 ${결재상태값.join(" · ")} 중 하나여야 합니다.`,
        400,
      );
    }
    // 결재 상태의 key 는 문서 id 그 자체다.
    sourceDocId = key;
  }

  const fact: SnapshotFact = {
    siteId,
    factType: factType as 쓰기종류,
    key,
    value: b.value,
    // observedAt 은 서버가 찍는다. 화면이 보낸 시각을 믿으면 이력의 순서를 화면이 정한다.
    observedAt: new Date().toISOString(),
    // 출처와 확신도도 서버가 정한다. 사람이 화면에서 고친 것이므로 출처는 그 문서이고
    // 확신도는 1 이다. 클라이언트가 이 둘을 정하게 두면 위조가 진짜 기록처럼 보인다.
    sourceDocId,
    confidence: 1,
  };

  try {
    const deltas = await boardStore().appendFacts([fact]);
    return Response.json({ ok: true, fact, deltas }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
