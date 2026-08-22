import { db } from "./db.ts";
import { deleteStudioFileForCleanup } from "./studio.ts";

/**
 * 버려진 문서 적재 잡을 회수한다.
 *
 * **왜 있어야 하는가.** 라이브 경로는 자기가 올린 원격 파일을 자기가 지운다
 * (`studio.ts` 의 `finally`). 그런데 그 요청이 죽으면 — 배포로 인스턴스가 내려가거나,
 * 사람이 탭을 닫거나, 호스트 예산이 끝나거나 — **지울 사람이 사라진다.** 사람이 결과를
 * 저장하지 않은 채 저장 창(1시간)이 지나도 마찬가지다. 그러면 올린 계약서 바이트가
 * 아무도 모르게 남는다.
 *
 * 이 화면이 다루는 것은 하도급 계약서다. "지워진다"는 말이 지켜지지 않으면 이 기능은
 * 켜져 있으면 안 된다 — `docs/tbm-check-studio-cleanup-contract.md:51-53` 이 그렇게 적고
 * 있고, 라이브 게이트가 닫혀 있던 이유가 정확히 이것이다.
 *
 * **무엇을 하지 않는가 — 이것이 `cleanup-only-v1` 의 내용이다.**
 * 회수기는 `deleteStudioFileForCleanup` 하나만 부른다. 파일을 만들지 않고, 응답을 만들지
 * 않고, 멈춘 응답을 이어받지도 않는다. 회수기가 업로드를 재개할 수 있으면 그것은 더 이상
 * 정리기가 아니라 두 번째 러너이고, 유료 호출과 원본 바이트를 다루는 경로가 감시 없이
 * 하나 더 생기는 셈이다.
 *
 * **경쟁.** 두 회수기가 같은 잡을 집으면 `state_version` 비교에서 하나만 이긴다. 진 쪽은
 * 0행을 받고 **그 자리에서 멈춘다** — 계약(`:44`)이 요구하는 동작이다. 지금 공유 DB 에는
 * 출처를 알 수 없는 회수기가 하나 더 돌고 있는데(`studio_sweeper_health` 를 4분마다
 * 갱신 중), 같은 fence 규칙을 쓰므로 공존해도 한쪽만 이긴다.
 */

export const SWEEPER_RECOVERY_POLICY = "cleanup-only-v1";

/** 한 번에 회수할 최대 건수. 예산이 있는 호스트에서 돌므로 무한정 집지 않는다. */
const DEFAULT_LIMIT = 25;
const DEFAULT_LEASE_MS = 60_000;

export type StaleJob = {
  id: string;
  studioFileId: string | null;
  cleanupStatus: string | null;
  bytesScrubbed: boolean;
  cleanupAttempts: number;
  stateVersion: number;
};

export type SweepClaim = {
  id: string;
  owner: string;
  fence: number;
  stateVersion: number;
};

export type SweepResult = {
  /** 기한이 지나 회수 대상으로 보인 건수. */
  stale: number;
  /** 실제로 소유권을 잡은 건수. 나머지는 다른 회수기가 이겼다. */
  claimed: number;
  /** 원격 파일 삭제와 바이트 지우기가 모두 끝난 건수. */
  cleaned: number;
  /** 시도했으나 끝내지 못한 건수. 다음 회차가 다시 집는다. */
  failed: number;
};

/**
 * 저장소에 대고 하는 일만 모은 자리.
 *
 * 회수 절차 자체(무엇을 어떤 순서로, 실패하면 어떻게)와 SQL 을 갈라 둔다. 이 절차는
 * 삭제를 하므로 시험이 실제 DB 없이 돌아야 하고, 특히 **fence 경쟁에서 진 쪽이 정말로
 * 멈추는지**를 시험으로 못박아야 한다.
 */
export type SweepPort = {
  listStale(limit: number): Promise<StaleJob[]>;
  /** `stateVersion` 이 그대로일 때만 잡는다. 0행이면 다른 회수기가 이긴 것이다. */
  claim(job: StaleJob, owner: string, leaseMs: number): Promise<SweepClaim | null>;
  scrub(claim: SweepClaim): Promise<SweepClaim | null>;
  markDeleted(claim: SweepClaim, attempts: number): Promise<SweepClaim | null>;
  markFailed(claim: SweepClaim, attempts: number, errorCode: string): Promise<SweepClaim | null>;
  recordHealth(owner: string, result: SweepResult): Promise<void>;
};

