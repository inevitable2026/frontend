import {
  isAssessmentIndexConfigured,
  readAssessment,
  searchAssessments,
  type AssessmentCandidate,
  type AssessmentReadResult,
  type AssessmentReference,
} from "@/lib/agent/assessment-index";
import {
  isOfficialLawConfigured,
  readOfficialLaw,
  searchOfficialLaw,
  type LawCandidate,
  type LawReadResult,
  type LawReference,
  type OfficialSource,
} from "@/lib/agent/official-law";
import {
  isCompanyContextConfigured,
  readCompanyDocument,
  searchCompanyContext,
  type CompanyCandidate,
  type CompanyReadResult,
  type CompanyReference,
} from "@/lib/agent/site-context";
import { isSiteFactsConfigured, readSiteFacts, type SiteFact } from "@/lib/agent/site-facts";
import { FACT_TYPES } from "@/lib/board/types";
import { DOCUMENT_KINDS, type DocumentKind } from "@/lib/context/types";

/**
 * 챗봇 탭의 왕복 한 번. 답은 스트림이 아니라 `{ events: [...] }` JSON 한 덩어리다
 * (`components/chat/parse.ts` 가 이 모양을 읽는다).
 *
 * 근거는 **네 갈래**다. 법령은 국가법령정보센터 원문, 사내 서류와 위험성평가표는 pgvector
 * 검색, 현장 사실은 보드 저장소. 갈래가 늘어난 만큼 규칙도 갈라진다 —
 * **법적 주장은 법령 원문에서만** 나오고, 사내 문서는 현장에서 무엇이 있었는지만 말한다.
 * 사내 문서로 법적 판단을 하면 합성 데이터가 법이 되는 셈이라 이 경계는 프롬프트가 아니라
 * 근거를 세 바구니로 나눠 담는 것으로 지킨다(`collectEvidence`).
 *
 * 인용 규칙은 `docs/company-chatbot-plan.md` 그대로다.
 * - 검색 결과는 `citable: false` 인 후보일 뿐이고, 읽기에 성공한 것만 근거다.
 * - 참조(`ref`)는 **이 요청의 검색이 만든 것만** 읽을 수 있다. 계열마다 사전이 따로 있고
 *   요청이 끝나면 사라지므로, 모델이 지어낸 ref 도 이전 요청의 ref 도 통하지 않는다.
 */

export const runtime = "nodejs";
// LLM 을 부르는 다른 라우트(app/api/board/assistant·briefing·detect …)와 같은 관례다.
// 도구 계열이 넷이 되면서 한 요청의 Upstage 왕복이 최대 7회(조사 6턴 + 종합 1회)가 됐다.
// 선언이 없으면 플랫폼 기본 상한에서 함수가 잘리고, 그때는 아래 Response.json 도 catch 의
// 504 안내도 나가지 못해 이미 읽어 둔 법령 원문과 사내 근거가 통째로 버려진다.
export const maxDuration = 300;

const UPSTAGE_URL = "https://api.upstage.ai/v1/chat/completions";
const UPSTAGE_TIMEOUT_MS = 20_000;
const MAX_QUESTION_LENGTH = 2_000;
// 도구 계열이 넷(법령·사내문서·평가표·현장사실)이 되면서 "검색→읽기" 한 쌍으로 끝나지
// 않는다. 핵심 시나리오인 "법적으로 빠진 서류 확인"만 해도 법령 원문 한 번과 사내 검색이
// 함께 필요하다. 상한을 없애지는 않는다 — 도구 실패가 반복될 때 왕복이 무한히 늘어난다.
const MAX_UPSTAGE_TURNS = 6;
const MAX_TOOL_CALLS = 10;
// 조사 루프에 허용하는 시간. 왕복 상한만으로는 시간이 안 잡힌다 — Upstage 한 번이 재시도
// 포함 40초, law.go.kr 검색 한 번이 최대 80초라 6턴이면 maxDuration 을 넘길 수 있다.
// 예산을 넘기면 502 로 되돌리지 않고 halted 로 끊어 지금까지 모은 근거로 답한다.
// 남긴 70초는 종합 한 번(재시도 포함 40초)과 응답 직렬화 몫이다.
const INVESTIGATION_BUDGET_MS = 230_000;

