import { db, toVectorLiteral } from "@/lib/context/db";
import { DOCUMENT_KINDS, type Citation, type DocumentKind } from "@/lib/context/types";
import { embedQuery } from "@/lib/context/upstage-doc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

export async function POST(req: Request) {
  let body: { q?: string; siteId?: string; kind?: DocumentKind; k?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "검색 요청을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요." }, { status: 400, headers: HEADERS });
  }

  const q = body.q?.trim();
  if (!q) return Response.json({ error: "검색어를 입력해 주세요." }, { status: 400, headers: HEADERS });

  const k = Math.min(Math.max(body.k ?? 8, 1), 30);
  const siteId = body.siteId ?? null;
  const kind = body.kind && DOCUMENT_KINDS.includes(body.kind) ? body.kind : null;

  const embedStarted = Date.now();
  const vector = toVectorLiteral(await embedQuery(q));
  const embedMs = Date.now() - embedStarted;

  const sql = db();
  const searchStarted = Date.now();
  const rows = await sql<
    Array<{
      document_id: string;
      title: string;
      kind: DocumentKind;
      site_id: string;
      site_name: string;
      page: number;
      seq: number;
      text: string;
      distance: number;
    }>
  >`
    select c.document_id, d.title, c.kind, c.site_id, s.name as site_name, c.page, c.seq, c.text,
           (c.embedding <=> ${vector}::halfvec)::float8 as distance
      from document_chunks c
      join documents d on d.id = c.document_id
      join sites s on s.id = c.site_id
     where c.document_id is not null
       ${siteId ? sql`and c.site_id = ${siteId}` : sql``}
       ${kind ? sql`and c.kind = ${kind}` : sql``}
     order by c.embedding <=> ${vector}::halfvec
     limit ${k}
  `;
  const searchMs = Date.now() - searchStarted;

  const citations: Citation[] = rows.map((r) => ({
    documentId: r.document_id,
    title: r.title,
    page: r.page,
    excerpt: r.text,
    score: Number((1 - r.distance).toFixed(4)),
    source: "합성",
  }));

  return Response.json(
    {
      q,
      filters: { siteId, kind },
      found: rows.length,
      latencyMs: { embed: embedMs, search: searchMs },
      results: rows.map((r, i) => ({
        documentId: r.document_id,
        title: r.title,
        kind: r.kind,
        siteId: r.site_id,
        siteName: r.site_name,
        page: r.page,
        seq: r.seq,
        text: r.text,
        score: citations[i].score,
      })),
      citations,
    },
    { headers: HEADERS },
  );
}
