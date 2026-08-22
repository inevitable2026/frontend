import { db } from "@/lib/context/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 이 응답은 문서 보기 화면의 미리보기 칸에 그대로 뜬다. 한글이 깨지지 않게 charset 을 붙인다.
const TEXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" };

// 브라우저 안에서 그대로 띄워도 되는 종류만 inline 으로 내린다. 업로드 API 는
// 클라이언트가 보낸 mime 을 그대로 받아 두기 때문에, HTML 같은 것이 섞여 들어오면
// 같은 출처에서 스크립트가 실행될 수 있다. 나머지는 첨부로 강제해 내려받게 한다.
const INLINE_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

export async function GET(req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;
  const siteId = new URL(req.url).searchParams.get("siteId");
  if (!UUID.test(documentId)) return new Response("문서 주소가 올바르지 않습니다. 문서함에서 다시 열어 주세요.", { status: 400, headers: TEXT_HEADERS });
  if (!siteId || !UUID.test(siteId)) return new Response("현장 주소가 올바르지 않습니다. 문서함에서 다시 열어 주세요.", { status: 400, headers: TEXT_HEADERS });

  const sql = db();
  const [file] = await sql<Array<{ mime: string; original_filename: string; bytes: Buffer | null }>>`
    select f.mime, f.original_filename, f.bytes
      from document_files f
      join documents d on d.id = f.document_id
     where f.document_id = ${documentId} and d.site_id = ${siteId}
     limit 1
  `;
  if (!file) return new Response("이 문서에는 원본 파일이 없습니다. 읽어낸 값과 검색 조각만 볼 수 있습니다.", { status: 404, headers: TEXT_HEADERS });
  if (!file.bytes) return new Response("원본 파일이 더 이상 보관되어 있지 않습니다. 읽어낸 값과 검색 조각만 볼 수 있습니다.", { status: 410, headers: TEXT_HEADERS });

  const mime = file.mime || "application/pdf";
  const disposition = INLINE_MIME.has(mime) ? "inline" : "attachment";
  const filename = file.original_filename || "document";
  const body = new Uint8Array(file.bytes);

  return new Response(body, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
