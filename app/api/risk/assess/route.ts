import { 평가생성, type 생성입력 } from "@/lib/risk/safegrid";
import type { 생성모드 } from "@/lib/risk/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 라이브 생성 실측 44~55초. 이 값을 안 적으면 Vercel 기본 실행 한도에서 함수가 먼저 죽어,
 * 우리가 만든 실패 메시지 대신 플랫폼 오류가 나간다.
 */
export const maxDuration = 60;

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 요청 본문 상한. 이 라우트는 인증이 없어 도메인만 알면 누구나 부를 수 있고,
 * 라이브는 한 번에 45초 넘게 생성 예산을 태운다. 크기 제한은 막을 수 있는 것 중
 * 가장 싼 축이다 — 다만 이것만으로 남용이 막히지는 않는다(「알려진 한계」).
 */
const 본문_상한 = 256 * 1024;

export async function POST(req: Request) {
  const 길이 = Number(req.headers.get("content-length") ?? 0);
  if (길이 > 본문_상한) {
    return Response.json(
      {
        error: "평가표를 만들지 못했습니다. 입력한 내용이 너무 깁니다. 내용을 줄여 다시 시도해 주세요.",
        code: "body_too_large",
      },
      { status: 413, headers: HEADERS },
    );
  }

  let 요청: (생성입력 & { 모드?: string }) | null;
  try {
    요청 = (await req.json()) as 생성입력 & { 모드?: string };
  } catch {
    return Response.json(
      {
        error: "평가표를 만들지 못했습니다. 보낸 내용을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
        code: "body_not_json",
      },
      { status: 400, headers: HEADERS },
    );
  }

  const 모드: 생성모드 = 요청?.모드 === "라이브" ? "라이브" : "데모";

  // 저쪽은 입력이 전부 비면 engine="claude" 라도 예외 없이 시드표로 떨어진다.
  // 그러면 화면에는 200 과 그럴듯한 표가 뜨는데 그건 아무 문서와도 상관이 없다.
  // 라이브를 골랐다면 여기서 막아, 조용한 폴백이 성공처럼 보이지 않게 한다.
  const 입력있음 =
    (요청?.work_types?.length ?? 0) > 0 ||
    (요청?.equipment?.length ?? 0) > 0 ||
    (요청?.materials?.length ?? 0) > 0 ||
    Boolean(요청?.description);
  if (모드 === "라이브" && !입력있음) {
    return Response.json(
      {
        error:
          "평가표를 만들지 못했습니다. 라이브 생성에는 공종·장비·자재 가운데 하나 이상이 필요합니다. 하나 이상 골라 주세요.",
        code: "live_input_required",
      },
      { status: 400, headers: HEADERS },
    );
  }

  try {
    const assessment = await 평가생성(모드, 요청 ?? {});
    return Response.json({ assessment }, { headers: HEADERS });
  } catch (err) {
    // 실패를 표로 덮지 않는다. 라이브가 실패했는데 시드표가 나가면 그 표의 근거를
    // 아무도 답할 수 없다 — 조용한 폴백은 이 화면에서 가장 위험한 종류의 버그다.
    // 원인은 서버 로그로 내린다. 화면에는 상태 코드가 아니라 다음에 할 일을 적는다.
    console.error("[risk/assess]", 모드, err);
    return Response.json(
      { error: "평가표를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.", code: "assess_failed" },
      { status: 502, headers: HEADERS },
    );
  }
}
