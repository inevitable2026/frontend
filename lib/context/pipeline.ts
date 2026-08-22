import { chunkElements } from "@/lib/context/chunk";
import { db } from "@/lib/context/db";
import {
  studioExecutionFromWorkflow,
  studioFailureAccounting,
  type IngestDeadlines,
} from "@/lib/context/ingest-execution";
import { getStudioIdentityFromReceipt, type StudioLiveReadinessReceipt } from "@/lib/context/live-readiness";
import { recommendSite } from "@/lib/context/site-match";
import { runStudioWorkflow } from "@/lib/context/studio";
import type {
  DocumentKind,
  ExtractedFields,
  IngestEvent,
  IngestExecution,
  IngestStage,
  SiteRecommendation,
  StageName,
} from "@/lib/context/types";
import { STAGE_ORDER } from "@/lib/context/types";
import { embedPassages } from "@/lib/context/upstage-doc";
import {
  completeIngestLease,
  failIngestLease,
  persistIngestStages,
  persistStudioCleanup,
  persistStudioFile,
  persistStudioProvenance,
  persistStudioResponse,
  persistStudioServedIdentity,
  renewIngestLease,
  openHumanSaveWindow,
  scrubStagingBytes,
  matchesStudioIngestProvenance,
  type StudioIngestProvenance,
  type IngestLease,
} from "@/lib/context/ingest-control";

const STAGE_LIMITS = { 임베딩: 15_000 } as const;
const CHUNK_INSERT_BATCH = 25;

const 시간초과문구 = "문서 분석에 주어진 시간을 넘겼습니다. 문서를 다시 올려 주세요.";

/**
 * `ingest_jobs.error` 에는 `STUDIO_LIVE_DISABLED: …` 처럼 코드가 앞에 붙어 저장된 값도
 * 있다. 저장 값은 그대로 두고, 화면에 내보낼 때만 코드 조각을 떼어 낸다.
 */
function 저장된사유(error: string): string {
  return error.replace(/^[A-Z][A-Z0-9_]*:\s*/, "").trim() || error;
}

function emptyStage(name: StageName): IngestStage {
  return { 이름: name, 상태: "대기", 시작: null, 소요ms: null };
}

export async function claimJob(jobId: string): Promise<boolean> {
  const sql = db();
  const rows = await sql<Array<{ id: string }>>`
    update ingest_jobs
       set status = 'running', started_at = now()
     where id = ${jobId} and status = 'pending'
     returning id
  `;
  return rows.length === 1;
}

export type IngestInput = {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  kind: DocumentKind;
  readiness: StudioLiveReadinessReceipt;
  deadlines: IngestDeadlines;
};

function studioCallCount(metrics: { logicalCalls: number }): number {
  return metrics.logicalCalls;
}


