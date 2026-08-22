import {
  isOfficialLawConfigured,
  readOfficialLaw,
  searchOfficialLaw,
  type LawCandidate,
  type LawReadResult,
  type LawReference,
  type OfficialSource,
} from "@/lib/agent/official-law";

export const runtime = "nodejs";

const UPSTAGE_URL = "https://api.upstage.ai/v1/chat/completions";
const UPSTAGE_TIMEOUT_MS = 20_000;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_UPSTAGE_TURNS = 5;
const MAX_TOOL_CALLS = 6;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type UpstageResponse = { choices?: Array<{ message?: ChatMessage }> };
type ToolEvent = { type: "tool"; name: "search_official_law" | "read_official_law"; status: "completed" | "failed"; input: Record<string, string>; output: { candidates?: LawCandidate[]; searchMode?: "title" | "body"; fallbackUsed?: boolean; result?: LawReadResult; message?: string }; sources: OfficialSource[] };

const searchTool = { type: "function", function: { name: "search_official_law", description: "국가법령정보센터의 현행 법령과 행정규칙 후보를 검색합니다. 법적 주장을 하기 전 반드시 정확한 후보를 read 도구로 읽으세요.", parameters: { type: "object", properties: { query: { type: "string", description: "검색할 한국어 법령 키워드" }, search: { type: "string", enum: ["title", "body"], description: "법령명 자체를 찾을 때만 title, 의무·작업·서류 내용을 찾을 때는 body" } }, required: ["query"], additionalProperties: false } } } as const;
const readTool = { type: "function", function: { name: "read_official_law", description: "같은 요청에서 search_official_law가 반환한 ref만 읽습니다. 가장 관련성 높은 후보를 반드시 하나 선택하세요. 조문 번호가 확실할 때만 JO로 지정합니다.", parameters: { type: "object", properties: { ref: { type: "string", description: "search 결과의 ref" }, provision: { type: "string", pattern: "^[0-9]{6}$", description: "선택: 확실히 알고 있는 6자리 조문번호" } }, required: ["ref"], additionalProperties: false } } } as const;

function jsonError(message: string, status: number) { return Response.json({ error: { message } }, { status }); }

function parseQuestion(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.question !== "string") return null;
  const question = body.question.trim();
  return question.length > 0 && question.length <= MAX_QUESTION_LENGTH ? question : null;
}

function parseArguments(text: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}

function validSearchInput(value: Record<string, unknown> | null): { query: string; search: "title" | "body" } | null {
  if (!value || typeof value.query !== "string") return null;
  const query = value.query.trim();
  if (!query || query.length > 200 || Object.keys(value).some((key) => key !== "query" && key !== "search")) return null;
  return { query, search: value.search === "title" ? "title" : "body" };
}

function validReadInput(value: Record<string, unknown> | null): { ref: string; provision?: string } | null {
  if (!value || typeof value.ref !== "string" || Object.keys(value).some((key) => key !== "ref" && key !== "provision")) return null;
  const ref = value.ref.trim();
  if (!ref || ref.length > 100 || (value.provision !== undefined && (typeof value.provision !== "string" || !/^\d{6}$/.test(value.provision)))) return null;
  return { ref, ...(typeof value.provision === "string" ? { provision: value.provision } : {}) };
}

function cleanAssistantContent(content: string): string {
  const lines = content.trim().split(/\r?\n/);
  let firstContentLine = 0;

  while (
    firstContentLine < Math.min(lines.length, 4)
    && /^(?:call|result|첨부)\s*:/i.test(lines[firstContentLine].trim())
  ) {
    firstContentLine += 1;
  }

  return lines.slice(firstContentLine).join("\n").trim();
}

function hasToolProtocolText(content: string): boolean {
  return /<\|tool_(?:call|arg):|^(?:call|result|첨부)\s*:/im.test(content);
}