const NO_EVIDENCE_MESSAGE = "확인한 근거가 없어 답변을 드릴 수 없습니다. 법령 질문이면 국가법령정보센터의 해당 법령·행정규칙 본문을, 사내 자료 질문이면 업로드된 문서를 확인한 뒤 질문 범위를 좁혀 다시 문의해 주세요.";
const LIMIT_MESSAGE = "자료를 확인하는 과정이 조회 한도 안에 끝나지 않았습니다. 현재 결과만으로 판단을 안내하지 않으며, 질문 범위를 좁혀 다시 시도해 주세요.";
const PROTOCOL_LEAK_MESSAGE = "자료는 확인했지만 안전한 답변 형식으로 정리하지 못했습니다. 아래 확인 과정에 남은 원문 링크와 문서 제목을 보시고, 질문 범위를 좁혀 다시 문의해 주세요.";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type UpstageResponse = { choices?: Array<{ message?: ChatMessage }> };

const TOOL_NAMES = [
  "search_official_law",
  "read_official_law",
  "search_company_context",
  "read_company_document",
  "search_assessments",
  "read_assessment",
  "read_site_facts",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

/**
 * 읽기 결과는 계열이 달라도 `result` 한 자리에 담는다. 화면(`parse.ts`)이 도구 이름으로
 * 먼저 갈라 보기 때문에 자리를 나눌 이유가 없고, 서버에서는 필드 이름(`excerpt`·
 * `documentId`·`assessmentId`)이 서로 겹치지 않아 그대로 좁혀진다.
 */
type ToolEvent = {
  type: "tool";
  name: ToolName;
  status: "completed" | "failed";
  input: Record<string, string | number>;
  output: {
    candidates?: LawCandidate[] | CompanyCandidate[] | AssessmentCandidate[];
    searchMode?: "title" | "body";
    fallbackUsed?: boolean;
    result?: LawReadResult | CompanyReadResult | AssessmentReadResult;
    facts?: SiteFact[];
    message?: string;
  };
  sources: OfficialSource[];
};

/** 법적 주장이 딛고 설 수 있는 유일한 근거와, 현장 사실만 말할 수 있는 근거를 갈라 담는다. */
type CompanyEvidence =
  | { 근거종류: "사내문서"; 근거: CompanyReadResult }
  | { 근거종류: "위험성평가"; 근거: AssessmentReadResult };
type GroundedEvidence = {
  officialEvidence: LawReadResult[];
  companyEvidence: CompanyEvidence[];
  factEvidence: SiteFact[];
};

const searchTool = { type: "function", function: { name: "search_official_law", description: "국가법령정보센터의 현행 법령과 행정규칙 후보를 검색합니다. 법적 주장을 하기 전 반드시 정확한 후보를 read 도구로 읽으세요.", parameters: { type: "object", properties: { query: { type: "string", description: "검색할 한국어 법령 키워드" }, search: { type: "string", enum: ["title", "body"], description: "법령명 자체를 찾을 때만 title, 의무·작업·서류 내용을 찾을 때는 body" } }, required: ["query"], additionalProperties: false } } } as const;
const readTool = { type: "function", function: { name: "read_official_law", description: "같은 요청에서 search_official_law가 반환한 ref만 읽습니다. 가장 관련성 높은 후보를 반드시 하나 선택하세요. 조문 번호가 확실할 때만 JO로 지정합니다.", parameters: { type: "object", properties: { ref: { type: "string", description: "search 결과의 ref" }, provision: { type: "string", pattern: "^[0-9]{6}$", description: "선택: 확실히 알고 있는 6자리 조문번호" } }, required: ["ref"], additionalProperties: false } } } as const;
const companySearchTool = { type: "function", function: { name: "search_company_context", description: "우리 회사가 업로드한 사내 서류(하도급계약서·위험성평가표·TBM회의록·작업표준·순회점검일지 등)의 본문을 의미로 검색합니다. 계약 조건, 현장에서 실제로 무엇을 했는지, 어떤 서류가 있고 없는지 확인할 때 부르세요. 결과는 후보일 뿐이므로 인용하기 전에 read_company_document로 본문을 읽어야 합니다.", parameters: { type: "object", properties: { query: { type: "string", description: "검색할 한국어 키워드" }, kind: { type: "string", enum: DOCUMENT_KINDS, description: "선택: 찾는 서류 종류가 확실할 때만 지정" } }, required: ["query"], additionalProperties: false } } } as const;
const companyReadTool = { type: "function", function: { name: "read_company_document", description: "같은 요청에서 search_company_context가 반환한 ref만 읽습니다. 인용할 수 있는 것은 이렇게 읽은 본문뿐입니다. 앞뒤 청크가 함께 붙어 나옵니다.", parameters: { type: "object", properties: { ref: { type: "string", description: "search_company_context 결과의 ref" } }, required: ["ref"], additionalProperties: false } } } as const;
const assessmentSearchTool = { type: "function", function: { name: "search_assessments", description: "SAFEGRID 에 등록된 위험성평가표 행(공종·단위작업·사고분류·위험요인·대책·개선 전후 위험도·법적근거)을 의미로 검색합니다. 이 색인에는 다른 사람이 만든 평가도 섞여 있어 현장 소속이 확인되지 않으므로 '우리 현장의 기록' 이라고 말하면 안 됩니다. 어떤 위험이 이미 식별되어 있고 무슨 대책이 적혀 있는지 볼 때 부르세요. 결과는 후보일 뿐이므로 인용하기 전에 read_assessment로 읽어야 합니다.", parameters: { type: "object", properties: { query: { type: "string", description: "검색할 한국어 키워드. 공종이나 위험요인으로 찾으세요" } }, required: ["query"], additionalProperties: false } } } as const;
const assessmentReadTool = { type: "function", function: { name: "read_assessment", description: "같은 요청에서 search_assessments가 반환한 ref만 읽습니다. 평가표 한 행이 그대로 나오며, 이 본문만 인용할 수 있습니다.", parameters: { type: "object", properties: { ref: { type: "string", description: "search_assessments 결과의 ref" } }, required: ["ref"], additionalProperties: false } } } as const;
const factsTool = { type: "function", function: { name: "read_site_facts", description: "현장에서 관측된 사실을 최신순으로 바로 읽습니다. 날씨·공정·TBM 기록·문서 승인 상태처럼 오늘 현장이 어떤 상태인지 물을 때 부르세요. 검색 단계가 없으며 이 도구의 결과는 관측 시각과 함께 인용합니다.", parameters: { type: "object", properties: { factType: { type: "string", enum: FACT_TYPES, description: "선택: 한 종류만 볼 때 지정. 비우면 모든 종류를 최신순으로 봅니다" }, limit: { type: "integer", minimum: 1, maximum: 100, description: "선택: 가져올 사실 수. 기본 20" } }, required: [], additionalProperties: false } } } as const;

function jsonError(message: string, status: number) { return Response.json({ error: { message } }, { status }); }

function parseQuestion(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.question !== "string") return null;
  const question = body.question.trim();
  return question.length > 0 && question.length <= MAX_QUESTION_LENGTH ? question : null;
}

