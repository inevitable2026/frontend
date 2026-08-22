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
  getReadiness: () => StudioLiveReadiness,
): Promise<PreparedIngestRequest> {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode");
  if (mode !== "live" && mode !== "demo") {
    return { ok: false, status: 400, body: { error: "mode 쿼리는 live 또는 demo 여야 합니다." } };
  }
  const kind = params.get("kind") as IngestDocumentKind | null;
  if (!kind || !INGEST_DOCUMENT_KINDS.includes(kind)) {
    return {
      ok: false,
      status: 400,
      body: { error: `kind 쿼리는 ${INGEST_DOCUMENT_KINDS.join(" · ")} 중 하나여야 합니다.` },
    };
  }
  if (mode === "live") {
    const readiness = getReadiness();
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
    return { ok: false, status: 400, body: { error: "업로드 형식을 읽지 못했습니다." } };
  }
}
