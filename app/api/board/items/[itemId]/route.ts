import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import {
  TransitionError,
  planTransition,
  type TransitionInput,
  type TransitionPlan,
} from "@/lib/board/transition";
import type { WorkItem } from "@/lib/board/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

// Next.js 16 에서 동적 세그먼트는 Promise 로 넘어온다. 같은 레포의
// app/api/context/ingest/[jobId]/stream/route.ts 가 이미 같은 모양으로 받고 있다.
export async function PATCH(req: Request, ctx: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await ctx.params;
  if (!itemId?.trim()) return fail("itemId 가 필요합니다.", 400);

  let body: TransitionInput;
  try {
    body = (await req.json()) as TransitionInput;
  } catch {
    return fail("JSON 본문이 필요합니다.", 400);
  }
  if (!body || typeof body !== "object") return fail("JSON 본문이 필요합니다.", 400);

  const store = boardStore();

  try {
    const item = await store.getItem(itemId);
    if (!item) return fail("그런 카드가 없습니다.", 404);

    // 선행 카드는 완료로 옮길 때만 본다. 이미 지워진 선행은 셈에서 빠지고,
    // 남아 있는 것만 "아직 끝나지 않았다"의 근거가 된다.
    let blockers: WorkItem[] | undefined;
    if (item.blockedBy.length > 0) {
      const found = await Promise.all(item.blockedBy.map((id) => store.getItem(id)));
      blockers = found.filter((b): b is WorkItem => b !== null);
    }

    let plan: TransitionPlan;
    try {
      plan = planTransition(item, body, { blockers });
    } catch (error) {
      if (error instanceof TransitionError) return fail(error.message, error.status);
      throw error;
    }

    // 기각은 사유와 행위자를 함께 남겨야 해서 moveItem 이 아니라 rejectItem 으로 간다.
    const updated =
      plan.kind === "reject" && plan.rejectReason
        ? await store.rejectItem(itemId, plan.rejectReason, plan.actor ?? "user")
        : await store.moveItem(itemId, plan.patch);

    return Response.json({ item: updated }, { headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