function parseArguments(text: string): Record<string, unknown> | null {
  // read_site_facts 는 인자가 하나도 필수가 아니라서 모델이 빈 문자열을 실어 보내기도 한다.
  // 그것까지 파싱 실패로 몰면 인자 없는 정상 호출이 도구 실패로 기록된다.
  if (text.trim().length === 0) return {};
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

function validCompanySearchInput(value: Record<string, unknown> | null): { query: string; kind?: DocumentKind } | null {
  if (!value || typeof value.query !== "string") return null;
  const query = value.query.trim();
  if (!query || query.length > 200 || Object.keys(value).some((key) => key !== "query" && key !== "kind")) return null;
  if (value.kind !== undefined && !(typeof value.kind === "string" && (DOCUMENT_KINDS as string[]).includes(value.kind))) return null;
  return { query, ...(typeof value.kind === "string" ? { kind: value.kind as DocumentKind } : {}) };
}

/** 평가표 검색은 인자가 query 하나뿐이다. search 같은 남의 계열 필드를 받아 주지 않는다. */
function validQueryInput(value: Record<string, unknown> | null): { query: string } | null {
  if (!value || typeof value.query !== "string" || Object.keys(value).some((key) => key !== "query")) return null;
  const query = value.query.trim();
  return query && query.length <= 200 ? { query } : null;
}

/** 사내 문서·평가표 읽기는 인자가 ref 하나뿐이다. 미지 필드는 여기서 잘라 낸다. */
function validRefInput(value: Record<string, unknown> | null): { ref: string } | null {
  if (!value || typeof value.ref !== "string" || Object.keys(value).some((key) => key !== "ref")) return null;
  const ref = value.ref.trim();
  return ref && ref.length <= 100 ? { ref } : null;
}

function validFactsInput(value: Record<string, unknown> | null): { factType?: string; limit?: number } | null {
  if (!value || Object.keys(value).some((key) => key !== "factType" && key !== "limit")) return null;
  // 모르는 factType 은 readSiteFacts 가 던지도록 두지 않고 여기서 막는다. 도구 인자 검증은
  // 보안 경계라 모듈마다 판단이 갈리면 안 된다.
  if (value.factType !== undefined && !(typeof value.factType === "string" && (FACT_TYPES as string[]).includes(value.factType))) return null;
  if (value.limit !== undefined && !(typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 100)) return null;
  return { ...(typeof value.factType === "string" ? { factType: value.factType } : {}), ...(typeof value.limit === "number" ? { limit: value.limit } : {}) };
}

/** 화면이 보여 줄 인자만 남긴다. 객체나 undefined 를 그대로 실어 보내지 않는다. */
function eventInput(value: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]): Array<[string, string | number]> =>
      typeof item === "string" ? [[key, item.slice(0, 200)]]
        : typeof item === "number" && Number.isFinite(item) ? [[key, item]]
          : [],
    ),
  );
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

