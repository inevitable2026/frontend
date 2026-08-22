import { 어휘읽기 } from "@/lib/risk/safegrid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 드롭다운 어휘(업종·평가방법·매트릭스·장비 50종·자재 78종·산정기준).
 *
 * 화면에 목록을 박아 두지 않는 이유는, 저쪽이 어휘를 늘렸을 때 화면만 옛 목록으로
 * 남으면 사용자가 고른 값이 저쪽에서 인식되지 않기 때문이다. 다만 이 호출이 실패해도
 * 화면은 내장 목록으로 버틴다 — 어휘를 못 읽었다고 평가 자체를 막을 이유는 없다.
 */
export async function GET() {
  try {
    return Response.json(await 어휘읽기(), { headers: HEADERS });
  } catch (err) {
    console.error("[risk/vocabulary]", err);
    return Response.json(
      {
        error: "선택 목록을 읽지 못했습니다. 기본 목록으로 계속 작성하실 수 있습니다.",
        code: "vocabulary_failed",
      },
      { status: 502, headers: HEADERS },
    );
  }
}