export type SweepOptions = {
  owner: string;
  limit?: number;
  leaseMs?: number;
  /** 원격 파일 삭제. 삭제 말고 다른 일을 하는 함수를 여기 끼우면 정책이 깨진다. */
  deleteRemote?: (fileId: string) => Promise<{ status: string; attempts: number }>;
  /** 무엇을 지울지만 세어 보고 실제로는 지우지 않는다. 첫 실행에 쓴다. */
  dryRun?: boolean;
};

export async function sweep(port: SweepPort, options: SweepOptions): Promise<SweepResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const deleteRemote = options.deleteRemote ?? ((fileId: string) => deleteStudioFileForCleanup(fileId));

  const stale = await port.listStale(limit);
  const result: SweepResult = { stale: stale.length, claimed: 0, cleaned: 0, failed: 0 };

  // 무엇이 걸리는지만 보고 멈춘다. 공유 운영 DB 에 처음 대볼 때 이 경로로 먼저 본다.
  if (options.dryRun) return result;

  for (const job of stale) {
    const claim = await port.claim(job, options.owner, leaseMs);
    // 진 쪽은 여기서 끝난다. 원격 호출도, 다음 쓰기도 하지 않는다.
    if (!claim) continue;
    result.claimed += 1;

    let held: SweepClaim | null = claim;
    let attempts = job.cleanupAttempts;

    // 이미 지워진 파일을 다시 지우려 들지 않는다. 원격이 404 를 주면 `deleted` 로 치므로
    // 재시도 자체는 안전하지만, 지운 것을 또 부르는 호출은 그냥 낭비다.
    if (job.studioFileId && job.cleanupStatus !== "deleted") {
      const outcome = await deleteRemote(job.studioFileId);
      attempts += outcome.attempts;
      if (outcome.status !== "deleted") {
        await port.markFailed(held, attempts, `remote_${outcome.status}`);
        result.failed += 1;
        continue;
      }
    }

    if (!job.bytesScrubbed) {
      held = await port.scrub(held);
      if (!held) {
        // 지우는 도중에 소유권을 잃었다. 바이트는 남아 있으므로 실패로 센다.
        result.failed += 1;
        continue;
      }
    }

    const done = await port.markDeleted(held, attempts);
    if (!done) {
      result.failed += 1;
      continue;
    }
    result.cleaned += 1;
  }

  await port.recordHealth(options.owner, result);
  return result;
}

/**
 * 실제 Postgres 에 대고 도는 구현.
 *
 * 잠금 방식은 `lib/context/ingest-control.ts` 의 것을 그대로 쓴다 — fence 를 올리고
 * `state_version` 을 비교한다. 회수 경로만 다른 잠금을 쓰면 두 경로가 서로를 못 본다.
 */
