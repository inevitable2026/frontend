import { db } from "./db.ts";

/**
 * Gate C durable runner ownership.  Every mutating operation advances
 * state_version; a zero-row result means another runner owns the job now.
 */
export type IngestLease = {
  jobId: string;
  owner: string;
  fence: number;
  stateVersion: number;
};

/**
 * Immutable Studio capability identity captured from the validated readiness
 * receipt before the first remote call. `servedIdentity` is intentionally
 * absent: it is response-observed provenance and cannot be asserted upfront.
 * These values are operational provenance, never API credentials.
 */
export type StudioIngestProvenance = {
  manifestSha: string;
  accountId: string;
  agentId: string;
  configId: string | null;
  configFingerprint: string;
};

export function matchesStudioIngestProvenance(
  actual: StudioIngestProvenance,
  expected: StudioIngestProvenance,
): boolean {
  return actual.manifestSha === expected.manifestSha &&
    actual.accountId === expected.accountId &&
    actual.agentId === expected.agentId &&
    actual.configId === expected.configId &&
    actual.configFingerprint === expected.configFingerprint;
}

export class IngestLeaseLostError extends Error {
  constructor() {
    super("이 적재 작업의 실행 소유권이 다른 실행기로 넘어갔습니다.");
    this.name = "IngestLeaseLostError";
  }
}

type LeaseRow = { lease_fence: number; state_version: number };

function next(rows: LeaseRow[], lease: IngestLease): IngestLease {
  const row = rows[0];
  if (!row) throw new IngestLeaseLostError();
  return { ...lease, fence: Number(row.lease_fence), stateVersion: Number(row.state_version) };
}