/**
 * 확인 과정을 근거 세 바구니로 옮긴다. 여기서 갈라 담은 대로 답변의 권한이 정해진다 —
 * 법령 원문만 법적 주장을 할 수 있고, 나머지는 현장에서 무엇이 있었는지만 말한다.
 */
function collectEvidence(events: ToolEvent[]): GroundedEvidence {
  const officialEvidence: LawReadResult[] = [];
  const companyEvidence: CompanyEvidence[] = [];
  const factEvidence: SiteFact[] = [];

  for (const event of events) {
    if (event.status !== "completed") continue;
    const result = event.output.result;
    if (event.name === "read_official_law" && result && "excerpt" in result) officialEvidence.push(result);
    else if (event.name === "read_company_document" && result && "documentId" in result) companyEvidence.push({ 근거종류: "사내문서", 근거: result });
    else if (event.name === "read_assessment" && result && "assessmentId" in result) companyEvidence.push({ 근거종류: "위험성평가", 근거: result });
    else if (event.name === "read_site_facts" && event.output.facts) factEvidence.push(...event.output.facts);
  }

  return { officialEvidence, companyEvidence, factEvidence };
}

function isEmptyEvidence(evidence: GroundedEvidence): boolean {
  return evidence.officialEvidence.length === 0
    && evidence.companyEvidence.length === 0
    && evidence.factEvidence.length === 0;
}

async function synthesizeGroundedAnswer(
  apiKey: string,
  question: string,
  evidence: GroundedEvidence,
): Promise<string> {
  // 세 갈래가 모두 비었을 때만 거부한다. 사내 근거만 있어도 현장 사실은 답할 수 있고,
  // 그 답에는 법적 판단을 하지 않았다는 말이 붙는다.
  if (isEmptyEvidence(evidence)) return NO_EVIDENCE_MESSAGE;

  const response = await callUpstage(apiKey, {
    model: "solar-pro4",
    reasoning_effort: "none",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "당신은 한국 건설현장 정보 답변 편집자입니다. 제공된 근거만 사용해 한국어로 답하세요. 법적 주장·의무·기준·처벌은 officialEvidence 의 공식 원문에서만 인용하고, 각 설명 문장이나 목록 항목 바로 뒤에 법령명·시행일과 제38조제1항처럼 정확한 조문, 그리고 서버가 준 국가법령정보센터 URL 을 적으세요. 사내 문서나 위험성평가표로 법적 판단을 하지 마세요. officialEvidence 가 비어 있으면 법령 원문을 확인하지 않았으므로 법적 판단은 하지 않았다는 점을 반드시 밝히고 의무를 단정하지 마세요. 현장에서 실제로 무엇이 있었는지는 companyEvidence 와 factEvidence 에서만 말하고, 인용할 때마다 문서 제목·현장명·쪽 번호를 밝히세요. 사내 문서의 쪽 번호는 근거의 pages 에 있는 값만 쓰고, 여러 쪽이면 '2~3쪽' 처럼 범위로 적으며, pages 가 비어 있으면 쪽 번호를 지어내지 말고 쪽 정보가 없다고 적으세요. 근거종류가 '위험성평가' 인 것은 SAFEGRID 에 등록된 평가이고 현장소속이 확인되지 않았으므로 '우리 현장의 기록' 이라고 쓰지 말고 소속이 확인되지 않은 평가라는 점을 밝히세요. source 가 '합성' 인 근거를 인용할 때는 시연을 위해 만든 합성 문서라는 점을 그 문장 안에 반드시 적으세요. factEvidence 를 인용할 때는 observedAt 의 관측 시각과 source 를 함께 적으세요. 근거에 없는 것을 지어내지 말고, 확인되지 않은 것은 근거가 없다고 답하세요. 현장 조건이 부족하면 확정하지 말고 필요한 추가 정보를 질문하세요. 답변은 마크다운으로 작성하고 점검 항목은 하이픈 목록으로 구분하세요. 검색이나 도구를 요청할 수 없으며 call:, result:, 첨부: 또는 tool_call 같은 내부 표현을 절대 출력하지 마세요. 답변은 일반 정보이고 최신 공식 법령 및 전문가 확인이 필요하다는 점을 마지막에 알리세요.",
      },
      {
        role: "user",
        content: JSON.stringify({ question, ...evidence }),
      },
    ],
  });
  const content = response.choices?.[0]?.message?.content;
  const cleaned = content ? cleanAssistantContent(content) : "";

  if (!cleaned || hasToolProtocolText(cleaned)) return PROTOCOL_LEAK_MESSAGE;

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

