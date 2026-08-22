import { db } from "@/lib/context/db";
import { DOCUMENT_KINDS, type DocumentKind } from "@/lib/context/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "업로드 형식을 읽지 못했습니다." }, { status: 400, headers: HEADERS });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "올린 파일이 없습니다." }, { status: 400, headers: HEADERS });
  }

  const kind = String(form.get("kind") ?? "기타") as DocumentKind;
  if (!DOCUMENT_KINDS.includes(kind)) {
    return Response.json(
      { error: `kind 는 ${DOCUMENT_KINDS.join(" · ")} 중 하나여야 합니다.` },
      { status: 400, headers: HEADERS },
    );
  }

  const mode = String(form.get("mode") ?? "live");
  if (mode !== "live" && mode !== "demo") {
    return Response.json({ error: "mode 는 live 또는 demo 여야 합니다." }, { status: 400, headers: HEADERS });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sql = db();

  const jobId = await sql.begin(async (tx) => {
    const [job] = await tx<Array<{ id: string }>>`
      insert into ingest_jobs (kind, mode, status) values (${kind}, ${mode}, 'pending') returning id
    `;
    await tx`
      insert into document_files (job_id, mime, original_filename, bytes)
      values (${job.id}, ${file.type || "application/pdf"}, ${file.name}, ${bytes})
    `;
    return job.id;
  });

  return Response.json({ jobId, mode, kind, bytes: bytes.length }, { status: 201, headers: HEADERS });
}
