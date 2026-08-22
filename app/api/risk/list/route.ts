import { 평가목록 } from "@/lib/risk/safegrid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 지금까지 만든 위험성평가 목록.
 *
 * 이 기록은 **SAFEGRID 자체 DB** 에 있다. 태스크 보드의 카드(감지 결과)와도, 공유
 * Postgres 의 `assessments` 테이블과도 다른 곳이다. 화면이 "기록 목록"을 표방하면서
 * 감지 카드만 보이면 실제로 만든 평가서가 통째로 사라진다.
 *
 * **필터가 없다.** 저쪽은 인스턴스 전체를 돌려주므로 다른 사람이 만든 것도 섞인다.
 * 현장 개념이 붙기 전까지는 그 사실을 화면에 적는다(「알려진 한계」).
 */
export async function GET() {
  try {
    return Response.json(await 평가목록(), { headers: HEADERS });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message || "평가 목록 조회 실패" },
      { status: 502, headers: HEADERS },
    );
  }
}
