import { db } from "@/lib/context/db";
import { canSaveStudioJob } from "@/lib/context/job-save-policy";
import { DOCUMENT_KINDS, type DocumentKind, type ExtractedFields, type IngestStage, type SiteRecommendation } from "@/lib/context/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

class SaveConflictError extends Error {}

// ingest_jobs.status 값은 서버·저장 데이터와 맞물려 있어 그대로 두고, 화면 문구만 여기서 고른다.
const 저장못하는이유: Record<string, string | undefined> = {
  pending: "문서 분석이 아직 시작되지 않았습니다. 분석이 끝난 뒤 저장해 주세요.",
  running: "문서 분석이 아직 진행 중입니다. 분석이 끝난 뒤 저장해 주세요.",
  failed: "문서 분석에 실패해 저장할 수 없습니다. 문서를 다시 올려 주세요.",
};

export async function POST(req: Request) {
  let body: { jobId?: string; siteId?: string; kind?: DocumentKind; title?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "저장 요청을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요." }, { status: 400, headers: HEADERS });
  }

  const { jobId, siteId } = body;
  if (!jobId || !siteId) {
    return Response.json({ error: "저장할 분석 작업과 현장이 지정되지 않았습니다. 현장을 고른 뒤 다시 저장해 주세요." }, { status: 400, headers: HEADERS });
  }

  const sql = db();
  const [job] = await sql<
    Array<{
      id: string;
      kind: DocumentKind | null;
      status: string;
      mode: string;
      document_id: string | null;
      cleanup_deadline: Date | null;
      steps: IngestStage[] | null;
    }>
  >`select id, kind, status, mode, document_id, cleanup_deadline, steps from ingest_jobs where id = ${jobId} limit 1`;

  if (!job) return Response.json({ error: "분석 작업을 찾지 못했습니다. 문서를 다시 올려 주세요." }, { status: 404, headers: HEADERS });
  if (job.mode === "demo") {
    return Response.json(
      { error: "데모 모드 결과는 문서함에 저장하지 않습니다. 고정된 응답이라 저장하면 문서함에 사실이 아닌 항목이 남습니다." },
      { status: 409, headers: HEADERS },
    );
  }
  if (job.status !== "done") {
    console.error(`[context] save rejected: job=${jobId} status=${job.status}`);
    return Response.json(
      { error: 저장못하는이유[job.status] ?? "문서 분석이 끝나지 않아 저장할 수 없습니다. 분석이 끝난 뒤 다시 저장해 주세요." },
      { status: 409, headers: HEADERS },
    );
  }
  if (job.document_id) {
    return Response.json({ error: "이미 문서함에 저장한 문서입니다. 문서함에서 확인해 주세요.", documentId: job.document_id }, { status: 409, headers: HEADERS });
  }

  const [site] = await sql<Array<{ id: string; name: string }>>`select id, name from sites where id = ${siteId} limit 1`;
  if (!site) return Response.json({ error: "현장을 찾지 못했습니다. 현장 목록에서 다시 선택해 주세요." }, { status: 404, headers: HEADERS });

  const [file] = await sql<Array<{ id: string; mime: string; original_filename: string }>>`
    select id, mime, original_filename from document_files where job_id = ${jobId} limit 1
  `;

  const steps = job.steps ?? [];
  const stageOutput = (name: string) => steps.find((s) => s.이름 === name)?.산출;
  const savePolicy = canSaveStudioJob({
    mode: job.mode,
    status: job.status,
    steps: job.steps,
    cleanupDeadline: job.cleanup_deadline,
  });
  if (!savePolicy.allowed) {
    return Response.json({ error: savePolicy.reason }, { status: 409, headers: HEADERS });
  }
  const layout = stageOutput("레이아웃분석") as
    | { 페이지수?: number; execution?: { mode?: string; cleanup?: string } }
    | undefined;
  const extracted = (stageOutput("필드추출") ?? null) as ExtractedFields | null;
  const parsed = layout;
  const recommendation = (stageOutput("프로젝트판정") ?? null) as SiteRecommendation | null;

  const kind = body.kind && DOCUMENT_KINDS.includes(body.kind) ? body.kind : job.kind ?? "기타";
  const title =
    body.title?.trim() ||
    [extracted?.현장명, kind].filter(Boolean).join(" ") ||
    file?.original_filename ||
    "제목 없음";

  let result: { documentId: string; chunkCount: number };
  try {
    result = await sql.begin(async (tx) => {
      const [doc] = await tx<Array<{ id: string }>>`
        insert into documents (site_id, kind, title, source_filename, mime, page_count, extracted)
        values (${siteId}, ${kind}, ${title}, ${file?.original_filename ?? "unknown"},
                ${file?.mime ?? "application/pdf"}, ${parsed?.페이지수 ?? null},
                ${extracted ? tx.json(extracted as never) : null})
        returning id
      `;
      // The initial read above is intentionally optimistic for a quick response.
      // This conditional write is the transaction's ownership claim: a second
      // concurrent save rolls back its new document before it can move chunks.
      const [claimed] = await tx<Array<{ id: string }>>`
        update ingest_jobs
           set document_id = ${doc.id}, cleanup_deadline = null
         where id = ${jobId} and document_id is null and status = 'done'
           and cleanup_deadline > now()
        returning id
      `;
      if (!claimed) throw new SaveConflictError("저장하는 사이에 같은 문서가 먼저 저장되었습니다. 문서함에서 확인해 주세요.");
      const confirmed = await tx<Array<{ id: string }>>`
        update document_chunks set document_id = ${doc.id}, site_id = ${siteId}, kind = ${kind}
         where job_id = ${jobId} and document_id is null
        returning id
      `;
      if (file) await tx`update document_files set document_id = ${doc.id} where id = ${file.id}`;
      return { documentId: doc.id, chunkCount: confirmed.length };
    });
  } catch (error) {
    if (error instanceof SaveConflictError) {
      return Response.json({ error: error.message }, { status: 409, headers: HEADERS });
    }
    throw error;
  }

  return Response.json(
    {
      documentId: result.documentId,
      siteId,
      siteName: site.name,
      kind,
      title,
      chunkCount: result.chunkCount,
      differsFromRecommendation: siteId !== recommendation?.siteId,
    },
    { status: 201, headers: HEADERS },
  );
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const siteId = params.get("siteId");
  const kind = params.get("kind") as DocumentKind | null;
  const q = params.get("q")?.trim();

  const sql = db();
  const rows = await sql<
    Array<{
      id: string;
      site_id: string;
      site_name: string;
      site_code: string;
      kind: DocumentKind;
      title: string;
      source_filename: string;
      page_count: number | null;
      extracted: ExtractedFields | null;
      created_at: Date;
      chunk_count: number;
    }>
  >`
    select d.id, d.site_id, s.name as site_name, s.code as site_code, d.kind, d.title,
           d.source_filename, d.page_count, d.extracted, d.created_at,
           (select count(*)::int from document_chunks c where c.document_id = d.id) as chunk_count
      from documents d
      join sites s on s.id = d.site_id
     where true
       ${siteId ? sql`and d.site_id = ${siteId}` : sql``}
       ${kind && DOCUMENT_KINDS.includes(kind) ? sql`and d.kind = ${kind}` : sql``}
       ${q ? sql`and d.title ilike ${"%" + q + "%"}` : sql``}
     order by d.created_at desc
     limit 200
  `;

  return Response.json({ total: rows.length, documents: rows }, { headers: HEADERS });
}
