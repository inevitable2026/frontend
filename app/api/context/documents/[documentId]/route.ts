import { db } from "@/lib/context/db";
import type { DocumentKind, ExtractedFields } from "@/lib/context/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;
  if (!UUID.test(documentId)) {
    return Response.json({ error: "documentId 가 올바르지 않습니다." }, { status: 400, headers: HEADERS });
  }

  const sql = db();
  const [doc] = await sql<
    Array<{
      id: string;
      site_id: string;
      site_name: string;
      site_code: string;
      kind: DocumentKind;
      title: string;
      source_filename: string;
      mime: string | null;
      page_count: number | null;
      extracted: ExtractedFields | null;
      created_at: Date;
    }>
  >`
    select d.id, d.site_id, s.name as site_name, s.code as site_code, d.kind, d.title,
           d.source_filename, d.mime, d.page_count, d.extracted, d.created_at
      from documents d
      join sites s on s.id = d.site_id
     where d.id = ${documentId}
     limit 1
  `;
  if (!doc) return Response.json({ error: "그런 문서가 없습니다." }, { status: 404, headers: HEADERS });

  // 원본 파일은 적재 시점에 job 으로 먼저 들어오고 저장할 때 document_id 가 채워진다.
  // 그 연결이 끊긴 옛 문서도 있으므로, 없으면 null 로 두고 화면에서 안내한다.
  const [file] = await sql<Array<{ id: string; mime: string; original_filename: string; byte_size: number }>>`
    select id, mime, original_filename, octet_length(bytes) as byte_size
      from document_files where document_id = ${documentId} limit 1
  `;

  const chunks = await sql<Array<{ id: string; seq: number; page: number | null; text: string }>>`
    select id, seq, page, text from document_chunks
     where document_id = ${documentId}
     order by seq
  `;

  return Response.json(
    {
      document: doc,
      file: file ? { mime: file.mime, filename: file.original_filename, byteSize: file.byte_size } : null,
      chunks,
    },
    { headers: HEADERS },
  );
}
