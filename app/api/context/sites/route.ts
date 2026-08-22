import { db } from "@/lib/context/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

export async function GET() {
  const sql = db();
  const rows = await sql<Array<{ id: string; code: string; name: string; document_count: number }>>`
    select s.id, s.code, s.name,
           (select count(*)::int from documents d where d.site_id = s.id) as document_count
      from sites s
     order by document_count desc, s.name
  `;
  return Response.json({ total: rows.length, sites: rows }, { headers: HEADERS });
}
