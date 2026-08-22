import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  hasToolCall,
  isStepCount,
  smoothStream,
  streamText,
  tool,
  toUIMessageStream,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";

import {
  isOfficialLawConfigured,
  readOfficialLaw,
  searchOfficialLaw,
  type LawReadResult,
  type LawReference,
} from "@/lib/agent/official-law";
import {
  boardContextSchema,
  createBoardTools,
  type BoardActionOutput,
  type BoardContext,
} from "@/lib/board/assistant-tools";

/**
 * 보드 AI 사이드바가 쓰는 스트리밍 경로. 답이 한 덩어리로 오는 `/api/chat` 과 달리
 * 도구 호출과 글자를 흘려보내므로, 화면이 **확인 과정을 실시간으로** 그리고 답을
 * 타이핑하듯 이어 붙일 수 있다. 챗봇 탭은 기존 경로를 그대로 쓴다.
 *
 * 도구는 두 갈래다. **보드 도구**는 요청이 실어 보낸 화면 스냅샷을 읽고 카드를 어떻게
 * 고칠지 정하고, **법령 도구**는 국가법령정보센터의 공식 원문을 찾아 읽는다. 무엇을 부를지는
 * 모델이 정한다 — 화면에는 문장을 규칙으로 해석하는 자리가 더 이상 없다.
 *
 * 한 요청이 **두 단계**로 나뉜다.
 * 1. 조사 — 도구를 열어 두고 읽기와 판정을 시킨다. 이 단계의 글은 화면에 내보내지 않는다.
 *    solar-pro4 는 도구를 못 부르는 상황에서 호출 규약을 그냥 글로 흘리기도 한다.
 * 2. 답 — 도구 없이, 조사 단계가 모은 근거만 붙여 글을 쓴다. 이 글만 화면에 흐른다.
 *
 * 인용 규칙은 `/api/chat` 과 같다 (`docs/company-chatbot-plan.md`).
 * - 검색 결과는 `citable: false` 인 후보일 뿐이고, 법적 주장은 읽기에 성공한 원문만 근거로 삼는다.
 * - 참조(`ref`)는 **이 요청 안에서 검색이 만든 것만** 읽을 수 있다. 지어낸 참조는 실패한다.
 * - 걸음 수와 본문 길이에 상한이 있다.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGES = 20;
const MAX_TEXT_LENGTH = 2_000;
const MAX_RESEARCH_STEPS = 5;

/** 도구가 스스로 낸 오류만 화면에 그대로 내보낸다. 나머지는 문구를 갈아 끼운다. */
const TOOL_ERROR_PREFIX = "TOOL:";

/** 조사 단계에서 처음 나오는 글을 이만큼 모아 보고 도구 규약인지 판별한다. */
const GUARD_SAMPLE_LENGTH = 24;

const NO_EVIDENCE_MESSAGE =
  "확인한 근거가 없어 답변을 드릴 수 없습니다. 보드 카드에 관한 일이면 카드 제목이나 조건 코드로 다시 말씀해 주시고, 법령 질문이면 국가법령정보센터에서 해당 법령·행정규칙 본문을 확인한 뒤 다시 문의해 주세요.";

const PROTOCOL_LEAK_MESSAGE =
  "확인은 마쳤지만 안전한 답변 형식으로 정리하지 못했습니다. 위 확인 과정에서 무엇을 열었는지 보시고, 질문 범위를 좁혀 다시 물어봐 주세요.";

const RESEARCH_PROMPT = [
  "당신은 한국 건설현장 담당자의 태스크 보드를 다루고, 필요하면 공식 법령 원문을 찾아 읽는 조사자입니다.",
  "보드의 카드에 관한 말이면 먼저 read_board 로 화면을 읽고, 고칠 카드의 itemId 를 확인한 뒤 move_card · approve_card · reject_card · select_date 를 부르세요.",
  "고칠 카드가 여럿으로 남거나 사용자가 기각 사유를 말하지 않았으면 고치는 도구를 부르지 말고 거기서 멈추세요. 되묻는 일은 다음 단계가 합니다.",
  "법령·의무·서류에 관한 질문이면 '굴착면 작업계획서'처럼 넓은 한국어 키워드로 search_official_law 를 부르고, 가장 관련성 높은 후보 하나를 골라 read_official_law 로 원문을 읽으세요.",
  "필요한 문서를 단정하지 말고 도구만 사용하세요. 설명하는 글은 쓰지 마세요.",
].join(" ");