export async function* runIngest(
  jobId: string,
  input: IngestInput,
  initialLease: IngestLease,
  onLease?: (lease: IngestLease) => void,
): AsyncGenerator<IngestEvent, void> {
  const sql = db();
  let lease = initialLease;
  const setLease = (next: IngestLease) => { lease = next; onLease?.(next); };
  const { processingDeadline, cleanupDeadline } = input.deadlines;
  const stages = STAGE_ORDER.map(emptyStage);
  let embeddingCalls = 0;
  let studioCalls = 0;
  let execution: IngestExecution | undefined;
  const indexOf = (name: StageName) => stages.findIndex((s) => s.이름 === name);

  async function* stage<T>(
    name: StageName,
    work: () => Promise<T>,
    output?: (value: T) => unknown,
  ): AsyncGenerator<IngestEvent, T> {
    setLease(await renewIngestLease(lease));
    if (Date.now() >= processingDeadline) throw new Error(시간초과문구);
    const i = indexOf(name);
    const started = Date.now();
    stages[i] = { ...stages[i], 상태: "실행중", 시작: new Date().toISOString() };
    yield { 종류: "단계", 단계: stages[i] };

    const value = await work();
    // A stage may finish after its own upstream timeout (notably a DB query).
    // Do not let subsequent processing consume the cleanup/response windows.
    if (Date.now() >= processingDeadline) {
      throw new Error(시간초과문구);
    }
    stages[i] = {
      ...stages[i],
      상태: "완료",
      소요ms: Date.now() - started,
      산출: output ? output(value) : undefined,
    };
    setLease(await persistIngestStages(lease, stages));
    yield { 종류: "단계", 단계: stages[i] };
    return value;
  }

  try {
    yield* stage("수신", async () => input.bytes.byteLength, (size) => ({
      파일명: input.filename,
      바이트: size,
      mime: input.mime,
    }));

    const identity = getStudioIdentityFromReceipt(input.readiness, input.kind);
    if (!identity) throw new Error(`${input.kind} 문서를 분석할 설정이 없습니다. 시스템 담당자에게 문의해 주세요.`);

    const workflow = yield* stage(
      "레이아웃분석",
      async () => {
        // This fenced checkpoint is intentionally inside the stage work: it
        // must complete after stage ownership is renewed and before uploadFile.
        setLease(await persistStudioProvenance(lease, {
          manifestSha: identity.manifestSha,
          accountId: input.readiness.accountId,
          agentId: identity.agentId,
          configId: identity.configId ?? null,
          configFingerprint: identity.configFingerprint,
        }));
        return runStudioWorkflow(input.kind, input.bytes, input.filename, input.mime, {
          deadline: processingDeadline,
          identity,
          cleanupDeadline,
          lifecycle: {
            assertActive: async () => { setLease(await renewIngestLease(lease)); },
            onFileUploaded: async (fileId) => { setLease(await persistStudioFile(lease, fileId, cleanupDeadline)); },
            onResponseCreated: async (responseId) => { setLease(await persistStudioResponse(lease, responseId)); },
            onServedIdentityValidated: async (servedIdentity) => { setLease(await persistStudioServedIdentity(lease, servedIdentity)); },
            onCleanup: async (cleanup) => { setLease(await persistStudioCleanup(lease, cleanup)); },
          },
        });
      },
      (result) => ({
        agent: result.agent.name,
        agentId: result.agent.id,
        역할: result.agent.role,
        요소수: result.elements.length,
        페이지수: result.pageCount,
        model: "upstage-studio/workflow",
        requestedConfigId: result.provenance.requestedConfigId,
        boundByReceipt: result.provenance.boundByReceipt,
        servedConfigEchoVerified: result.provenance.servedConfigEchoVerified,
        responseId: result.provenance.responseId,
        servedIdentity: result.provenance.servedIdentity,
        execution: {
          ...studioExecutionFromWorkflow(result),
        } satisfies IngestExecution,
        요소: result.elements.map((e) => ({ id: e.id, page: e.page, category: e.category, coordinates: e.coordinates })),
      }),
    );
    studioCalls = studioCallCount(workflow.metrics);
    execution = studioExecutionFromWorkflow(workflow);

    yield* stage(
      "표·서명인식",
      async () => workflow.elements.filter((e) => (e.category || "").toLowerCase() === "table"),
      (tables) => ({
        agent: workflow.agent.name,
        표수: tables.length,
        미리보기: tables.slice(0, 2).map((t) => t.content.html?.slice(0, 800) ?? ""),
      }),
    );

    const extracted: ExtractedFields = yield* stage(
      "필드추출",
      async () => workflow.extracted,
      (fields) => fields,
    );

    const recommendation: SiteRecommendation | null = yield* stage(
      "프로젝트판정",
      () => recommendSite(extracted),
      (value) => value,
    );

    const chunks = yield* stage("청킹", async () => chunkElements(workflow.elements), (list) => ({
      청크수: list.length,
      중앙길이: list.length ? [...list].map((c) => c.text.length).sort((a, b) => a - b)[list.length >> 1] : 0,
      미리보기: list.slice(0, 3).map((c) => ({ seq: c.seq, page: c.page, text: c.text.slice(0, 160) })),
    }));

    const vectors = yield* stage(
      "임베딩",
      () => embedPassages(chunks.map((c) => c.text), {
        limitMs: STAGE_LIMITS.임베딩,
        deadline: processingDeadline,
        beforeCall: async () => { setLease(await renewIngestLease(lease)); },
        onCall: () => {
          embeddingCalls += 1;
        },
      }),
      (list) => ({ 벡터수: list.length, 차원: list[0]?.length ?? 0 }),
    );

    const stagingSiteId = recommendation?.siteId ?? null;
    yield* stage(
      "색인",
      async () => {
        if (chunks.length === 0) return 0;
        let inserted = 0;
        for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
          // This is an ownership boundary as well as a deadline boundary: do
          // not write another batch after another runner has reclaimed it.
          setLease(await renewIngestLease(lease));
          if (Date.now() >= processingDeadline) throw new Error(시간초과문구);
          const slice = chunks.slice(i, i + CHUNK_INSERT_BATCH);
          await sql`
            insert into document_chunks ${sql(
              slice.map((chunk, offset) => ({
                job_id: jobId,
                site_id: stagingSiteId,
                kind: input.kind,
                seq: chunk.seq,
                page: chunk.page,
                text: chunk.text,
                embedding: `[${vectors[i + offset].join(",")}]`,
              })),
            )}
            on conflict (job_id, seq) do nothing
          `;
          inserted += slice.length;
        }
        return inserted;
      },
      (count) => ({
        적재청크: count,
        스테이징: true,
        추천현장: stagingSiteId,
        안내: stagingSiteId
          ? "저장할 때 현장이 확정됩니다."
          : "문서에서 현장을 찾지 못했습니다. 저장할 때 고른 현장으로 채워집니다.",
      }),
    );

    const upstageCalls = studioCalls + embeddingCalls;
    if (Date.now() >= processingDeadline) {
      throw new Error(시간초과문구);
    }
    setLease(await completeIngestLease(lease, stages, upstageCalls));
    setLease(await openHumanSaveWindow(lease));

    yield { 종류: "완료", jobId, upstageCalls, 청크수: chunks.length, 추천: recommendation, execution };
  } catch (error) {
    if (!execution) {
      const failure = studioFailureAccounting(error);
      execution = failure.execution;
      studioCalls = failure.calls || studioCalls;
    }
    console.error(`[context] ingest failed: job=${jobId}`, error);
    const reason = error instanceof Error ? error.message : String(error);
    const running = stages.find((s) => s.상태 === "실행중");
    if (running) {
      running.상태 = "실패";
      running.실패사유 = reason;
      if (execution) running.산출 = { execution };
    }
    try {
      const cleanupFailure = error instanceof Error && "failure" in error
        ? (error as { code?: string; failure?: { cleanup?: { status: string; attempts: number } } }).failure
        : undefined;
      if (cleanupFailure?.cleanup) {
        setLease(await persistStudioCleanup(lease, cleanupFailure.cleanup, error instanceof Error ? (error as { code?: string }).code : undefined));
      }
      setLease(await failIngestLease(lease, reason, stages, studioCalls + embeddingCalls));
      setLease(await scrubStagingBytes(lease));
    } catch {
      // A stale runner is forbidden to overwrite the winner's durable state.
      return;
    }
    yield { 종류: "실패", 단계: running?.이름 ?? null, 사유: reason, execution };
  }
}

