import { generateObject } from "ai";
import { z } from "zod";

import {
  GENERATION_PROVIDER_OPTIONS,
  GENERATION_RETRIES,
  GenerationUnavailableError,
  generationModel,
  isGenerationConfigured,
} from "@/lib/generate/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 챗봇 편집 — **제안만 한다. 저장하지 않는다.**
 *
 * 모델이 바로 팩트를 쓰게 두지 않는 이유는 이행확인이 무엇인지에 있다. 이행확인은
 * "현장에서 실제로 실행되었다"는 사람의 진술이고, 그 진술을 모델이 대신하면 그건
 * **이행확인 위조**다. 그래서 여기서는 어느 행을 어떻게 바꿀지까지만 정하고,
 * 실제 반영은 화면에서 사람이 눌러야 일어난다.
 *
 * 같은 이유로 `이행확인: true` 는 제안 자체를 막는다(아래 스키마 주석 참고).
 */

const 제안스키마 = z.object({
  답: z.string().describe("사용자에게 할 말 한두 문장. 무엇을 왜 제안하는지."),
  제안: z
    .array(
      z.object({
        행id: z.string().describe("고칠 행의 행id. 반드시 주어진 목록에 있는 것이어야 한다."),
        이유: z.string().describe("이 행을 왜 이렇게 바꾸는지 한 문장"),
        대책추가: z.array(z.string()).describe("새로 더할 대책 문장들. 없으면 빈 배열").default([]),
        대책삭제: z.array(z.string()).describe("빼야 할 기존 대책 문장들. 없으면 빈 배열").default([]),
        담당사: z.string().describe("담당사를 바꿀 때만 코드. 안 바꾸면 빈 문자열").default(""),
      }),
    )
    .describe("바꿀 행들. 바꿀 것이 없으면 빈 배열"),
});

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

export async function POST(req: Request) {
  if (!isGenerationConfigured()) {
    return fail("생성 모델이 설정되지 않았습니다. 직접 편집 탭을 쓰세요.", 503);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("본문이 JSON 이 아닙니다.", 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const 지시 = typeof b.지시 === "string" ? b.지시.trim() : "";
  if (!지시) return fail("지시가 필요합니다.", 400);
  if (지시.length > 2_000) return fail("지시가 너무 깁니다.", 400);

  const 행들 = Array.isArray(b.행들) ? b.행들 : [];
  if (행들.length === 0) return fail("행이 없습니다.", 400);

  // 모델에 넘기는 것은 판단에 필요한 만큼이다. 행 전체를 그대로 실어 보내면
  // 토큰만 먹고, 모델이 고칠 수 없는 필드까지 고치려 든다.
  const 요약 = 행들.map((r) => {
    const v = r as Record<string, unknown>;
    return {
      행id: v.행id,
      공종분류: v.공종분류,
      단위작업: v.단위작업,
      위험요인: v.위험요인,
      사고분류: v.사고분류,
      대책: v.대책,
      담당사: v.담당사,
      이행확인: v.이행확인 === true,
      위험도: (v.개선전 as { 위험도?: number } | undefined)?.위험도,
    };
  });

  try {
    const { object } = await generateObject({
      model: generationModel(),
      schema: 제안스키마,
      maxRetries: GENERATION_RETRIES,
      providerOptions: GENERATION_PROVIDER_OPTIONS,
      system: [
        "당신은 건설 현장 안전관리자의 위험성평가 편집을 돕습니다.",
        "주어진 행 목록 안에서만 답하고, 목록에 없는 행id 를 지어내지 마십시오.",
        "대책은 현장에서 실행 가능한 구체적 행동으로 씁니다. '주의한다'·'철저히 한다' 같은 문장은 쓰지 마십시오.",
        "",
        "이행확인은 절대 제안하지 마십시오. 이행확인은 현장에서 실제 실행을 확인한 사람만 채울 수 있습니다.",
        "사용자가 이행확인을 채워 달라고 하면, 채우지 말고 '실제 실행 여부는 직접 확인하셔야 합니다'라고 답하십시오.",
        "다만 그 행들의 대책을 보강하는 제안은 할 수 있습니다.",
      ].join("\n"),
      prompt: [
        `지시: ${지시}`,
        "",
        "행 목록:",
        JSON.stringify(요약, null, 2),
      ].join("\n"),
    });

    // 모델이 없는 행id 를 냈으면 여기서 떨군다. 화면이 "적용" 을 눌렀을 때
    // 조용히 아무 일도 안 일어나는 것보다 아예 안 보이는 편이 낫다.
    const 있는id = new Set(요약.map((r) => String(r.행id)));
    const 제안 = object.제안.filter((p) => 있는id.has(p.행id));

    return Response.json(
      {
        답: object.답,
        제안,
        버려진제안: object.제안.length - 제안.length,
      },
      { headers: HEADERS },
    );
  } catch (error) {
    if (error instanceof GenerationUnavailableError) return fail(error.message, 503);
    return fail(error instanceof Error ? error.message : "제안을 만들지 못했습니다.", 502);
  }
}
