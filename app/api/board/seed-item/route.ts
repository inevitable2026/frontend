import seedItemsRaw from "@/data/board/seed-items.json" with { type: "json" };
import { BOARD_SITE_ID, BOARD_SITE_SEED_ID } from "@/lib/board/site";
import { boardStoreDriver } from "@/lib/board/store";
import type { WorkItem } from "@/lib/board/types";
import { db } from "@/lib/context/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 시드에서 내용이 바뀐 카드 하나를 배포 DB 에 다시 꽂는다.
 *
 * 왜 이 라우트가 있는가: scripts/seed-board.mjs 의 카드 적재는 `on conflict do nothing`
 * 이라(그 파일 §왜 이렇게 하는가) 이미 적재된 카드는 시드를 고쳐도 영영 갱신되지 않는다.
 * 같은 스크립트의 `--refresh-item` 이 그 갱신 입구인데, 프로덕션 Postgres 는 내부
 * 호스트(railway.internal)뿐이라 밖에서 닿을 수 없다 — DB 에 붙어 있는 것은 이 앱
 * 자신뿐이므로, 갱신도 여기서 한다.
 *
 * **이 라우트에는 인증을 건다.** 이 콘솔의 나머지는 무인증이고 그것은 문서화된 결정이지만
 * (`docs/board-contract.md:425`), 여기는 카드를 **지우고 다시 쓰는 곳**이다. 방식은
 * sweep 라우트와 같다 — `x-sweeper-token` 또는 `Authorization: Bearer <CRON_SECRET>`.
 * 토큰이 설정돼 있지 않으면 열어 두지 않고 막는다.
 *
 * 쓸 수 있는 내용은 **번들에 박힌 시드 그 자체뿐이다.** 요청 본문으로 카드 내용을 받지
 * 않는다 — 받으면 이 라우트가 임의 카드 주입구가 된다. 호출자는 어느 카드를 시드
 * 버전으로 되돌릴지(itemId)만 고른다.
 */

const seedItems = (seedItemsRaw as unknown as { items: WorkItem[] }).items;

function fail(message: string, status: number, code?: string) {
  return Response.json(code ? { error: message, code } : { error: message }, {
    status,
    headers: HEADERS,
  });
}

/** sweep 라우트의 허가됨() 과 같은 규칙. */
function 허가됨(request: Request): boolean {
  const token = process.env.SWEEPER_TOKEN?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const header = request.headers.get("x-sweeper-token")?.trim();

  if (token && header && header === token) return true;
  if (cronSecret && bearer && bearer === cronSecret) return true;
  return false;
}

export async function POST(request: Request) {
  if (!허가됨(request)) {
    // 왜 막혔는지는 적지 않는다. 토큰이 없어서인지 틀려서인지 알려 주면 그것 자체가 단서다.
    return fail("이 요청은 허용되지 않았습니다.", 401, "seed_item_unauthorized");
  }

  if (boardStoreDriver() !== "pg") {
    // JSON 저장소는 시드 파일이 곧 저장소라 이 라우트가 할 일이 없다.
    return fail("이 배포는 Postgres 저장소가 아닙니다. 시드 파일을 고치면 그대로 반영됩니다.", 400, "not_pg");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("JSON 본문이 필요합니다.", 400, "body_not_json");
  }
  const itemId =
    body && typeof body === "object" && typeof (body as { itemId?: unknown }).itemId === "string"
      ? ((body as { itemId: string }).itemId ?? "").trim()
      : "";
  if (!itemId) return fail("itemId 가 필요합니다.", 400, "item_id_required");

  const seed = seedItems.find((item) => item.itemId === itemId);
  if (!seed) return fail("시드에 그런 카드가 없습니다.", 404, "not_in_seed");

  // 시드 JSON 은 사람이 읽는 현장 이름을 쓴다. 적재 스크립트의 치환과 같은 자리다.
  const item: WorkItem = {
    ...seed,
    siteId: seed.siteId === BOARD_SITE_SEED_ID ? BOARD_SITE_ID : seed.siteId,
  };

  const sql = db();
  try {
    const result = await sql.begin(async (tx) => {
      const 지운 = await tx`
        delete from board.work_items
         where item_id = ${item.itemId} and site_id = ${item.siteId}::uuid
        returning item_id
      `;
      await tx`delete from board.invalidations where item_id = ${item.itemId}`;

      await tx`
        insert into board.work_items (
          item_id, site_id, timing, status, origin, title, summary, trigger,
          invalidates, produces, draft, confirmed_by, confirmed_at, due_by,
          estimated_minutes, assignee, delegable, blocked_by, lane_order, created_at, updated_at
        ) values (
          ${item.itemId}, ${item.siteId}::uuid, ${item.timing}, ${item.status}, ${item.origin},
          ${item.title}, ${item.summary ?? null}, ${JSON.stringify(item.trigger)}::jsonb,
          ${JSON.stringify(item.invalidates ?? [])}::jsonb, ${JSON.stringify(item.produces ?? [])}::jsonb,
          ${JSON.stringify(item.draft)}::jsonb, ${item.confirmedBy ?? null}, ${item.confirmedAt ?? null},
          ${item.dueBy ?? null}, ${item.estimatedMinutes ?? null}, ${item.assignee ?? null},
          ${item.delegable ?? true}, ${JSON.stringify(item.blockedBy ?? [])}::jsonb,
          ${item.laneOrder ?? 0}, ${item.createdAt}, ${item.updatedAt}
        )
      `;

      // 카드 안에도 jsonb 로 남지만 문서 쪽 역참조 색인을 따로 둔다 — seed-board.mjs 와 같다.
      for (const inv of item.invalidates ?? []) {
        await tx`
          insert into board.invalidations (item_id, run_id, doc_id, scope, reason, created_at)
          values (${item.itemId}, null, ${inv.docId}, ${inv.scope}, ${inv.reason}, ${item.createdAt})
          on conflict (item_id, doc_id, scope) do update set reason = excluded.reason
        `;
      }

      return { 이전존재: 지운.length > 0 };
    });

    return Response.json(
      {
        ok: true,
        itemId: item.itemId,
        존재하던카드를지움: result.이전존재,
        status: item.status,
        draftForm: item.draft?.form ?? null,
      },
      { headers: HEADERS },
    );
  } catch (error) {
    console.error("[board/seed-item] 갱신 실패:", error);
    return fail("카드를 갱신하지 못했습니다. 서버 로그를 확인해 주세요.", 503, "refresh_failed");
  }
}
