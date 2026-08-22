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

function toSourceLinks(value: unknown): SourceLink[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((source, index) => {
    if (typeof source === "string") {
      return /^https?:\/\//.test(source)
        ? [{ label: `출처 ${index + 1}`, url: source }]
        : [];
    }
    if (!isRecord(source)) return [];

    const url = asText(source.url ?? source.href ?? source.link);
    if (!url || !/^https?:\/\//.test(url)) return [];

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

/**
 * 인용 가능한 출처만 모은다. 성공한 `read_official_law` 만 통과시키므로 검색 후보는
 * 여기에 들어오지 않는다 (`docs/company-chatbot-plan.md` 의 인용 규칙).
 */
export function citationSources(toolCalls: ToolCall[]): CitationSource[] {
  const sources = toolCalls.flatMap((tool) => {
    if (tool.name !== "read_official_law" || tool.status !== "completed") return [];

    const output = structuredRecord(tool.output);
    const result = output && isRecord(output.result) ? output.result : output;
    const officialSource = result && isRecord(result.source) ? result.source : undefined;
    const url = asText(result?.canonicalUrl ?? officialSource?.url ?? tool.sources[0]?.url);
    const title = asText(result?.title ?? officialSource?.title ?? tool.sources[0]?.label);
    if (!url || !title || !/^https?:\/\//.test(url)) return [];

    return [{
      title,
      url,
      authority: asText(result?.authority ?? officialSource?.authority),
      version: asText(result?.version ?? officialSource?.version),
      excerpt: asText(result?.excerpt),
    }];
  });

  return [...new Map(sources.map((source) => [source.url, source])).values()];
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