export function postgresSweepPort(): SweepPort {
  const sql = db();

  return {
    async listStale(limit) {
      const rows = await sql<Array<{
        id: string;
        studio_file_id: string | null;
        cleanup_status: string | null;
        bytes_scrubbed_at: Date | null;
        cleanup_attempts: number | null;
        state_version: number | null;
      }>>`
        select id, studio_file_id, cleanup_status, bytes_scrubbed_at, cleanup_attempts, state_version
          from ingest_jobs
         where mode = 'live'
           and document_id is null
           and (
             (cleanup_deadline is not null and cleanup_deadline < now())
             or (status = 'running' and lease_expires_at is not null and lease_expires_at < now())
           )
           and (cleanup_status is distinct from 'deleted' or bytes_scrubbed_at is null)
         order by cleanup_deadline nulls last, created_at
         limit ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        studioFileId: row.studio_file_id,
        cleanupStatus: row.cleanup_status,
        bytesScrubbed: row.bytes_scrubbed_at !== null,
        cleanupAttempts: Number(row.cleanup_attempts ?? 0),
        stateVersion: Number(row.state_version ?? 0),
      }));
    },

    async claim(job, owner, leaseMs) {
      const rows = await sql<Array<{ lease_fence: number; state_version: number }>>`
        update ingest_jobs
           set lease_owner = ${owner},
               lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
               lease_fence = coalesce(lease_fence, 0) + 1,
               state_version = coalesce(state_version, 0) + 1
         where id = ${job.id}
           and document_id is null
           and coalesce(state_version, 0) = ${job.stateVersion}
         returning lease_fence, state_version
      `;
      if (!rows[0]) return null;
      return { id: job.id, owner, fence: Number(rows[0].lease_fence), stateVersion: Number(rows[0].state_version) };
    },

    async scrub(claim) {
      type Fenced = { lease_fence: number; state_version: number };
      const rows: Fenced[] = await sql.begin<Fenced[]>(async (tx) => {
        const guarded = await tx<Fenced[]>`
          update ingest_jobs
             set state_version = state_version + 1, bytes_scrubbed_at = now()
           where id = ${claim.id} and lease_owner = ${claim.owner}
             and lease_fence = ${claim.fence} and state_version = ${claim.stateVersion}
           returning lease_fence, state_version
        `;
        if (!guarded[0]) return [] as Fenced[];
        await tx`delete from document_chunks where job_id = ${claim.id} and document_id is null`;
        await tx`update document_files set bytes = null where job_id = ${claim.id} and document_id is null`;
        return guarded;
      });
      if (!rows[0]) return null;
      return { ...claim, fence: Number(rows[0].lease_fence), stateVersion: Number(rows[0].state_version) };
    },

    async markDeleted(claim, attempts) {
      const rows = await sql<Array<{ lease_fence: number; state_version: number }>>`
        update ingest_jobs
           set cleanup_status = 'deleted', cleanup_attempts = ${attempts}, cleanup_error_code = null,
               cleanup_deadline = null, lease_expires_at = now(),
               state_version = state_version + 1
         where id = ${claim.id} and lease_owner = ${claim.owner}
           and lease_fence = ${claim.fence} and state_version = ${claim.stateVersion}
         returning lease_fence, state_version
      `;
      if (!rows[0]) return null;
      return { ...claim, fence: Number(rows[0].lease_fence), stateVersion: Number(rows[0].state_version) };
    },

    async markFailed(claim, attempts, errorCode) {
      const rows = await sql<Array<{ lease_fence: number; state_version: number }>>`
        update ingest_jobs
           set cleanup_status = 'failed', cleanup_attempts = ${attempts},
               cleanup_error_code = ${errorCode.slice(0, 120)}, lease_expires_at = now(),
               state_version = state_version + 1
         where id = ${claim.id} and lease_owner = ${claim.owner}
           and lease_fence = ${claim.fence} and state_version = ${claim.stateVersion}
         returning lease_fence, state_version
      `;
      if (!rows[0]) return null;
      return { ...claim, fence: Number(rows[0].lease_fence), stateVersion: Number(rows[0].state_version) };
    },

    async recordHealth(owner, result) {
      /*
       * 한 행짜리 표다. 지금 도는 다른 회수기와 같은 모양을 쓴다 — 모양이 갈리면
       * 신선도를 읽는 쪽이 둘 중 하나를 못 본다.
       *
       * **`recovery_policy` 를 쓰는 이유.** `last_owner` 로는 누가 썼는지 못 가른다.
       * 공유 DB 에서 도는 그 정체불명 회수기가 매 사이클 **새 uuid** 를 쓰기 때문이다
       * (관측된 것만 다섯 개). 그래서 우리 구현임을 남기는 자리는 이 칸이다. 그쪽은
       * 이 컬럼이 없던 시절에 배포됐으므로 이 칸을 건드리지 않는다.
       *
       * 컬럼이 아직 없으면(마이그레이션 0006 미적용) **쓰지 않고 넘어간다.** 그러면
       * `scripts/studio-db-health.mjs` 가 표식을 못 찾아 증명을 거절하고, 라이브 게이트는
       * 닫힌 채로 남는다. 막는 자리는 여기가 아니라 증명 쪽이다 — 회수기는 게이트와
       * 무관하게 계속 돌아야 한다.
       */
      const [column] = await sql<Array<{ column_name: string }>>`
        select column_name from information_schema.columns
         where table_name = 'studio_sweeper_health' and column_name = 'recovery_policy'
         limit 1
      `;

      if (column) {
        await sql`
          insert into studio_sweeper_health (id, last_success_at, last_owner, last_result, recovery_policy, state_version)
          values (1, now(), ${owner}, ${sql.json(result as never)}, ${SWEEPER_RECOVERY_POLICY}, 1)
          on conflict (id) do update set
            last_success_at = now(),
            last_owner = excluded.last_owner,
            last_result = excluded.last_result,
            recovery_policy = excluded.recovery_policy,
            state_version = studio_sweeper_health.state_version + 1
        `;
        return;
      }

      await sql`
        insert into studio_sweeper_health (id, last_success_at, last_owner, last_result, state_version)
        values (1, now(), ${owner}, ${sql.json(result as never)}, 1)
        on conflict (id) do update set
          last_success_at = now(),
          last_owner = excluded.last_owner,
          last_result = excluded.last_result,
          state_version = studio_sweeper_health.state_version + 1
      `;
    },
  };
}
