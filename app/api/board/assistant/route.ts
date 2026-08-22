import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  smoothStream,
  streamText,
  tool,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { z } from "zod";

import {
  isOfficialLawConfigured,
  readOfficialLaw,
  searchOfficialLaw,
  type LawReference,
} from "@/lib/agent/official-law";

/**
 * 보드 AI 사이드바가 쓰는 스트리밍 경로. 답이 한 덩어리로 오는 `/api/chat` 과 달리
 * 도구 호출과 글자를 흘려보내므로, 화면이 **확인 과정을 실시간으로** 그리고 답을
 * 타이핑하듯 이어 붙일 수 있다. 챗봇 탭은 기존 경로를 그대로 쓴다.
 *
 * 인용 규칙은 `/api/chat` 과 같다 (`docs/company-chatbot-plan.md`).
 * - 검색 결과는 `citable: false` 인 후보일 뿐이고, 법적 주장은 읽기에 성공한 원문만 근거로 삼는다.
 * - 참조(`ref`)는 **이 요청 안에서 검색이 만든 것만** 읽을 수 있다. 지어낸 참조는 실패한다.
 * - 첫 걸음은 반드시 검색이고, 걸음 수와 본문 길이에 상한이 있다.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGES = 20;
const MAX_TEXT_LENGTH = 2_000;
const MAX_STEPS = 5;

const SYSTEM_PROMPT = [
  "당신은 한국 건설현장 법령 정보 탐색 보조자입니다. 한국어로 답하세요.",
  "법적 주장·의무·기준은 반드시 read_official_law 가 반환한 공식 본문에서만 인용하세요.",
  "검색만 했거나 읽기 결과가 없으면 법적 판단을 유보하고 공식 본문 확인이 필요하다고 답하세요.",
  "굴착공사 질문은 필요한 문서를 단정하지 말고 먼저 '굴착면 작업계획서'처럼 넓은 키워드로 본문을 검색한 뒤 정확한 후보와 조문을 읽으세요.",
  "각 법적 설명에는 확인한 법령명·시행일과 제38조제1항처럼 정확한 근거 조문을 적으세요.",
  "답변은 마크다운으로 쓰고 점검 항목은 하이픈 목록으로 구분하세요.",
  "call:, result:, 첨부: 같은 내부 도구 표현은 출력하지 마세요. 도구 실행 과정은 화면이 따로 보여 줍니다.",
  "마지막에 일반 정보이며 최신 공식 법령과 전문가 검토가 필요하다는 점을 밝히세요.",
].join(" ");

/** 한국어는 공백으로 단어를 나누지 않아 `Intl.Segmenter` 로 끊는다 (smoothStream 문서 권장). */
const koreanSegmenter = new Intl.Segmenter("ko", { granularity: "word" });

function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

/** 들어온 대화가 우리가 감당하기로 한 모양인지 본다. 개수와 길이에 상한을 둔다. */
function parseMessages(value: unknown): UIMessage[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return null;

  for (const message of messages) {
    if (!message || typeof message !== "object") return null;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return null;
    for (const part of parts) {
      if (!part || typeof part !== "object") return null;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.length > MAX_TEXT_LENGTH) return null;
    }
  }
  return messages as UIMessage[];
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("JSON 형식의 요청 본문이 필요합니다.", 400);
  }

  const messages = parseMessages(body);
  if (messages === null) {
    return jsonError(`messages 는 ${MAX_MESSAGES}개 이하여야 하고 각 조각은 ${MAX_TEXT_LENGTH}자 이하여야 합니다.`, 400);
  }

  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) return jsonError("AI 서비스 설정이 완료되지 않았습니다.", 503);
  if (!isOfficialLawConfigured()) return jsonError("공식 법령 조회 서비스 설정이 완료되지 않았습니다.", 503);

  const upstage = createOpenAICompatible({
    name: "upstage",
    apiKey,
    baseURL: "https://api.upstage.ai/v1",
    // Upstage 전용 필드. 추론 토큰을 끄면 첫 글자가 빨리 오고, 도구는 한 번에 하나만 부른다.
    transformRequestBody: (args) => ({ ...args, reasoning_effort: "none", parallel_tool_calls: false }),
  });

  /** 이 요청 안에서만 사는 참조 사전. 다른 요청이나 모델이 지어낸 `ref` 는 여기 없다. */
  const references = new Map<string, LawReference>();

  const result = streamText({
    model: upstage.chatModel("solar-pro4"),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    temperature: 0,
    stopWhen: isStepCount(MAX_STEPS),
    // 첫 걸음은 검색으로 고정한다. 읽을 대상은 검색이 만든 뒤에야 생긴다.
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0
        ? { toolChoice: "required", activeTools: ["search_official_law"] }
        : {},
    experimental_transform: smoothStream({ chunking: koreanSegmenter, delayInMs: 18 }),
    tools: {
      search_official_law: tool({
        description:
          "국가법령정보센터의 현행 법령과 행정규칙 후보를 검색합니다. 결과는 아직 인용할 수 없는 후보이므로, 법적 주장을 하기 전에 반드시 read_official_law 로 원문을 읽으세요.",
        inputSchema: z.object({
          query: z.string().min(1).max(200).describe("검색할 한국어 법령 키워드"),
          search: z
            .enum(["title", "body"])
            .optional()
            .describe("법령명 자체를 찾을 때만 title, 의무·작업·서류 내용을 찾을 때는 body"),
        }),
        execute: async ({ query, search }) => {
          const found = await searchOfficialLaw(query, search === "title" ? "title" : "body");
          for (const [key, reference] of found.references) references.set(key, reference);
          return { searchMode: found.searchMode, candidates: found.candidates };
        },
      }),
      read_official_law: tool({
        description:
          "같은 요청에서 search_official_law 가 반환한 ref 만 읽습니다. 가장 관련성 높은 후보를 하나 고르고, 조문 번호가 확실할 때만 provision 을 지정하세요.",
        inputSchema: z.object({
          ref: z.string().min(1).max(100).describe("search 결과의 ref"),
          provision: z
            .string()
            .regex(/^\d{6}$/)
            .optional()
            .describe("선택: 확실히 알고 있는 6자리 조문번호"),
        }),
        execute: async ({ ref, provision }) => {
          const reference = references.get(ref);
          // 이 요청의 검색이 만들지 않은 참조는 읽지 않는다. 실패도 답의 일부로 화면에 남는다.
          if (reference === undefined) throw new Error("이 요청의 검색 결과에 없는 참조입니다.");
          return await readOfficialLaw(reference, provision);
        },
      }),
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
