import type { CitationSource } from "@/components/markdown-content";

import type { JsonRecord, SourceLink, ToolCall } from "./types";

/**
 * 응답 파서. 라우트는 지금 JSON 한 덩어리를 돌려주지만 스트림으로 바뀔 수 있어서
 * 이벤트 한 건 단위로 읽는다. 필드 이름이 갈리는 경우가 많아 후보를 나열해 받는다.
 */

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined || value === null) return undefined;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * 링크로 걸어도 되는 주소인지. 법령은 외부 http(s) 지만 사내 문서·위험성평가는
 * 이 앱 안의 `/api/context/documents/{id}` · `/api/risk/{id}` 라 외부 URL 이 없다.
 * 그렇다고 전부 통과시키면 `javascript:` 가 그대로 href 로 들어간다 — 여기가 보안 경계다.
 * `//evil.com` 같은 프로토콜 상대 주소는 슬래시로 시작하지만 외부로 나가므로 막는다.
 */
function isSafeSourceUrl(url: string): boolean {
  return /^https?:\/\//.test(url) || /^\/(?![/\\])/.test(url);
}

function toSourceLinks(value: unknown): SourceLink[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((source, index) => {
    if (typeof source === "string") {
      return isSafeSourceUrl(source) ? [{ label: `출처 ${index + 1}`, url: source }] : [];
    }
    if (!isRecord(source)) return [];

    const url = asText(source.url ?? source.href ?? source.link);
    if (!url || !isSafeSourceUrl(url)) return [];

    return [{ label: asText(source.title ?? source.name ?? source.label) ?? `출처 ${index + 1}`, url }];
  });
}

function normalizeStatus(value: unknown): ToolCall["status"] {
  const status = asText(value)?.toLowerCase();
  if (["error", "failed", "failure"].includes(status ?? "")) return "error";
  if (["completed", "complete", "done", "success", "finished"].includes(status ?? "")) {
    return "completed";
  }
  return "running";
}

function structuredRecord(value: unknown): JsonRecord | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 읽기에 성공해야 근거다. 검색 도구는 후보만 내놓으므로 여기 없다. */
const CITABLE_READ_TOOLS = new Set(["read_official_law", "read_company_document", "read_assessment"]);

/**
 * 인용 가능한 출처만 모은다. 성공한 **읽기** 도구만 통과시키므로 검색 후보(`citable: false`)는
 * 여기에 들어오지 않는다 (`docs/company-chatbot-plan.md` 의 인용 규칙).
 *
 * 사내 문서·위험성평가는 `authority` 에 `현장명 · 종류`, `version` 에 출처 등급을 넣는다.
 * 문서 16건이 전부 합성 데이터라서 근거 카드에 "합성" 이 보이지 않으면 심사에서
 * "이거 진짜 데이터입니까" 에 화면이 답하지 못한다 — 이 자리가 그 답이다.
 *
 * 중복 제거 키가 url 이 아닌 이유: 한 문서의 여러 청크가 같은 url(`/api/context/documents/{id}`)
 * 을 쓴다. url 로 묶으면 서로 다른 근거 본문이 하나로 접혀 각주가 엉뚱한 문단을 가리킨다.
 */
export function citationSources(toolCalls: ToolCall[]): CitationSource[] {
  const entries = toolCalls.flatMap<[string, CitationSource]>((tool) => {
    if (!CITABLE_READ_TOOLS.has(tool.name) || tool.status !== "completed") return [];

    const output = structuredRecord(tool.output);
    const result = output && isRecord(output.result) ? output.result : output;

    if (tool.name === "read_official_law") {
      const officialSource = result && isRecord(result.source) ? result.source : undefined;
      const url = asText(result?.canonicalUrl ?? officialSource?.url ?? tool.sources[0]?.url);
      const title = asText(result?.title ?? officialSource?.title ?? tool.sources[0]?.label);
      if (!url || !title || !/^https?:\/\//.test(url)) return [];

      return [[url, {
        kind: "법령",
        title,
        url,
        authority: asText(result?.authority ?? officialSource?.authority),
        version: asText(result?.version ?? officialSource?.version),
        excerpt: asText(result?.excerpt),
      }]];
    }

    const url = asText(result?.url ?? tool.sources[0]?.url);
    const title = asText(result?.title ?? tool.sources[0]?.label);
    if (!url || !title || !isSafeSourceUrl(url)) return [];

    const siteAndKind = [asText(result?.siteName), asText(result?.kind)]
      .filter((part) => Boolean(part))
      .join(" · ");
    // 위험성평가 색인에는 SAFEGRID 인스턴스 전체가 들어 있어 남이 만든 평가도 섞인다
    // (lib/agent/assessment-index.ts 의 "현장 필터가 없다"). 근거 카드가 소유자를
    // 말하지 않으면 화면이 그것을 우리 현장 기록처럼 보여 준다.
    const authority = tool.name === "read_company_document"
      ? siteAndKind || undefined
      : "위험성평가 기록 · 현장 소속 미확인";

    return [[`${url}#${asText(result?.seq) ?? title}`, {
      // 계열을 실어 보내지 않으면 각주 UI 가 이 합성 문서를 법령 원문으로 그린다
      // (`components/markdown-content.tsx` 의 CITATION_LINK_LABEL).
      kind: tool.name === "read_company_document" ? "사내문서" : "위험성평가",
      title,
      url,
      authority,
      version: asText(result?.source),
      excerpt: asText(result?.text),
    }]];
  });

  return [...new Map(entries).values()];
}

export function parseEvent(payload: unknown, index: number): { tool?: ToolCall; answer?: string; error?: string } {
  if (!isRecord(payload)) return {};
  const event = isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
  const type = asText(event.type ?? event.event ?? event.kind)?.toLowerCase() ?? "";
  const toolPayload = isRecord(event.tool) ? { ...event, ...event.tool } : event;
  const isTool = type.includes("tool") || toolPayload.tool_name !== undefined || toolPayload.toolName !== undefined;

  if (isTool) {
    const name = asText(toolPayload.name ?? toolPayload.tool_name ?? toolPayload.toolName) ?? "도구 실행";
    return {
      tool: {
        id: asText(toolPayload.id ?? toolPayload.call_id ?? toolPayload.tool_call_id) ?? `${name}-${index}`,
        name,
        status: normalizeStatus(toolPayload.status),
        input: toolPayload.input ?? toolPayload.arguments ?? toolPayload.args,
        output: toolPayload.output ?? toolPayload.result ?? toolPayload.content,
        sources: toSourceLinks(toolPayload.sources ?? toolPayload.source_links ?? toolPayload.links),
      },
    };
  }

  if (type.includes("error") || event.error !== undefined) {
    return { error: asText(event.error ?? event.message) ?? "응답을 가져오지 못했습니다." };
  }

  const answer = asText(event.answer ?? event.message ?? event.text ?? event.content ?? event.delta);
  return answer ? { answer } : {};
}
