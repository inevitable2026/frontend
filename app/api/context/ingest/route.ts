import { db } from "@/lib/context/db";
import { prepareIngestRequest } from "@/lib/context/ingest-request";
import { getStudioLiveReadiness } from "@/lib/context/live-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

export async function POST(req: Request) {
  const prepared = await prepareIngestRequest(req, getStudioLiveReadiness);
  if (!prepared.ok) {
    return Response.json(prepared.body, { status: prepared.status, headers: HEADERS });
  }
  const { form } = prepared;
  const { mode, kind } = prepared.intent;

  let bytes: Buffer;
  let filename: string;
  let mime: string;
  let reportedByteLength: number;
  if (mode === "live") {
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "올린 파일이 없습니다." }, { status: 400, headers: HEADERS });
    }
    bytes = Buffer.from(await file.arrayBuffer());
    filename = file.name;
    mime = file.type || "application/pdf";
    reportedByteLength = bytes.length;
  } else {
    const byteLength = Number(form.get("byteLength"));
    filename = String(form.get("filename") ?? "demo.pdf");
    mime = String(form.get("mime") ?? "application/pdf");
    if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > 500_000_000) {
      return Response.json({ error: "데모 파일 크기가 올바르지 않습니다." }, { status: 400, headers: HEADERS });
    }
    bytes = Buffer.alloc(0);
    reportedByteLength = byteLength;
  }
  const sql = db();

  const jobId = await sql.begin(async (tx) => {
    const [job] = await tx<Array<{ id: string }>>`
      insert into ingest_jobs (kind, mode, status, steps, cleanup_deadline)
      values (
        ${kind},
        ${mode},
        'pending',
        ${tx.json((mode === "demo"
          ? [{ 이름: "수신", 상태: "대기", 시작: null, 소요ms: null, 산출: { demoByteLength: reportedByteLength } }]
          : []) as never)},
        ${mode === "live" ? new Date(Date.now() + 60 * 60 * 1000) : null}
      )
      returning id
    `;
    await tx`
      insert into document_files (job_id, mime, original_filename, bytes)
      values (${job.id}, ${mime}, ${filename}, ${bytes})
    `;
    return job.id;
  });

  return Response.json({ jobId, mode, kind, bytes: reportedByteLength }, { status: 201, headers: HEADERS });
}
