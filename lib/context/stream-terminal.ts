import type { IngestEvent } from "./types.ts";

const UPLOAD_RETRY_MESSAGE = "업로드 요청에 실패했습니다. 다시 업로드해 주세요.";
const STREAM_RETRY_MESSAGE = "분석 진행 상황을 받아오지 못했습니다. 다시 업로드해 주세요.";
const MALFORMED_STREAM_MESSAGE = "분석 진행 상황을 알아볼 수 없는 형식으로 받았습니다. 다시 업로드해 주세요.";

type JsonRecord = Record<string, unknown>;
/**
 * `retryWithDemo` 는 "같은 파일로 데모를 다시 돌려 볼 수 있는가" 를 화면에 알려 주는 자리다.
 * 예전에는 화면이 `message` 의 부분 문자열을 뒤져서 이 분기를 했다. 그러면 문구를 한 글자만
 * 고쳐도 버튼이 조용히 사라진다. 판단은 여기서 내리고 화면은 이 값만 읽는다.
 */
type IngestCreation =
  | { kind: "created"; jobId: string }
  | { kind: "live_disabled"; message: string; demoAvailable: boolean; retryWithDemo: boolean }
  | { kind: "failed"; message: string; retryWithDemo: boolean };
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
  return receivedTerminalEvent ? null : "분석이 끝나기 전에 진행 상황이 끊겼습니다. 다시 업로드해 주세요.";
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
    return { kind: "failed", message: UPLOAD_RETRY_MESSAGE, retryWithDemo: false };
  }

  const body = record(await response.json().catch(() => null));
  if (!body) return { kind: "failed", message: UPLOAD_RETRY_MESSAGE, retryWithDemo: false };
  if (!response.ok) {
    if (response.status === 503 && body.code === "STUDIO_LIVE_DISABLED" && body.demoAvailable === true) {
      return {
        kind: "live_disabled",
        message: typeof body.error === "string" ? body.error : "라이브 분석은 현재 비활성화되어 있습니다.",
        demoAvailable: true,
        retryWithDemo: true,
      };
    }
    return {
      kind: "failed",
      message: typeof body.error === "string" ? body.error : UPLOAD_RETRY_MESSAGE,
      retryWithDemo: false,
    };
  }
  return typeof body.jobId === "string" && body.jobId.length > 0
    ? { kind: "created", jobId: body.jobId }
    : { kind: "failed", message: UPLOAD_RETRY_MESSAGE, retryWithDemo: false };
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
