import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

// 생성 경로가 쓰는 모델을 한곳에서 만든다.
//
// 같은 설정이 app/api/board/assistant/route.ts 안에도 인라인으로 있었다. 그쪽은 사용자가
// 화면 앞에서 기다리는 스트리밍 경로이고 여기는 감지 배치라서, 두 곳이 같은 값을 쓰더라도
// 서로 다른 이유로 바뀔 수 있다. 그래서 억지로 합치지 않고 이 파일은 생성 경로만 소유한다.

const BASE_URL = "https://api.upstage.ai/v1";

/** providerOptions 의 열쇠이기도 하다. 두 곳이 어긋나면 설정이 조용히 무시된다 */
const PROVIDER_NAME = "upstage";

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
 *
 * `supportsStructuredOutputs` 를 켜는 것이 핵심이다. 끄면 AI SDK 가 `response_format` 을
 * `json_object` 로 보내는데, Upstage 는 그 모드에서 "메시지에 json 이라는 낱말이 있어야
 * 한다" 며 요청을 통째로 거절한다. 켜면 `json_schema` 로 보내고 그쪽은 그대로 받는다.
 */
export function generationModel(): LanguageModel {
  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) {
    throw new GenerationUnavailableError(
      "UPSTAGE_API_KEY 가 없어 생성 경로를 쓸 수 없습니다. .env.local 에 값을 넣어 주세요.",
    );
  }

  const upstage = createOpenAICompatible({
    name: PROVIDER_NAME,
    apiKey,
    baseURL: BASE_URL,
    supportsStructuredOutputs: true,
  });

  return upstage.chatModel(process.env.UPSTAGE_MODEL?.trim() || DEFAULT_MODEL);
}

/**
 * 모든 generateObject 호출에 함께 넘기는 프로바이더 설정.
 *
 * **strict 를 반드시 꺼야 한다.** AI SDK 는 기본으로 `strict: true` 를 보내는데, 그 모드의
 * solar-pro4 는 `pattern` 이나 `minLength` 가 걸린 문자열 필드를 만나면 값을 내지 못하고
 * 공백만 수천 자 뱉다가 멈춘다. 우리 스키마는 카드 key 에 정규식을, 제목에 길이 하한을
 * 걸고 있으므로 정확히 그 자리에 걸린다.
 *
 * 끄면 스키마가 강제가 아니라 안내가 되지만, 값은 제대로 나오고 형식이 어긋나면 zod 가
 * 잡아 AI SDK 가 다시 부른다. 강제되지 않는 스키마로 재시도하는 편이 강제된 스키마로
 * 무너지는 것보다 낫다.
 */
export const GENERATION_PROVIDER_OPTIONS = {
  [PROVIDER_NAME]: { strictJsonSchema: false },
} as const;

/**
 * 한 번의 생성에 허용하는 재시도. AI SDK 가 스키마에 맞지 않는 응답을 받으면 다시 부른다.
 * 감지 배치라 사용자를 기다리게 하지 않으므로 기본값보다 넉넉하게 둔다.
 */
export const GENERATION_RETRIES = 3;

/**
 * 출력 토큰 상한.
 *
 * 명시하지 않으면 "No object generated: could not parse the response" 가 드물지 않게 난다.
 * 모델이 JSON 을 쓰다가 상한에 걸려 중간에 끊기고, 닫히지 않은 객체는 당연히 파싱되지
 * 않는다. 재시도해도 같은 자리에서 같은 길이로 끊기므로 재시도가 답이 되지 못한다.
 *
 * 초안은 따로 크게 잡는다. 회의록 한 장에 행이 여럿이고 행마다 대책과 근거 조문이 붙어
 * 카드 계획이나 서사와는 자릿수가 다르다.
 */
export const GENERATION_MAX_TOKENS = 8_192;
export const DRAFT_MAX_TOKENS = 16_384;
