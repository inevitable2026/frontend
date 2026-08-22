# tbm-check migration contract: Studio ingestion cleanup controls

This repository does not own the database schema and must not execute this DDL.
The following is the minimum Gate C contract for the `tbm-check` repository to
implement with its existing Drizzle schema and migration workflow.

## Required persisted control state

Additive fields (exact SQL/Drizzle names may follow the owning repository's
conventions) must represent:

- pinned manifest SHA, account/project ID, agent/config identity, config
  fingerprint, Studio file ID, response ID, and served identity;
- cleanup status (`not_started`, `pending`, `deleted`, `failed`), cleanup
  deadline, last cleanup error code, and cleanup attempt count;
- lease owner, lease expiry, monotonically increasing `lease_fence`, and
  monotonically increasing `state_version`;
- nullable/scrubbable raw file bytes while retaining the filename and MIME type
  needed by document metadata and the existing download route.

All runner and sweeper writes must compare the current fence/state version.
A stale owner whose update affects zero rows stops before another upstream call,
DB write, or SSE event.

## Retention behavior

- Persist remote file/response IDs immediately after each successful upstream
  mutation, before polling or any later network continuation.
- Scrub raw bytes when the job reaches a terminal state, and no later than one
  hour after upload.
- Delete unsaved staged chunks and sensitive stage outputs no later than one
  hour after terminal processing.
- Preserve committed document metadata/provenance and the explicitly approved
  original-file retention behavior. If original downloads remain required,
  copy/retain them under a separately defined document retention policy rather
  than leaving staging bytes indefinitely.

## Sweeper and compatibility requirements

- An authenticated scheduled sweeper atomically claims expired leases under
  recovery policy `cleanup-only-v1`. It never polls or resumes a persisted
  response and never creates a remote file or response; it only deletes known
  remote files.
- Two sweepers racing for one job produce one winning fence; the loser stops.
- Old frontend deployments remain compatible during the additive rollout.
- Migration rollback must not resurrect scrubbed bytes or weaken remote cleanup.
- Expose a deployed migration-version probe and a freshness/health receipt with
  `recoveryPolicy: "cleanup-only-v1"` that this frontend can include in
  `STUDIO_LIVE_READINESS_RECEIPT_JSON`.

Until this migration, sweeper, and version probe are deployed and verified,
`STUDIO_LIVE_INGEST_ENABLED` must remain false and this frontend returns 503
before reading or storing live-upload bytes.
