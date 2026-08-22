import { 문서파싱, 사진판독 } from "@/lib/risk/safegrid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 문서 파싱 실측 약 15초, 사진 판독 약 20초. `safegrid.ts` 의 45초보다 커야 우리 에러가 먼저 나온다. */
export const maxDuration = 60;

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 인제스트 프록시 (문서 · 사진).
 *
 * 라우트를 둘로 쪼개지 않은 이유는 에러 형태와 실행 한도가 완전히 같기 때문이다.
 * `종류` 필드 하나로 갈린다.
 *
 * **바디 크기 주의**: 휴대폰 카메라 사진은 장당 3~8MB 라 원본을 그대로 올리면 상한에
 * 걸린다. 화면이 올리기 전에 줄여서 보낸다 — 줄여야 할 곳은 네트워크를 타기 **전**이다.
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: "올린 파일을 읽지 못했습니다. 파일을 다시 선택해 올려 주세요.", code: "form_unreadable" },
      { status: 400, headers: HEADERS },
    );
  }

  const 종류 = String(form.get("종류") ?? "");
  const 파일들 = form.getAll("files").filter((v): v is File => v instanceof File);
  if (파일들.length === 0) {
    return Response.json(
      { error: "올린 파일이 없습니다. 파일을 선택해 주세요.", code: "no_files" },
      { status: 400, headers: HEADERS },
    );
  }

  try {
    if (종류 === "문서") {
      // 저쪽이 파일 하나만 받으므로 여기서 나눈다. 화면은 문서별로 패널을 따로 그린다.
      return Response.json({ 결과: await 문서파싱(파일들[0]) }, { headers: HEADERS });
    }
    if (종류 === "사진") {
      return Response.json({ 결과: await 사진판독(파일들) }, { headers: HEADERS });
    }
    console.error("[risk/ingest] 알 수 없는 종류:", 종류);
    return Response.json(
      {
        error: "문서와 사진 가운데 무엇을 올렸는지 알 수 없습니다. 화면을 새로 고친 뒤 다시 올려 주세요.",
        code: "unknown_kind",
      },
      { status: 400, headers: HEADERS },
    );
  } catch (err) {
    // 문서 분석은 폴백하지 않는다. 문서를 읽지 못했는데 표가 나오면 그 표의 근거가
    // 무엇인지 아무도 답할 수 없다.
    console.error("[risk/ingest]", err);
    return Response.json(
      {
        error:
          종류 === "사진"
            ? "사진을 읽지 못했습니다. 사진을 다시 확인한 뒤 다시 올려 주세요."
            : "문서를 분석하지 못했습니다. 파일을 다시 확인한 뒤 다시 올려 주세요.",
        code: "ingest_failed",
      },
      { status: 502, headers: HEADERS },
    );
  }
}