const ANSWER_PROMPT = [
  "당신은 한국 건설현장 담당자를 돕는 답변 편집자입니다. 제공된 근거만 사용해 한국어로 답하세요.",
  "boardActions 에 적힌 변경은 화면에 이미 반영되었습니다. 무엇을 어떻게 바꿨는지 한두 문장으로 짧게 알리세요.",
  "boardReads 는 지금 화면의 보드입니다. 카드를 나열할 때는 제목·열·기한처럼 화면에 있는 값만 적고 itemId 는 적지 마세요.",
  "고칠 카드를 하나로 좁히지 못했거나 기각 사유가 없으면 무엇이 더 필요한지 되물으세요.",
  "법적 의무·기준·서류는 officialEvidence 의 공식 원문에서만 인용하고, 각 설명에 법령명·시행일과 제38조제1항처럼 정확한 조문을 적으세요.",
  "officialEvidence 가 비어 있으면 법적 판단을 하지 말고 공식 본문 확인이 필요하다고 답하세요.",
  "답변은 마크다운으로 쓰되 보드 조작 결과처럼 짧은 답에는 목록을 쓰지 말고, 점검 항목이 여럿일 때만 하이픈 목록으로 구분하세요.",
  "도구를 부를 수 없으며 call:, result:, 첨부: 같은 내부 표현을 출력하지 마세요.",
  "officialEvidence 를 인용한 답변의 마지막에만 일반 정보이며 최신 공식 법령과 전문가 검토가 필요하다는 점을 밝히세요.",
].join(" ");

/** 한국어는 공백으로 단어를 나누지 않아 `Intl.Segmenter` 로 끊는다 (smoothStream 문서 권장). */
const koreanSegmenter = new Intl.Segmenter("ko", { granularity: "word" });

function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

/** 법령 서비스가 던진 오류를 사람이 읽을 문장으로 바꾼다. 내부 코드는 밖으로 내보내지 않는다. */
function toolError(error: unknown): Error {
  const code = error instanceof Error ? error.message : "";
  if (code === "LAW_REFERENCE_INCOMPLETE") {
    return new Error(`${TOOL_ERROR_PREFIX} 이 후보는 원문을 열기에 정보가 모자랍니다. 다른 후보를 읽어 보세요.`);
  }
  if (code === "LAW_OC_MISSING") {
    return new Error(`${TOOL_ERROR_PREFIX} 공식 법령 조회 설정이 없어 원문을 열 수 없습니다.`);
  }
  return new Error(`${TOOL_ERROR_PREFIX} 공식 법령 서비스에서 원문을 가져오지 못했습니다.`);
}

/** 기본값은 모든 오류를 "An error occurred." 로 덮는다. 우리가 쓴 문장만 통과시킨다. */
function streamErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // 예상 밖의 오류는 화면에 그대로 내보내지 않되 서버 로그에는 남긴다. 그러지 않으면
  // 무엇이 잘못됐는지 알 길이 "요청을 처리하지 못했습니다" 한 줄뿐이다.
  if (!message.startsWith(TOOL_ERROR_PREFIX)) console.error("[board/assistant]", error);
  return message.startsWith(TOOL_ERROR_PREFIX)
    ? message.slice(TOOL_ERROR_PREFIX.length).trim()
    : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
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

/**
 * 요청이 실어 보낸 화면 스냅샷. 보드 도구가 볼 수 있는 유일한 보드이므로 없으면 그 도구도
 * 없는 셈이다 — 형식이 어긋나면 `null` 을 돌려주고 법령 도구만으로 답을 만든다.
 */
function parseBoard(value: unknown): BoardContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = boardContextSchema.safeParse((value as { board?: unknown }).board);
  return parsed.success ? parsed.data : null;
}

function lastUserQuestion(messages: UIMessage[]): string {
  const question = [...messages].reverse().find((message) => message.role === "user");
  if (question === undefined) return "";
  return question.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
}

/** 조사 단계가 흘리는 글을 버린다. 도구 호출과 그 결과만 화면으로 보낸다. */
function dropText<TOOLS extends ToolSet>(): TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>> {
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === "text-start" || chunk.type === "text-delta" || chunk.type === "text-end") return;
      controller.enqueue(chunk);
    },
  });
}

/**
 * 답의 첫머리를 조금 모아 보고 도구 호출 규약이면 통째로 막는다. 스트리밍이라 한 번 내보낸
 * 글은 지울 수 없으므로, 판단이 설 만큼만 붙들었다가 흘려보낸다.
 */