/** 실패한 도구가 무엇이었는지에 따라 다음 시도를 다르게 안내한다. */
function failureMessage(name: ToolName): string {
  if (name === "search_official_law" || name === "read_official_law") return "공식 법령 정보를 조회하지 못했습니다. 다른 검색어로 다시 시도하거나 국가법령정보센터에서 확인하세요.";
  if (name === "read_site_facts") return "현장 사실을 읽지 못했습니다. 이 결과를 근거로 사용하지 마세요.";
  if (name === "search_assessments" || name === "read_assessment") return "위험성평가표를 조회하지 못했습니다. 아직 색인되지 않았거나 검색어가 맞지 않을 수 있습니다.";
  return "사내 문서를 조회하지 못했습니다. 다른 검색어로 다시 시도하세요.";
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError("JSON 형식의 요청 본문이 필요합니다.", 400); }
  const question = parseQuestion(body);
  if (!question) return jsonError(`question은 공백이 아닌 문자열 1개여야 하며 ${MAX_QUESTION_LENGTH}자 이하여야 합니다.`, 400);
  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey) return jsonError("AI 서비스 설정이 완료되지 않았습니다.", 503);

  // 설정이 없는 갈래는 그 도구만 빠진다. 법령만 켜져 있으면 예전과 똑같이 돌고, 사내 자료만
  // 켜져 있으면 법적 판단 없이 현장 사실만 답한다. 전부 막혔을 때만 요청을 되돌린다.
  const lawReady = isOfficialLawConfigured();
  const companyReady = isCompanyContextConfigured();
  const assessmentReady = isAssessmentIndexConfigured();
  const factsReady = isSiteFactsConfigured();
  if (!lawReady && !companyReady && !assessmentReady && !factsReady) {
    return jsonError("법령·사내 자료 조회 서비스 설정이 완료되지 않았습니다.", 503);
  }

  const messages: ChatMessage[] = [{ role: "system", content: "당신은 한국 건설현장 담당자를 돕는 자료 조사자입니다. 한국어로 답하세요. 근거는 네 갈래이며 갈래마다 할 수 있는 말이 다릅니다. 법적 주장·의무·기준은 반드시 read_official_law 가 반환한 공식 본문에서만 인용하고, 사내 문서로 법적 판단을 하지 마세요. 굴착공사처럼 필요한 서류를 묻는 질문은 문서를 단정하지 말고 먼저 '굴착면 작업계획서'처럼 넓은 키워드로 search_official_law 를 본문 검색한 뒤 가장 관련성 높은 후보를 읽으세요. 우리 회사가 실제로 무엇을 했는지, 어떤 서류가 있고 없는지는 search_company_context 로 찾아 read_company_document 로 읽으세요. 이미 식별한 위험과 대책은 search_assessments 로 찾아 read_assessment 로 읽으세요. 오늘 현장 상태(날씨·공정·TBM·문서 승인)는 read_site_facts 로 바로 읽으세요. 법령과 사내 자료를 함께 물어보면 두 갈래를 모두 확인하세요 — 법령 원문을 읽었다고 해서 사내 자료 확인을 건너뛰지 마세요. 검색 결과는 후보일 뿐이라 인용할 수 없고, 같은 요청의 검색이 만든 ref 만 읽을 수 있습니다. 더 확인할 것이 없으면 도구를 그만 부르세요. 최종 답변은 다음 단계가 작성하므로 여기서는 설명하는 글을 쓰지 말고 call:, result:, 첨부: 같은 내부 도구 메타데이터를 출력하지 마세요." }, { role: "user", content: question }];

  /** 계열마다 사전이 따로 있다. 요청이 끝나면 함께 사라지므로 다음 요청이 물려받지 않는다. */
  const refs = new Map<string, LawReference>();
  const docRefs = new Map<string, CompanyReference>();
  const assessmentRefs = new Map<string, AssessmentReference>();
  const events: ToolEvent[] = [];
  let toolCount = 0;
  let halted = false;

  try {
    let turn = 0;
    for (; turn < MAX_UPSTAGE_TURNS; turn += 1) {
      // 시간 예산도 도구 호출 예산과 똑같이 halted 로 끊는다. 여기서 한 왕복을 더 시작하면
      // 함수가 플랫폼 상한에 잘려 모아 둔 근거가 통째로 사라진다.
      if (Date.now() - startedAt > INVESTIGATION_BUDGET_MS) { halted = true; break; }

      // 검색 도구와 현장 사실은 언제나 열어 둔다. 읽기 도구는 그 계열의 검색이 ref 를
      // 만들었을 때만 연다 — 열려 있지 않은 도구는 지어낸 ref 로도 부를 수 없다.
      const availableTools = [
        ...(lawReady ? [searchTool] : []),
        ...(companyReady ? [companySearchTool] : []),
        ...(assessmentReady ? [assessmentSearchTool] : []),
        ...(factsReady ? [factsTool] : []),
        ...(refs.size > 0 ? [readTool] : []),
        ...(docRefs.size > 0 ? [companyReadTool] : []),
        ...(assessmentRefs.size > 0 ? [assessmentReadTool] : []),
      ];
      const response = await callUpstage(apiKey, {
        model: "solar-pro4",
        reasoning_effort: "none",
        temperature: 0,
        messages,
        tools: availableTools,
        // 첫 걸음만 도구를 강제한다. 어느 갈래를 열지는 모델이 고르고, 그 뒤로는 그만 부를
        // 자유를 준다 — 강제로 묶어 두면 더 볼 것이 없는데도 엉뚱한 도구를 부른다.
        tool_choice: turn === 0 ? "required" : "auto",
        parallel_tool_calls: false,
      });
      const assistant = response.choices?.[0]?.message;
      if (!assistant) return jsonError("AI 서비스 응답을 처리하지 못했습니다. 다시 시도해 주세요.", 502);
      const calls = assistant.tool_calls ?? [];
      // 도구를 그만 불렀다 = 조사 끝. 이 단계가 쓴 글은 근거 없이 나온 것이라 버리고,
      // 답은 모아 둔 근거만 가지고 종합 단계가 새로 쓴다.
      if (calls.length === 0) break;
      if (calls.some((call) => call.type !== "function" || !call.id || !(TOOL_NAMES as readonly string[]).includes(call.function.name))) {
        return jsonError("AI 서비스가 안전한 자료 조회 요청을 만들지 못했습니다. 다시 시도해 주세요.", 502);
      }
      // 예산을 넘기면 502 로 되돌리지 않고 여기까지 모은 근거로 답한다. 이미 읽은 원문을
      // 버리는 쪽이 사용자에게 더 나쁘다.
      if (toolCount + calls.length > MAX_TOOL_CALLS) { halted = true; break; }
      messages.push(assistant);
      for (const call of calls) {
        toolCount += 1;
        const name = call.function.name as ToolName;
        const args = parseArguments(call.function.arguments);
        try {
          if (name === "search_official_law") {
            const input = validSearchInput(args);
            if (!input) throw new Error("INVALID_TOOL_INPUT");
            const result = await searchOfficialLaw(input.query, input.search);
            result.references.forEach((value, key) => refs.set(key, value));
            events.push({ type: "tool", name, status: "completed", input: eventInput(input), output: { candidates: result.candidates, searchMode: result.searchMode, fallbackUsed: result.searchMode !== input.search }, sources: [] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ candidates: result.candidates, searchMode: result.searchMode, instruction: "후보는 법적 근거가 아닙니다. 가장 관련성 높은 후보 하나를 read_official_law로 읽으세요." }) });
          } else if (name === "read_official_law") {
            const input = validReadInput(args);
            if (!input || !refs.has(input.ref)) throw new Error("INVALID_REFERENCE");
            const result = await readOfficialLaw(refs.get(input.ref)!, input.provision);
            events.push({ type: "tool", name, status: "completed", input: eventInput(input), output: { result }, sources: [result.source] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          } else if (name === "search_company_context") {
            const input = validCompanySearchInput(args);
            if (!input) throw new Error("INVALID_TOOL_INPUT");
            const result = await searchCompanyContext(input.query, input.kind ? { kind: input.kind } : undefined);
            result.references.forEach((value, key) => docRefs.set(key, value));
            // 사내 문서는 외부 공개 URL 이 없다. 링크는 화면이 output.result.url 로 만든다.
            events.push({ type: "tool", name, status: "completed", input: eventInput(input), output: { candidates: result.candidates }, sources: [] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ candidates: result.candidates, instruction: "후보는 근거가 아닙니다. 인용하려면 read_company_document 로 본문을 읽으세요. source 가 '합성' 인 문서는 시연용으로 만든 자료이며 그 사실을 답변에 밝혀야 합니다." }) });
          } else if (name === "read_company_document") {
            const input = validRefInput(args);
            const reference = input && docRefs.get(input.ref);
            if (!input || !reference) throw new Error("INVALID_REFERENCE");
            const result = await readCompanyDocument(reference);
            events.push({ type: "tool", name, status: "completed", input: eventInput(input), output: { result }, sources: [] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          } else if (name === "search_assessments") {
            const input = validQueryInput(args);
            if (!input) throw new Error("INVALID_TOOL_INPUT");
            const result = await searchAssessments(input.query);
            result.references.forEach((value, key) => assessmentRefs.set(key, value));
            events.push({ type: "tool", name, status: "completed", input: eventInput(input), output: { candidates: result.candidates }, sources: [] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ candidates: result.candidates, instruction: "후보는 근거가 아닙니다. 인용하려면 read_assessment 로 해당 행을 읽으세요. 평가표 문장은 모델이 만든 합성 자료이며 그 사실을 답변에 밝혀야 합니다. 이 색인은 SAFEGRID 인스턴스 전체이고 현장 소속이 확인되지 않으므로 '우리 현장의 기록' 이라고 쓰지 마세요." }) });
          } else if (name === "read_assessment") {
            const input = validRefInput(args);
            const reference = input && assessmentRefs.get(input.ref);
            if (!input || !reference) throw new Error("INVALID_REFERENCE");
            const result = await readAssessment(reference);
            events.push({ type: "tool", name, status: "completed", input: eventInput(input), output: { result }, sources: [] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          } else {
            const input = validFactsInput(args);
            if (!input) throw new Error("INVALID_TOOL_INPUT");
            const facts = await readSiteFacts(input);
            events.push({ type: "tool", name, status: "completed", input: eventInput(input), output: { facts }, sources: [] });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ facts, instruction: "각 사실은 observedAt 의 관측 시각과 source 를 함께 인용해야 합니다. source 가 '합성' 으로 시작하면 시연용 자료입니다." }) });
          }
        } catch {
          events.push({ type: "tool", name, status: "failed", input: eventInput(args ?? {}), output: { message: failureMessage(name) }, sources: [] });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: `${failureMessage(name)} 이 결과를 근거로 사용하지 마세요.` }) });
        }
      }
    }

    const evidence = collectEvidence(events);
    // 한도에 걸려 멈췄는데 근거도 없으면 "왜 답이 없는지"가 다르다. 조회가 끝나지 않았다고
    // 알려야 사용자가 질문을 좁힐 수 있다.
    if (isEmptyEvidence(evidence) && (halted || turn >= MAX_UPSTAGE_TURNS)) {
      return Response.json({ events: [...events, { type: "assistant", content: LIMIT_MESSAGE }] });
    }
    const content = await synthesizeGroundedAnswer(apiKey, question, evidence);
    return Response.json({ events: [...events, { type: "assistant", content }] });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "AbortError";
    return jsonError(timeout ? "AI 서비스 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요." : "AI 서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.", timeout ? 504 : 502);
  }
}