export async function* replayStages(
  jobId: string,
  expectedProvenance?: StudioIngestProvenance & { servedIdentity: string },
): AsyncGenerator<IngestEvent, void> {
  const sql = db();
  const [job] = await sql<
    Array<{
      id: string; status: string; steps: IngestStage[] | null; upstage_calls: number; error: string | null;
      studio_manifest_sha: string | null; studio_account_id: string | null; studio_agent_id: string | null;
      studio_config_id: string | null; studio_config_fingerprint: string | null; studio_served_identity: string | null;
    }>
  >`select id, status, steps, upstage_calls, error,
       studio_manifest_sha, studio_account_id, studio_agent_id, studio_config_id,
       studio_config_fingerprint, studio_served_identity
      from ingest_jobs where id = ${jobId} limit 1`;

  if (!job) {
    yield { 종류: "실패", 단계: null, 사유: "분석 작업을 찾지 못했습니다. 문서를 다시 올려 주세요." };
    return;
  }

  // A non-owner stream may only replay a live job whose durable identity is
  // complete and still matches today's validated receipt. This also protects
  // an actively-held/recovering job from being presented as compatible.
  if (expectedProvenance) {
    const plannedMatches = matchesStudioIngestProvenance({
      manifestSha: job.studio_manifest_sha ?? "",
      accountId: job.studio_account_id ?? "",
      agentId: job.studio_agent_id ?? "",
      configId: job.studio_config_id,
      configFingerprint: job.studio_config_fingerprint ?? "",
    }, expectedProvenance);
    const observedMatches = job.studio_served_identity === null || job.studio_served_identity === expectedProvenance.servedIdentity;
    if (!plannedMatches || !observedMatches || (job.status === "done" && job.studio_served_identity === null)) {
      yield { 종류: "실패", 단계: null, 사유: "이 분석 작업은 지금 승인된 분석 설정과 달라 결과를 보여 줄 수 없습니다. 문서를 다시 올려 주세요." };
      return;
    }
  }

  for (const step of job.steps ?? []) yield { 종류: "단계", 단계: step };

  if (job.status === "failed") {
    yield { 종류: "실패", 단계: null, 사유: job.error ? 저장된사유(job.error) : "문서 분석에 실패한 작업입니다. 문서를 다시 올려 주세요." };
    return;
  }
  if (job.status === "done") {
    const steps = job.steps ?? [];
    const recommendation = (steps.find((s) => s.이름 === "프로젝트판정")?.산출 ?? null) as SiteRecommendation | null;
    const indexed = steps.find((s) => s.이름 === "색인")?.산출 as { 적재청크?: number } | undefined;
    const layout = steps.find((s) => s.이름 === "레이아웃분석")?.산출 as
      | { execution?: IngestExecution }
      | undefined;
    yield {
      종류: "완료",
      jobId,
      upstageCalls: job.upstage_calls,
      청크수: indexed?.적재청크 ?? 0,
      추천: recommendation,
      execution: layout?.execution,
    };
    return;
  }
  if (job.status === "running") {
    yield {
      종류: "실패",
      단계: null,
      code: "INGEST_RECOVERY_PENDING",
      사유: "문서 분석이 중단되었습니다. 정리가 끝난 뒤 문서를 다시 올려 주세요.",
    };
  }
}