function guardToolProtocol<TOOLS extends ToolSet>(): TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>> {
  let sample = "";
  let decided = false;
  let blocked = false;
  let textId = "answer";

  function looksLikeProtocol(text: string): boolean {
    return /<\|tool_(?:call|arg)|^(?:call|result|첨부)\s*:/im.test(text.trim());
  }

  function decide(controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>): void {
    decided = true;
    blocked = looksLikeProtocol(sample);
    const text = blocked ? PROTOCOL_LEAK_MESSAGE : sample;
    if (text.length > 0) {
      controller.enqueue({ type: "text-delta", id: textId, text } as TextStreamPart<TOOLS>);
    }
    sample = "";
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === "text-start") {
        textId = chunk.id;
        controller.enqueue(chunk);
        return;
      }
      if (chunk.type === "text-delta") {
        if (blocked) return;
        if (decided) {
          controller.enqueue(chunk);
          return;
        }
        sample += chunk.text;
        if (sample.length >= GUARD_SAMPLE_LENGTH || sample.includes("\n")) decide(controller);
        return;
      }
      if (chunk.type === "text-end" && !decided) decide(controller);
      controller.enqueue(chunk);
    },
  });
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

  const question = lastUserQuestion(messages);
  if (question.length === 0) return jsonError("질문이 비어 있습니다.", 400);

  const board = parseBoard(body);
  const lawReady = isOfficialLawConfigured();

  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) return jsonError("AI 서비스 설정이 완료되지 않았습니다.", 503);
  // 법령 조회가 막혀 있어도 보드 스냅샷이 왔으면 카드 일은 할 수 있다. 둘 다 없을 때만 멈춘다.
  if (!lawReady && board === null) {
    return jsonError("공식 법령 조회 서비스 설정이 완료되지 않았습니다.", 503);
  }

  const upstage = createOpenAICompatible({
    name: "upstage",
    apiKey,
    baseURL: "https://api.upstage.ai/v1",
    // Upstage 전용 필드. 추론 토큰을 끄면 첫 글자가 빨리 온다. `parallel_tool_calls` 는
    // 도구가 실린 요청에만 붙인다 — 도구 없는 답 단계에 붙이면 서버가 요청을 거절한다.
    transformRequestBody: (args) => ({
      ...args,
      reasoning_effort: "none",
      ...(Array.isArray(args.tools) && args.tools.length > 0 ? { parallel_tool_calls: false } : {}),
    }),
  });
  const model = upstage.chatModel("solar-pro4");

  /** 이 요청 안에서만 사는 참조 사전. 다른 요청이나 모델이 지어낸 `ref` 는 여기 없다. */
  const references = new Map<string, LawReference>();
  /** 읽기에 성공한 공식 원문. 법적 주장이 딛고 설 수 있는 유일한 근거다. */
  const evidence: LawReadResult[] = [];
  /** 조사 단계가 읽은 보드와 화면에 내린 지시. 답 단계는 이 둘을 보고 무엇을 했는지 적는다. */
  const boardReads: unknown[] = [];
  const boardActions: BoardActionOutput[] = [];

  const lawTools = {
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
      execute: async ({ query, search }: { query: string; search?: "title" | "body" }) => {
        try {
          const found = await searchOfficialLaw(query, search === "title" ? "title" : "body");
          for (const [key, reference] of found.references) references.set(key, reference);
          return { searchMode: found.searchMode, candidates: found.candidates };
        } catch (error) {
          throw toolError(error);
        }
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
      execute: async ({ ref, provision }: { ref: string; provision?: string }) => {
        const reference = references.get(ref);
        // 이 요청의 검색이 만들지 않은 참조는 읽지 않는다. 실패도 답의 일부로 화면에 남는다.
        if (reference === undefined) {
          throw new Error(`${TOOL_ERROR_PREFIX} 이 요청의 검색 결과에 없는 참조입니다.`);
        }
        try {
          const result = await readOfficialLaw(reference, provision);
          evidence.push(result);
          return result;
        } catch (error) {
          throw toolError(error);
        }
      },
    }),
  };

  /** 이번 요청이 실제로 쥘 수 있는 손. 스냅샷이나 설정이 없으면 그 갈래는 아예 없다. */
  const tools = {
    ...(board === null ? {} : createBoardTools({ board, reads: boardReads, actions: boardActions })),
    ...(lawReady ? lawTools : {}),
  };

  const modelMessages = await convertToModelMessages(messages);

  const stream = createUIMessageStream({
    onError: streamErrorMessage,
    execute: async ({ writer }) => {
      const research = streamText({
        model,
        system: RESEARCH_PROMPT,
        messages: modelMessages,
        temperature: 0,
        // 원문을 한 번 읽으면 조사를 끝낸다. 그러지 않으면 도구만 부르다 걸음을 다 쓴다.
        stopWhen: [hasToolCall("read_official_law"), isStepCount(MAX_RESEARCH_STEPS)],
        // 첫 걸음은 도구를 부르게 한다. 어느 갈래인지는 모델이 고르되, 맨손으로 답부터
        // 쓰기 시작하면 그 글은 어차피 버려지고 답 단계에 넘길 근거도 남지 않는다.
        prepareStep: ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: "required" } : {}),
        tools,
      });

      writer.merge(
        toUIMessageStream({
          stream: research.stream.pipeThrough(dropText()),
          sendFinish: false,
          onError: streamErrorMessage,
        }),
      );
      await research.steps;

      if (evidence.length === 0 && boardReads.length === 0 && boardActions.length === 0) {
        const id = "no-evidence";
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: NO_EVIDENCE_MESSAGE });
        writer.write({ type: "text-end", id });
        return;
      }

      const answer = streamText({
        model,
        system: ANSWER_PROMPT,
        prompt: JSON.stringify({ question, boardActions, boardReads, officialEvidence: evidence }),
        temperature: 0,
        experimental_transform: smoothStream({ chunking: koreanSegmenter, delayInMs: 18 }),
      });

      writer.merge(
        toUIMessageStream({
          stream: answer.stream.pipeThrough(guardToolProtocol()),
          sendStart: false,
          onError: streamErrorMessage,
        }),
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}
