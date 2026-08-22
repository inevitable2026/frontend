import { db } from "@/lib/context/db";
import { replayDemo } from "@/lib/context/demo";
import { deriveIngestDeadlines } from "@/lib/context/ingest-execution";
import { getStudioIdentityFromReceipt, getStudioLiveReadiness } from "@/lib/context/live-readiness";
import { claimJob, replayStages, runIngest } from "@/lib/context/pipeline";
import {
  acquireIngestLease,
  assertIngestLease,
  failIngestLease,
  heartbeatIngestLease,
  scrubStagingBytes,
  type IngestLease,
} from "@/lib/context/ingest-control";
import type { DocumentKind, IngestEvent } from "@/lib/context/types";
import { STAGE_ORDER } from "@/lib/context/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEARTBEAT_MS = 10_000;

function frame(event: IngestEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const enteredAt = Date.now();
  const { jobId } = await ctx.params;
  if (!UUID.test(jobId)) return new Response("bad job id", { status: 400 });

  const sql = db();
  const [job] = await sql<Array<{
    id: string;
    kind: DocumentKind | null;
    status: string;
    mode: string;
    steps: Array<{ 이름?: string; 산출?: { demoByteLength?: number } }> | null;
  }>>`
    select id, kind, status, mode, steps from ingest_jobs where id = ${jobId} limit 1
  `;
  if (!job) return new Response("no such job", { status: 404 });
  const requestedDemoByteLength = Number(
    job.steps?.find((step) => step.이름 === "수신")?.산출?.demoByteLength ??
    new URL(req.url).searchParams.get("byteLength") ??
    0,
  );
  const demoByteLength = Number.isInteger(requestedDemoByteLength) && requestedDemoByteLength >= 0 && requestedDemoByteLength <= 500_000_000
    ? requestedDemoByteLength
    : 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let liveLease: IngestLease | null = null;
      const send = async (event: IngestEvent) => {
        if (liveLease) await assertIngestLease(liveLease);
        controller.enqueue(encoder.encode(frame(event)));
      };

      const heartbeat = setInterval(() => {
        void (async () => {
          try {
            if (liveLease && !(await heartbeatIngestLease(liveLease))) {
              clearInterval(heartbeat);
              return;
            }
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch { clearInterval(heartbeat); }
        })();
      }, HEARTBEAT_MS);

      let claimed = false;
      try {
        const readiness = job.mode === "live" ? getStudioLiveReadiness() : null;
        if (readiness && !readiness.enabled) {
          const reason = `${readiness.code}: ${readiness.reason}`;
          if (job.status === "pending") {
            const failedStages = STAGE_ORDER.map((name) => ({
              이름: name,
              상태: name === "수신" ? "실패" : "건너뜀",
              시작: null,
              소요ms: null,
              ...(name === "수신" ? { 실패사유: readiness.reason } : {}),
            }));
            await sql.begin(async (tx) => {
              await tx`
                update ingest_jobs
                   set status = 'failed', error = ${reason}, finished_at = now(), steps = ${tx.json(failedStages as never)}
                 where id = ${jobId} and status = 'pending'
              `;
              await tx`delete from document_chunks where job_id = ${jobId} and document_id is null`;
              await tx`delete from document_files where job_id = ${jobId} and document_id is null`;
            });
          }
          await send({ 종류: "실패", 단계: null, code: readiness.code, 사유: readiness.reason });
          return;
        }

        const deadlines = readiness ? deriveIngestDeadlines(readiness.receipt, enteredAt) : null;

        const owner = crypto.randomUUID();
        const replayProvenance = readiness
          ? (() => {
              const identity = getStudioIdentityFromReceipt(readiness.receipt, job.kind ?? "기타");
              return identity ? {
                manifestSha: identity.manifestSha,
                accountId: readiness.receipt.accountId,
                agentId: identity.agentId,
                configId: identity.configId ?? null,
                configFingerprint: identity.configFingerprint,
                servedIdentity: identity.servedIdentity,
              } : undefined;
            })()
          : undefined;
        const lease = job.mode === "live" && job.status === "pending"
          ? await acquireIngestLease(jobId, owner)
          : null;
        if (job.mode === "live" ? !lease : !(await claimJob(jobId))) {
          for await (const event of replayStages(jobId, replayProvenance)) await send(event);
          return;
        }
        claimed = true;
        liveLease = lease;

        const [file] = await sql<Array<{ mime: string; original_filename: string; bytes: Buffer | null }>>`
          select mime, original_filename, bytes from document_files where job_id = ${jobId} limit 1
        `;
        if (!file || !file.bytes) {
          await send({ 종류: "실패", 단계: "수신", 사유: "올린 파일을 찾지 못했습니다. 문서를 다시 올려 주세요." });
          if (liveLease) {
            liveLease = await failIngestLease(liveLease, "올린 파일을 찾지 못했습니다. 문서를 다시 올려 주세요.", [], 0);
            liveLease = await scrubStagingBytes(liveLease);
          } else {
            await sql`update ingest_jobs set status = 'failed', error = '올린 파일을 찾지 못했습니다. 문서를 다시 올려 주세요.', finished_at = now() where id = ${jobId} and status = 'running'`;
          }
          return;
        }

        if (job.mode === "demo") {
          let failure: Extract<IngestEvent, { 종류: "실패" }> | undefined;
          for await (const event of replayDemo(jobId, job.kind ?? "기타", file.original_filename, demoByteLength)) {
            await send(event);
            if (event.종류 === "실패") failure = event;
          }
          if (failure) {
            await sql`
              update ingest_jobs
                 set status = 'failed', error = ${failure.사유}, finished_at = now()
               where id = ${jobId} and status = 'running'
            `;
            return;
          }
          await sql`
            update ingest_jobs
               set status = 'done', finished_at = now(), upstage_calls = 0
             where id = ${jobId}
          `;
          return;
        }

        for await (const event of runIngest(jobId, {
          bytes: new Uint8Array(file.bytes),
          filename: file.original_filename,
          mime: file.mime,
          kind: job.kind ?? "기타",
          readiness: readiness!.receipt,
          deadlines: deadlines!,
        }, lease!, (nextLease) => { liveLease = nextLease; })) {
          await send(event);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (claimed && !liveLease) {
          try {
            await sql`
              update ingest_jobs
                 set status = 'failed', error = ${reason}, finished_at = now()
               where id = ${jobId} and status = 'running'
            `;
          } catch {
            // The original exception is still sent to the client. A later
            // sweeper can reconcile a job only when the database itself is
            // unavailable at this point.
          }
        }
        try { await send({ 종류: "실패", 단계: null, 사유: reason }); } catch { /* stale owner must stay silent */ }
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