async function synthesizeGroundedAnswer(
  apiKey: string,
  question: string,
  events: ToolEvent[],
): Promise<string> {
  const evidence = events.flatMap((event) =>
    event.name === "read_official_law"
    && event.status === "completed"
    && event.output.result
      ? [event.output.result]
      : [],
  );

  if (evidence.length === 0) {
    return "공식 조문 본문을 읽어 확인한 결과가 없어 법적 판단이나 의무를 안내할 수 없습니다. 국가법령정보센터의 해당 법령·행정규칙 본문을 확인한 뒤 다시 문의해 주세요.";
  }

  const response = await callUpstage(apiKey, {
    model: "solar-pro4",
    reasoning_effort: "none",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "당신은 한국 건설현장 법령 정보 답변 편집자입니다. 제공된 공식 원문 근거만 사용해 한국어로 답하세요. 근거에 없는 법적 의무를 만들지 말고, 현장 조건이 부족하면 확정하지 말고 필요한 추가 정보를 질문하세요. 각 법적 설명에는 제공된 법령명·시행일과 국가법령정보센터 URL을 명시하세요. 각 법적 설명 문장이나 목록 항목에는 바로 뒤에 제38조제1항처럼 공식 원문에서 확인한 정확한 근거 조문을 적으세요. 답변은 마크다운으로 작성하고 점검 항목은 하이픈 목록으로 구분하세요. 검색이나 도구를 요청할 수 없으며 call:, result:, 첨부: 또는 tool_call 같은 내부 표현을 절대 출력하지 마세요. 답변은 일반 정보이고 최신 공식 법령 및 전문가 확인이 필요하다는 점을 마지막에 알리세요.",
      },
      {
        role: "user",
        content: JSON.stringify({ question, officialEvidence: evidence }),
      },
    ],
  });
  const content = response.choices?.[0]?.message?.content;
  const cleaned = content ? cleanAssistantContent(content) : "";

  if (!cleaned || hasToolProtocolText(cleaned)) {
    return "공식 법령 원문은 조회했지만 안전한 답변 형식으로 정리하지 못했습니다. 아래 확인 과정의 공식 원문 링크에서 내용을 확인하고 질문 범위를 좁혀 다시 문의해 주세요.";
  }

  return cleaned;
}

