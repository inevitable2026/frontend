import { db } from "@/lib/context/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 브라우저 안에서 그대로 띄워도 되는 종류만 inline 으로 내린다. 업로드 API 는
// 클라이언트가 보낸 mime 을 그대로 받아 두기 때문에, HTML 같은 것이 섞여 들어오면
// 같은 출처에서 스크립트가 실행될 수 있다. 나머지는 첨부로 강제해 내려받게 한다.
const INLINE_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

export async function GET(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await ctx.params;
  if (!UUID.test(documentId)) return new Response("bad document id", { status: 400 });

  const sql = db();
  const [file] = await sql<Array<{ mime: string; original_filename: string; bytes: Buffer | null }>>`
    select mime, original_filename, bytes from document_files where document_id = ${documentId} limit 1
  `;
  if (!file) return new Response("no such file", { status: 404 });
  if (!file.bytes) return new Response("file bytes were scrubbed", { status: 410 });

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