export async function acquireIngestLease(jobId: string, owner: string, leaseMs = 30_000): Promise<IngestLease | null> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set status = 'running', started_at = coalesce(started_at, now()),
           lease_owner = ${owner}, lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
           lease_fence = coalesce(lease_fence, 0) + 1,
           state_version = coalesce(state_version, 0) + 1
     where id = ${jobId} and status = 'pending'
     returning lease_fence, state_version
  `;
  if (!rows[0]) return null;
  return { jobId, owner, fence: Number(rows[0].lease_fence), stateVersion: Number(rows[0].state_version) };
}

/** Renew before an upstream call or outbound SSE frame. */
export async function renewIngestLease(lease: IngestLease, leaseMs = 30_000): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
           state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running'
       and lease_owner = ${lease.owner} and lease_fence = ${lease.fence}
       and state_version = ${lease.stateVersion}
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

/**
 * Keep a running lease alive without advancing its fenced state version.
 *
 * Pipeline checkpoints own `state_version`. A timer may run while an upstream
 * request is in flight, so letting that timer advance the version would make
 * the pipeline's next compare-and-swap stale. The owner/fence pair is enough
 * for this liveness-only update; a reclaimed or terminal job returns false.
 */
export async function heartbeatIngestLease(lease: IngestLease, leaseMs = 30_000): Promise<boolean> {
  const sql = db();
  const rows = await sql<Array<{ id: string }>>`
    update ingest_jobs
       set lease_expires_at = now() + (${leaseMs} * interval '1 millisecond')
     where id = ${lease.jobId} and status = 'running'
       and lease_owner = ${lease.owner} and lease_fence = ${lease.fence}
     returning id
  `;
  return rows.length === 1;
}

/** Fence check for a final SSE frame: terminal jobs must not be renewed. */
export async function assertIngestLease(lease: IngestLease): Promise<void> {
  const sql = db();
  const rows = await sql<Array<{ id: string }>>`
    select id from ingest_jobs
     where id = ${lease.jobId} and lease_owner = ${lease.owner} and lease_fence = ${lease.fence}
       and state_version = ${lease.stateVersion}
  `;
  if (!rows[0]) throw new IngestLeaseLostError();
}

/**
 * Bind a live job to the exact readiness/workflow identity before any Studio
 * upload. A duplicate checkpoint may only repeat the same complete identity;
 * partial or different provenance is deliberately a zero-row fenced write.
 */
export async function persistStudioProvenance(
  lease: IngestLease,
  provenance: StudioIngestProvenance,
): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set studio_manifest_sha = ${provenance.manifestSha},
           studio_account_id = ${provenance.accountId},
           studio_agent_id = ${provenance.agentId},
           studio_config_id = ${provenance.configId},
           studio_config_fingerprint = ${provenance.configFingerprint},
           state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
       and (
         (studio_manifest_sha is null and studio_account_id is null and studio_agent_id is null
          and studio_config_id is null and studio_config_fingerprint is null)
         or
         (studio_manifest_sha is not distinct from ${provenance.manifestSha}
          and studio_account_id is not distinct from ${provenance.accountId}
          and studio_agent_id is not distinct from ${provenance.agentId}
          and studio_config_id is not distinct from ${provenance.configId}
          and studio_config_fingerprint is not distinct from ${provenance.configFingerprint})
       )
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

/** Persist only the identity actually echoed by a response after validation. */
export async function persistStudioServedIdentity(
  lease: IngestLease,
  servedIdentity: string,
): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set studio_served_identity = ${servedIdentity}, state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
       and (studio_served_identity is null or studio_served_identity is not distinct from ${servedIdentity})
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

export async function persistStudioFile(lease: IngestLease, fileId: string, cleanupDeadline?: number): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set studio_file_id = ${fileId}, cleanup_status = 'pending',
           cleanup_deadline = ${cleanupDeadline ? new Date(cleanupDeadline) : null},
           state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
       and (studio_file_id is null or studio_file_id is not distinct from ${fileId})
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

export async function persistStudioResponse(lease: IngestLease, responseId: string): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set studio_response_id = ${responseId}, state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
       and (studio_response_id is null or studio_response_id is not distinct from ${responseId})
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

export async function persistStudioCleanup(
  lease: IngestLease,
  cleanup: { status: string; attempts: number },
  errorCode?: string,
): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set cleanup_status = ${cleanup.status}, cleanup_attempts = ${cleanup.attempts},
           cleanup_error_code = ${errorCode?.slice(0, 120) ?? null}, state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

export async function persistIngestStages(lease: IngestLease, steps: unknown): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs set steps = ${sql.json(steps as never)}, state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

export async function failIngestLease(lease: IngestLease, reason: string, steps: unknown, upstageCalls: number): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set status = 'failed', error = ${reason}, finished_at = now(), upstage_calls = ${upstageCalls},
           steps = ${sql.json(steps as never)},
           lease_expires_at = now(), state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

export async function completeIngestLease(lease: IngestLease, steps: unknown, upstageCalls: number): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set status = 'done', finished_at = now(), upstage_calls = ${upstageCalls}, steps = ${sql.json(steps as never)},
           lease_expires_at = now(), state_version = state_version + 1
     where id = ${lease.jobId} and status = 'running' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
       and cleanup_status = 'deleted'
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

/**
 * Remote Studio cleanup has completed, but the operator still needs time to
 * choose a site and save the document.  Keep raw bytes only during this
 * bounded staging window; document saving atomically clears the deadline and
 * thereby promotes the file to document retention.
 */
export async function openHumanSaveWindow(lease: IngestLease, retentionMs = 60 * 60 * 1000): Promise<IngestLease> {
  const sql = db();
  const rows = await sql<LeaseRow[]>`
    update ingest_jobs
       set cleanup_deadline = now() + (${retentionMs} * interval '1 millisecond'),
           state_version = state_version + 1
     where id = ${lease.jobId} and status = 'done' and document_id is null
       and cleanup_status = 'deleted' and lease_owner = ${lease.owner}
       and lease_fence = ${lease.fence} and state_version = ${lease.stateVersion}
     returning lease_fence, state_version
  `;
  return next(rows, lease);
}

export async function scrubStagingBytes(lease: IngestLease): Promise<IngestLease> {
  const sql = db();
  const rows: LeaseRow[] = await sql.begin<LeaseRow[]>(async (tx) => {
    const guarded = await tx<LeaseRow[]>`
      update ingest_jobs
         set state_version = state_version + 1, bytes_scrubbed_at = now()
       where id = ${lease.jobId} and lease_owner = ${lease.owner} and lease_fence = ${lease.fence}
         and state_version = ${lease.stateVersion}
       returning lease_fence, state_version
    `;
    if (!guarded[0]) return [] as LeaseRow[];
    await tx`delete from document_chunks where job_id = ${lease.jobId} and document_id is null`;
    await tx`update document_files set bytes = null where job_id = ${lease.jobId} and document_id is null`;
    return guarded;
  });
  return next(rows, lease);
}
