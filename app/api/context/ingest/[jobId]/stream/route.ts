import { db } from "@/lib/context/db";
import { claimJob, replayStages, runIngest } from "@/lib/context/pipeline";
import type { DocumentKind, IngestEvent } from "@/lib/context/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEARTBEAT_MS = 10_000;

function frame(event: IngestEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  if (!UUID.test(jobId)) return new Response("bad job id", { status: 400 });

  const sql = db();
  const [job] = await sql<Array<{ id: string; kind: DocumentKind | null; status: string }>>`
    select id, kind, status from ingest_jobs where id = ${jobId} limit 1
  `;
  if (!job) return new Response("no such job", { status: 404 });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: IngestEvent) => controller.enqueue(encoder.encode(frame(event)));

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_MS);

      try {
        if (!(await claimJob(jobId))) {
          for await (const event of replayStages(jobId)) send(event);
          return;
        }

        const [file] = await sql<Array<{ mime: string; original_filename: string; bytes: Buffer }>>`
          select mime, original_filename, bytes from document_files where job_id = ${jobId} limit 1
        `;
        if (!file) {
          send({ 종류: "실패", 단계: "수신", 사유: "업로드된 파일을 찾지 못했습니다." });
          await sql`update ingest_jobs set status = 'failed', error = '파일 없음', finished_at = now() where id = ${jobId}`;
          return;
        }

        for await (const event of runIngest(jobId, {
          bytes: new Uint8Array(file.bytes),
          filename: file.original_filename,
          mime: file.mime,
          kind: job.kind ?? "기타",
        })) {
          send(event);
        }
      } catch (error) {
        send({ 종류: "실패", 단계: null, 사유: error instanceof Error ? error.message : String(error) });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
