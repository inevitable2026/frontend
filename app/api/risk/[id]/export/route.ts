import { 엑셀받기 } from "@/lib/risk/safegrid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 엑셀 내려받기 — 저쪽이 만든 파일을 그대로 흘려보낸다.
 *
 * 여기서 다시 만들지 않는 이유는, 서식(9컬럼·병합·인쇄영역)이 SEEXR 양식에 맞춰져 있고
 * 그 정본이 저쪽에 있기 때문이다. 두 곳에서 만들면 언젠가 서로 달라진다.
 *
 * 이행확인·담당자는 저쪽 DB 의 payload 에서 읽히므로, 체크를 PATCH 로 먼저 보내지 않으면
 * 여기서 받은 파일은 그 열이 비어 있다.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const res = await 엑셀받기(id);
  if (!res.ok) {
    return Response.json(
      { error: `엑셀 생성 실패 (${res.status})` },
      { status: 502, headers: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  }

  return new Response(res.body, {
    headers: {
      "content-type":
        res.headers.get("content-type") ??
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // 저쪽이 정한 파일명을 그대로 쓴다. 한글 파일명이라 인코딩이 붙어 있다.
      "content-disposition": res.headers.get("content-disposition") ?? "attachment",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