async function callUpstage(apiKey: string, body: Record<string, unknown>): Promise<UpstageResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTAGE_TIMEOUT_MS);

    try {
      const response = await fetch(UPSTAGE_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
        throw new Error("UPSTAGE_STATUS");
      }
      const data: unknown = await response.json();
      const result = data && typeof data === "object"
        ? data as UpstageResponse
        : null;
      if (!result?.choices?.[0]?.message) {
        if (attempt === 0) continue;
        throw new Error("UPSTAGE_INVALID");
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt > 0 || (error instanceof Error && error.message === "UPSTAGE_STATUS")) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("UPSTAGE_INVALID");
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError("JSON 형식의 요청 본문이 필요합니다.", 400); }
  const question = parseQuestion(body);
  if (!question) return jsonError(`question은 공백이 아닌 문자열 1개여야 하며 ${MAX_QUESTION_LENGTH}자 이하여야 합니다.`, 400);
  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) return jsonError("AI 서비스 설정이 완료되지 않았습니다.", 503);
  if (!isOfficialLawConfigured()) return jsonError("공식 법령 조회 서비스 설정이 완료되지 않았습니다.", 503);

  const messages: ChatMessage[] = [{ role: "system", content: "당신은 한국 법령 정보 탐색 보조자입니다. 한국어로 답하세요. 법적 주장·의무·기준은 반드시 read_official_law가 반환한 공식 본문에서만 인용하세요. 검색만 했거나 읽기 결과가 없으면 법적 판단을 유보하고 공식 본문 확인이 필요하다고 답하세요. 굴착공사 질문은 필요한 문서를 단정하지 말고 먼저 '굴착면 작업계획서'처럼 넓은 키워드로 본문 검색한 뒤 정확한 후보와 조문을 읽으세요. 응답에는 서버가 제공한 인용 링크와 기관·시행/발령일 정보를 사용하고, 일반 정보이며 최신 법령과 전문가 검토가 필요하다는 점을 밝히세요. 최종 답변 본문에는 call:, result:, 첨부: 같은 내부 도구 메타데이터를 출력하지 마세요. 도구 실행 과정은 UI가 별도로 표시합니다." }, { role: "user", content: question }];
  const refs = new Map<string, LawReference>();
  const events: ToolEvent[] = [];
  let toolCount = 0;

  try {
    for (let turn = 0; turn < MAX_UPSTAGE_TURNS; turn += 1) {
      const hasOfficialRead = events.some(
        (event) => event.name === "read_official_law" && event.status === "completed",
      );
      if (hasOfficialRead) {
        const content = await synthesizeGroundedAnswer(apiKey, question, events);
        return Response.json({ events: [...events, { type: "assistant", content }] });
      }
      const availableTools = hasOfficialRead
        ? null
        : refs.size > 0
          ? [readTool]
          : [searchTool];
      const response = await callUpstage(apiKey, {
        model: "solar-pro4",
        reasoning_effort: "none",
        temperature: 0,
        messages,
        ...(availableTools
          ? {
              tools: availableTools,
              tool_choice: "required",
              parallel_tool_calls: false,
            }
          : {}),
      });
      const assistant = response.choices?.[0]?.message;
      if (!assistant) return jsonError("AI 서비스 응답을 처리하지 못했습니다. 다시 시도해 주세요.", 502);
      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        const content = assistant.content
          ? cleanAssistantContent(assistant.content)
          : "";
        if (!content) return jsonError("AI 서비스 응답을 처리하지 못했습니다. 다시 시도해 주세요.", 502);
        const safeContent = hasOfficialRead
          ? content
          : "공식 조문 본문을 읽어 확인한 결과가 없어 법적 판단이나 의무를 안내할 수 없습니다. 국가법령정보센터의 해당 법령·행정규칙 본문을 확인한 뒤 다시 문의해 주세요.";
        return Response.json({ events: [...events, { type: "assistant", content: safeContent }] });
      }
      if (toolCount + calls.length > MAX_TOOL_CALLS || calls.some((call) => call.type !== "function" || (call.function.name !== "search_official_law" && call.function.name !== "read_official_law") || !call.id)) return jsonError("AI 서비스가 안전한 법령 조회 요청을 만들지 못했습니다. 다시 시도해 주세요.", 502);
      messages.push(assistant);
      for (const call of calls) {
        toolCount += 1;
        const args = parseArguments(call.function.arguments);
        try {
          if (call.function.name === "search_official_law") {
            const input = validSearchInput(args);
            if (!input) throw new Error("INVALID_TOOL_INPUT");
            const result = await searchOfficialLaw(input.query, input.search);
            result.references.forEach((value, key) => refs.set(key, value));
            events.push({
              type: "tool",
              name: "search_official_law",
              status: "completed",
              input,
              output: {
                candidates: result.candidates,
                searchMode: result.searchMode,
                fallbackUsed: result.searchMode !== input.search,
              },
              sources: [],
            });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ candidates: result.candidates, searchMode: result.searchMode, instruction: "후보는 법적 근거가 아닙니다. 가장 관련성 높은 후보 하나를 read_official_law로 읽으세요." }) });
          } else {
            const input = validReadInput(args);
            if (!input || !refs.has(input.ref)) throw new Error("INVALID_REFERENCE");
            const result = await readOfficialLaw(refs.get(input.ref)!, input.provision);
            events.push({ type: "tool", name: "read_official_law", status: "completed", input, output: { result }, sources: [result.source] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          }
        } catch {
          const name = call.function.name as ToolEvent["name"];
          const input = args && Object.keys(args).every((key) => typeof args[key] === "string") ? Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value).slice(0, 200)])) : {};
          events.push({ type: "tool", name, status: "failed", input, output: { message: "공식 법령 정보를 조회하지 못했습니다. 다른 검색어로 다시 시도하거나 국가법령정보센터에서 확인하세요." }, sources: [] });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "공식 법령 정보를 조회하지 못했습니다. 이 결과를 법적 근거로 사용하지 마세요." }) });
        }
      }
    }
    return Response.json({
      events: [
        ...events,
        {
          type: "assistant",
          content: "공식 법령을 확인하는 과정이 조회 한도 안에 끝나지 않았습니다. 현재 결과만으로 법적 판단을 안내하지 않으며, 질문 범위를 좁혀 다시 시도해 주세요.",
        },
      ],
    });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "AbortError";
    return jsonError(timeout ? "AI 서비스 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요." : "AI 서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.", timeout ? 504 : 502);
  }
}
