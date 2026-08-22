import type { IngestEvent } from "./types.ts";

const UPLOAD_RETRY_MESSAGE = "업로드 요청에 실패했습니다. 다시 업로드해 주세요.";
const STREAM_RETRY_MESSAGE = "진행 스트림을 열거나 읽지 못했습니다. 다시 업로드해 주세요.";
const MALFORMED_STREAM_MESSAGE = "진행 스트림 형식이 올바르지 않습니다. 다시 업로드해 주세요.";

type JsonRecord = Record<string, unknown>;
type IngestCreation =
  | { kind: "created"; jobId: string }
  | { kind: "live_disabled"; message: string; demoAvailable: boolean }
  | { kind: "failed"; message: string };
type StreamOutcome = { kind: "terminal" } | { kind: "failed"; message: string };

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function ingestEvent(value: unknown): IngestEvent | null {
  const event = record(value);
  if (!event || (event.종류 !== "단계" && event.종류 !== "완료" && event.종류 !== "실패")) return null;
  return event as IngestEvent;
}

export function isTerminalIngestEvent(event: IngestEvent): boolean {
  return event.종류 === "완료" || event.종류 === "실패";
}

export function unterminatedIngestStreamMessage(receivedTerminalEvent: boolean): string | null {
  return receivedTerminalEvent ? null : "진행 스트림이 완료 신호 없이 종료되었습니다. 다시 업로드해 주세요.";
}

export async function createIngestJob(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<IngestCreation> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    return { kind: "failed", message: UPLOAD_RETRY_MESSAGE };
  }

  const body = record(await response.json().catch(() => null));
  if (!body) return { kind: "failed", message: UPLOAD_RETRY_MESSAGE };
  if (!response.ok) {
    if (response.status === 503 && body.code === "STUDIO_LIVE_DISABLED" && body.demoAvailable === true) {
      return {
        kind: "live_disabled",
        message: typeof body.error === "string" ? body.error : "라이브 분석은 현재 비활성화되어 있습니다.",
        demoAvailable: true,
      };
    }
    return { kind: "failed", message: typeof body.error === "string" ? body.error : UPLOAD_RETRY_MESSAGE };
  }
  return typeof body.jobId === "string" && body.jobId.length > 0
    ? { kind: "created", jobId: body.jobId }
    : { kind: "failed", message: UPLOAD_RETRY_MESSAGE };
}

export async function consumeIngestStream(
  fetchImpl: typeof fetch,
  url: string,
  onEvent: (event: IngestEvent) => void,
): Promise<StreamOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch {
    return { kind: "failed", message: STREAM_RETRY_MESSAGE };
  }
  if (!response.ok || !response.body) return { kind: "failed", message: STREAM_RETRY_MESSAGE };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedTerminalEvent = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!block.startsWith("data: ")) continue;
        let value: unknown;
        try {
          value = JSON.parse(block.slice(6));
        } catch {
          return { kind: "failed", message: MALFORMED_STREAM_MESSAGE };
        }
        const event = ingestEvent(value);
        if (!event) return { kind: "failed", message: MALFORMED_STREAM_MESSAGE };
        receivedTerminalEvent ||= isTerminalIngestEvent(event);
        onEvent(event);
      }
    }
  } catch {
    return { kind: "failed", message: STREAM_RETRY_MESSAGE };
  }

  const message = unterminatedIngestStreamMessage(receivedTerminalEvent);
  return message ? { kind: "failed", message } : { kind: "terminal" };
}
