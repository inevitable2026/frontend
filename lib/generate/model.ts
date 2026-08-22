import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

// 생성 경로가 쓰는 모델을 한곳에서 만든다.
//
// 같은 설정이 app/api/board/assistant/route.ts 안에도 인라인으로 있었다. 그쪽은 사용자가
// 화면 앞에서 기다리는 스트리밍 경로이고 여기는 감지 배치라서, 두 곳이 같은 값을 쓰더라도
// 서로 다른 이유로 바뀔 수 있다. 그래서 억지로 합치지 않고 이 파일은 생성 경로만 소유한다.

const BASE_URL = "https://api.upstage.ai/v1";

/** 모델 이름을 환경 변수로 뺀다. 값이 없으면 지금 쓰는 모델로 돈다. */
const DEFAULT_MODEL = "solar-pro4";

export class GenerationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationUnavailableError";
  }
}

export function isGenerationConfigured(): boolean {
  return typeof process.env.UPSTAGE_API_KEY === "string" && process.env.UPSTAGE_API_KEY.length > 0;
}

/**
 * 생성 경로용 모델.
 *
 * `reasoning_effort` 를 끄지 않는다. 스트리밍 답변은 첫 글자가 빨리 나오는 것이 중요해서
 * 끄지만, 여기서 만드는 것은 회의록 초안과 공문 본문이라 시간보다 판단의 질이 앞선다.
 * 도구를 쓰지 않으므로 `parallel_tool_calls` 도 붙이지 않는다 — 도구 없는 요청에 붙이면
 * Upstage 가 요청 자체를 거절한다.
 */
export function generationModel(): LanguageModel {
  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) {
    throw new GenerationUnavailableError(
      "UPSTAGE_API_KEY 가 없어 생성 경로를 쓸 수 없습니다. .env.local 에 값을 넣어 주세요.",
    );
  }

  const upstage = createOpenAICompatible({
    name: "upstage",
    apiKey,
    baseURL: BASE_URL,
  });

  return upstage.chatModel(process.env.UPSTAGE_MODEL?.trim() || DEFAULT_MODEL);
}

/**
 * 한 번의 생성에 허용하는 재시도. AI SDK 가 스키마에 맞지 않는 응답을 받으면 다시 부른다.
 * 감지 배치라 사용자를 기다리게 하지 않으므로 기본값보다 넉넉하게 둔다.
 */
export const GENERATION_RETRIES = 3;
