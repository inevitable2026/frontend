import { chunkElements } from "@/lib/context/chunk";
import { db } from "@/lib/context/db";
import { recommendSite } from "@/lib/context/site-match";
import type {
  DocumentKind,
  ExtractedFields,
  IngestEvent,
  IngestStage,
  SiteRecommendation,
  StageName,
} from "@/lib/context/types";
import { STAGE_ORDER } from "@/lib/context/types";
import { embedPassages, extractFields, parseDocument, upstageCallCount } from "@/lib/context/upstage-doc";

export const TOTAL_BUDGET_MS = 55_000;

const STAGE_LIMITS = { 레이아웃분석: 25_000, 필드추출: 20_000, 임베딩: 15_000 } as const;
const CHUNK_INSERT_BATCH = 25;

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

async function saveStages(jobId: string, stages: IngestStage[]): Promise<void> {
  const sql = db();
  await sql`update ingest_jobs set steps = ${sql.json(stages as never)} where id = ${jobId}`;
}

export type IngestInput = {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  kind: DocumentKind;
};

export async function* runIngest(jobId: string, input: IngestInput): AsyncGenerator<IngestEvent, void> {
  const sql = db();
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const stages = STAGE_ORDER.map(emptyStage);
  const callsAtStart = upstageCallCount();
  const indexOf = (name: StageName) => stages.findIndex((s) => s.이름 === name);

  async function* stage<T>(
    name: StageName,
    work: () => Promise<T>,
    output?: (value: T) => unknown,
  ): AsyncGenerator<IngestEvent, T> {
    const i = indexOf(name);
    const started = Date.now();
    stages[i] = { ...stages[i], 상태: "실행중", 시작: new Date().toISOString() };
    yield { 종류: "단계", 단계: stages[i] };

    const value = await work();
    stages[i] = {
      ...stages[i],
      상태: "완료",
      소요ms: Date.now() - started,
      산출: output ? output(value) : undefined,
    };
    await saveStages(jobId, stages);
    yield { 종류: "단계", 단계: stages[i] };
    return value;
  }

  try {
    yield* stage("수신", async () => input.bytes.byteLength, (size) => ({
      파일명: input.filename,
      바이트: size,
      mime: input.mime,
    }));

    const parsed = yield* stage(
      "레이아웃분석",
      () => parseDocument(input.bytes, input.filename, input.mime, { limitMs: STAGE_LIMITS.레이아웃분석, deadline }),
      (result) => ({
        요소수: result.elements.length,
        페이지수: result.pageCount,
        model: result.model,
        요소: result.elements.map((e) => ({ id: e.id, page: e.page, category: e.category, coordinates: e.coordinates })),
      }),
    );

    yield* stage(
      "표·서명인식",
      async () => parsed.elements.filter((e) => (e.category || "").toLowerCase() === "table"),
      (tables) => ({
        표수: tables.length,
        미리보기: tables.slice(0, 2).map((t) => t.content.html?.slice(0, 800) ?? ""),
      }),
    );

    const extracted: ExtractedFields = yield* stage(
      "필드추출",
      () => extractFields(input.bytes, input.mime, input.kind, { limitMs: STAGE_LIMITS.필드추출, deadline }),
      (fields) => fields,
    );

    const recommendation: SiteRecommendation | null = yield* stage(
      "프로젝트판정",
      () => recommendSite(extracted),
      (value) => value,
    );

    const chunks = yield* stage("청킹", async () => chunkElements(parsed.elements), (list) => ({
      청크수: list.length,
      중앙길이: list.length ? [...list].map((c) => c.text.length).sort((a, b) => a - b)[list.length >> 1] : 0,
      미리보기: list.slice(0, 3).map((c) => ({ seq: c.seq, page: c.page, text: c.text.slice(0, 160) })),
    }));

    const vectors = yield* stage(
      "임베딩",
      () => embedPassages(chunks.map((c) => c.text), { limitMs: STAGE_LIMITS.임베딩, deadline }),
      (list) => ({ 벡터수: list.length, 차원: list[0]?.length ?? 0 }),
    );

    const stagingSiteId = recommendation?.siteId ?? null;
    yield* stage(
      "색인",
      async () => {
        if (chunks.length === 0) return 0;
        let inserted = 0;
        for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
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
          ? "저장 시점에 documentId 가 붙고 현장이 확정됩니다."
          : "추천 현장이 없습니다. 저장할 때 고른 현장으로 채워집니다.",
      }),
    );

    const upstageCalls = upstageCallCount() - callsAtStart;
    await sql`
      update ingest_jobs
         set status = 'done', finished_at = now(), upstage_calls = ${upstageCalls}, steps = ${sql.json(stages as never)}
       where id = ${jobId}
    `;

    yield { 종류: "완료", jobId, upstageCalls, 청크수: chunks.length, 추천: recommendation };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const running = stages.find((s) => s.상태 === "실행중");
    if (running) {
      running.상태 = "실패";
      running.실패사유 = reason;
    }
    await sql`
      update ingest_jobs
         set status = 'failed', error = ${reason}, finished_at = now(),
             upstage_calls = ${upstageCallCount() - callsAtStart}, steps = ${sql.json(stages as never)}
       where id = ${jobId}
    `;
    yield { 종류: "실패", 단계: running?.이름 ?? null, 사유: reason };
  }
}

export async function* replayStages(jobId: string): AsyncGenerator<IngestEvent, void> {
  const sql = db();
  const [job] = await sql<
    Array<{ id: string; status: string; steps: IngestStage[] | null; upstage_calls: number; error: string | null }>
  >`select id, status, steps, upstage_calls, error from ingest_jobs where id = ${jobId} limit 1`;

  if (!job) {
    yield { 종류: "실패", 단계: null, 사유: "그런 잡이 없습니다." };
    return;
  }

  for (const step of job.steps ?? []) yield { 종류: "단계", 단계: step };

  if (job.status === "failed") {
    yield { 종류: "실패", 단계: null, 사유: job.error ?? "실패한 잡입니다." };
    return;
  }
  if (job.status === "done") {
    const steps = job.steps ?? [];
    const recommendation = (steps.find((s) => s.이름 === "프로젝트판정")?.산출 ?? null) as SiteRecommendation | null;
    const indexed = steps.find((s) => s.이름 === "색인")?.산출 as { 적재청크?: number } | undefined;
    yield {
      종류: "완료",
      jobId,
      upstageCalls: job.upstage_calls,
      청크수: indexed?.적재청크 ?? 0,
      추천: recommendation,
    };
  }
}
