import { randomUUID } from "node:crypto";
import { postgresSweepPort, sweep, SWEEPER_RECOVERY_POLICY } from "@/lib/context/sweeper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 버려진 문서 적재 잡을 회수한다.
 *
 * **이 라우트에는 인증을 건다.** 이 콘솔의 나머지는 무인증이고 그것은 문서화된 결정이지만
 * (`docs/board-contract.md:425`), 여기는 **지우는 곳**이다. 주소를 아는 사람이 남의 진행 중
 * 문서를 회수해 버릴 수 있으면 안 된다. 읽기 라우트와 같은 취급을 할 수 없다.
 *
 * 두 가지 방식으로 부를 수 있다:
 * - `POST` + `x-sweeper-token` — 사람이나 스크립트가 부를 때
 * - `GET` + `Authorization: Bearer <CRON_SECRET>` — Vercel 크론이 부르는 모양
 *
 * 토큰이 설정돼 있지 않으면 **열어 두지 않고 막는다.** 비밀이 없는 삭제 라우트는
 * 비밀이 없는 것이 아니라 아무나 쓰는 것이다.
 */

function fail(message: string, status: number, code?: string) {
  return Response.json(code ? { error: message, code } : { error: message }, { status, headers: HEADERS });
}

function 허가됨(request: Request): boolean {
  const token = process.env.SWEEPER_TOKEN?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const header = request.headers.get("x-sweeper-token")?.trim();

  if (token && header && header === token) return true;
  if (cronSecret && bearer && bearer === cronSecret) return true;
  return false;
}

async function 회수(request: Request): Promise<Response> {
  if (!허가됨(request)) {
    // 왜 막혔는지는 적지 않는다. 토큰이 없어서인지 틀려서인지 알려 주면 그것 자체가 단서다.
    return fail("이 요청은 허용되지 않았습니다.", 401, "sweeper_unauthorized");
  }

  const params = new URL(request.url).searchParams;
  const dryRun = params.get("dryRun") === "true";
  const limitParam = Number(params.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, Math.floor(limitParam)) : undefined;

  /*
   * `owner` 를 응답에 돌려주는 이유.
   *
   * 라이브 게이트가 요구하는 `sweeper.healthy` 는 **"cleanup-only-v1 회수기가 건강하다"**
   * 는 주장이다. 그런데 `studio_sweeper_health` 한 행만 보면 그것을 누가 썼는지 알 수 없다 —
   * 지금 공유 DB 에는 출처를 알 수 없는 회수기가 하나 더 돌면서 같은 행을 갱신하고 있다.
   *
   * 그래서 이 라우트가 쓴 owner 를 돌려주고, `scripts/studio-db-health.mjs` 가 그 값이
   * 행에 그대로 남아 있는지 대조한다. 그러면 증명이 **이 레포의 코드가 방금 돌았다** 는
   * 뜻이 된다. 그 대조가 없으면 남이 찍은 하트비트를 우리 것이라 서명하는 셈이다.
   */
  const owner = randomUUID();

  try {
    const result = await sweep(postgresSweepPort(), { owner, dryRun, limit });
    // 지어내지 않는다. 실제로 몇 건을 보고 몇 건을 잡고 몇 건을 지웠는지 그대로 준다.
    return Response.json(
      { recoveryPolicy: SWEEPER_RECOVERY_POLICY, owner, dryRun, ...result },
      { headers: HEADERS },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`문서 정리에 실패했습니다. ${detail}`, 500, "sweeper_failed");
  }
}

export async function POST(request: Request) {
  return 회수(request);
}

export async function GET(request: Request) {
  return 회수(request);
}
