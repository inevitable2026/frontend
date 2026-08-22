import { INGEST_DOCUMENT_KINDS, type IngestDocumentKind } from "./types.ts";
import type { StudioLiveReadiness } from "./live-readiness.ts";

export type IngestIntent = { mode: "live" | "demo"; kind: IngestDocumentKind };

export type PreparedIngestRequest =
  | { ok: true; intent: IngestIntent; form: FormData }
  | { ok: false; status: 400 | 503; body: { code?: string; error: string; demoAvailable?: boolean } };

type FormRequest = Pick<Request, "url" | "formData">;

/**
 * Resolves the byte-free query intent and live readiness before touching the
 * multipart body. Keeping this ordering in one testable function prevents a
 * future `formData()` refactor from consuming a disabled live upload.
 */
export async function prepareIngestRequest(
  request: FormRequest,
  // 회수기가 지금 도는지는 저장소를 읽어야 알 수 있어 비동기다. 동기 구현도 그대로 받는다 —
  // 시험은 가짜를 끼워 넣고 저장소 없이 이 순서를 밟는다.
  getReadiness: () => StudioLiveReadiness | Promise<StudioLiveReadiness>,
): Promise<PreparedIngestRequest> {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode");
  if (mode !== "live" && mode !== "demo") {
    return {
      ok: false,
      status: 400,
      body: { error: "문서 분석 방식을 알 수 없습니다. 화면을 새로 고친 뒤 다시 올려 주세요." },
    };
  }
  const kind = params.get("kind") as IngestDocumentKind | null;
  if (!kind || !INGEST_DOCUMENT_KINDS.includes(kind)) {
    return {
      ok: false,
      status: 400,
      body: { error: "문서 종류를 알 수 없습니다. 문서 종류를 다시 고른 뒤 올려 주세요." },
    };
  }
  if (mode === "live") {
    const readiness = await getReadiness();
    if (!readiness.enabled) {
      return {
        ok: false,
        status: 503,
        body: { code: readiness.code, error: readiness.reason, demoAvailable: true },
      };
    }
  }
  try {
    return { ok: true, intent: { mode, kind }, form: await request.formData() };
  } catch {
    return { ok: false, status: 400, body: { error: "올린 파일을 읽지 못했습니다. 문서를 다시 올려 주세요." } };
  }
}
