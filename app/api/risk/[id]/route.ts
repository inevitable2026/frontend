import { 이행확인저장, 평가읽기 } from "@/lib/risk/safegrid";
import type { Assessment } from "@/lib/risk/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 평가 1건 조회.
 *
 * 이 경로는 **우리가 첫 사용자**다. tbm-check 는 조회를 자기 Postgres 로 하기 때문에
 * SAFEGRID 의 `GET /assessments/{id}` 를 한 번도 부르지 않는다. 여기는 자기 DB 가 없어
 * 저쪽을 유일한 근거로 삼는다.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json({ assessment: await 평가읽기(id) }, { headers: HEADERS });
  } catch (err) {
    console.error("[risk/:id] 조회", id, err);
    return Response.json(
      { error: "평가서를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.", code: "read_failed" },
      { status: 502, headers: HEADERS },
    );
  }
}

/**
 * 이행확인 저장.
 *
 * 화면 상태만 바꾸면 안 된다 — 엑셀은 저쪽이 만들고 이행확인 열을 저쪽 DB 에서 읽는다.
 * 여기로 보내지 않으면 화면에는 체크가 보이는데 내려받은 파일은 전부 빈칸이다.
 *
 * **경합 주의**: 저쪽은 전체 payload 를 치환하고 If-Match 도 인증도 없다. 두 사람이 같은
 * 평가를 열고 각자 체크하면 마지막 저장이 이긴다. 지금은 막지 않고 한계로 남긴다.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let assessment: Assessment;
  try {
    assessment = (await req.json()) as Assessment;
  } catch {
    return Response.json(
      {
        error: "이행확인을 저장하지 못했습니다. 보낸 내용을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
        code: "body_not_json",
      },
      { status: 400, headers: HEADERS },
    );
  }

  try {
    return Response.json({ assessment: await 이행확인저장(id, assessment) }, { headers: HEADERS });
  } catch (err) {
    console.error("[risk/:id] 이행확인 저장", id, err);
    return Response.json(
      { error: "이행확인을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.", code: "save_failed" },
      { status: 502, headers: HEADERS },
    );
  }
}
