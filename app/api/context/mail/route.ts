import { db } from "@/lib/context/db";
import { selectMailThreads } from "@/lib/context/mail-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 메일함 목록.
 *
 * 아직 메일 서버 커넥터가 없어서 lib/context/mail-threads.ts 의 고정 데이터를 돌려준다.
 * 그래도 라우트를 따로 두는 이유는, 화면이 문서함과 같은 방식으로 데이터를 받아 두면
 * 커넥터가 붙을 때 이 파일 하나만 고치면 되기 때문이다. 응답에 mock 플래그를 실어서
 * 화면이 "이건 실제 수신분이 아니다" 를 표시할 수 있게 한다.
 *
 * 현장은 uuid 로 들어오지만 목업은 코드(gimpo-gochon 등)로 묶여 있다. 배포마다 달라지는
 * uuid 를 고정 데이터에 박으면 다른 DB 에서 아무 스레드도 안 보이기 때문이다.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const siteId = params.get("siteId");
  const q = params.get("q");

  let siteCode: string | null = null;
  if (siteId) {
    if (!UUID.test(siteId)) {
      return Response.json({ error: "siteId 가 올바르지 않습니다." }, { status: 400, headers: HEADERS });
    }
    const sql = db();
    const [site] = await sql<Array<{ code: string }>>`select code from sites where id = ${siteId} limit 1`;
    if (!site) return Response.json({ error: "그런 현장이 없습니다." }, { status: 404, headers: HEADERS });
    siteCode = site.code;
  }

  const threads = selectMailThreads({ siteCode, q });
  return Response.json(
    { mock: true, total: threads.length, threads },
    { headers: HEADERS },
  );
}
