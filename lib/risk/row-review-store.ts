import { db } from "@/lib/context/db";
import type {
  RiskRowReview,
  RiskRowReviewCommand,
  RiskRowReviewDecision,
  RiskRowReviewState,
} from "@/lib/risk/row-review-types";
import { isRiskRowDraft } from "@/lib/risk/row-review-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReviewRow = Omit<RiskRowReview, "version" | "createdAt" | "updatedAt"> & {
  version: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type EventRow = ReviewRow & {
  expectedVersion: number | string;
};

type StateRow = {
  rowId: string;
  row: unknown;
  rowFingerprint: string;
  storedFingerprint: string | null;
  decision: RiskRowReviewDecision | null;
  version: number | string | null;
  actor: string | null;
  updatedAt: Date | string | null;
};

export class RiskRowReviewVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(readonly expectedVersion: number, readonly actualVersion: number) {
    super(`행 검토 버전이 바뀌었습니다. 예상 ${expectedVersion}, 현재 ${actualVersion}.`);
    this.name = "RiskRowReviewVersionConflictError";
  }
}

export class RiskRowReviewRowConflictError extends Error {
  readonly code = "row_content_conflict";
  constructor(readonly expectedRowFingerprint: string, readonly actualRowFingerprint: string) {
    super("검토 중 위험행 내용이 바뀌었습니다.");
    this.name = "RiskRowReviewRowConflictError";
  }
}

export class RiskRowReviewCommandReuseError extends Error {
  readonly code = "command_reuse";
  constructor() {
    super("같은 명령 식별자가 다른 내용으로 다시 사용되었습니다.");
    this.name = "RiskRowReviewCommandReuseError";
  }
}

export class RiskRowReviewNotFoundError extends Error {
  readonly code = "row_not_found";
  constructor() {
    super("이 현장의 위험성평가 행을 찾지 못했습니다.");
    this.name = "RiskRowReviewNotFoundError";
  }
}

export class RiskRowReviewApprovedLockedError extends Error {
  readonly code = "approved_locked";
  constructor() {
    super("승인되어 잠긴 위험행은 별도 철회 절차 없이는 바꿀 수 없습니다.");
    this.name = "RiskRowReviewApprovedLockedError";
  }
}

export class RiskRowReviewUnavailableError extends Error {
  readonly code = "unavailable";
  constructor(message = "위험행 검토 저장소를 사용할 수 없습니다.") {
    super(message);
    this.name = "RiskRowReviewUnavailableError";
  }
}

function version(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RiskRowReviewUnavailableError("저장된 검토 버전이 올바르지 않습니다.");
  return parsed;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RiskRowReviewUnavailableError("저장된 검토 시각이 올바르지 않습니다.");
  return date.toISOString();
}

function asReview(row: ReviewRow): RiskRowReview {
  return { ...row, version: version(row.version), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function assertIdentity(siteId: string, workItemId: string): void {
  if (!UUID.test(siteId) || !workItemId.trim()) throw new TypeError("siteId 와 workItemId 가 올바르지 않습니다.");
}

function assertCommand(command: RiskRowReviewCommand): void {
  assertIdentity(command.siteId, command.workItemId);
  if (!UUID.test(command.commandId) || !command.rowId.trim() || !command.expectedRowFingerprint.trim()) {
    throw new TypeError("위험행 검토 명령 식별자가 올바르지 않습니다.");
  }
  if (command.decision !== "held" && command.decision !== "approved") {
    throw new TypeError("decision 은 held 또는 approved 여야 합니다.");
  }
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) {
    throw new TypeError("expectedVersion 은 0 이상의 정수여야 합니다.");
  }
}

async function ensureSchema(): Promise<void> {
  const sql = db();
  const [row] = await sql<{ ready: boolean }[]>`
    select to_regclass('board.work_items') is not null
       and to_regclass('public.risk_row_reviews') is not null
       and to_regclass('public.risk_row_review_events') is not null as ready
  `;
  if (!row?.ready) throw new RiskRowReviewUnavailableError("tbm-check 마이그레이션 0007 또는 board.work_items 가 적용되지 않았습니다.");
}

export async function listRiskRowReviewStates(siteId: string, workItemId: string): Promise<RiskRowReviewState[]> {
  assertIdentity(siteId, workItemId);
  await ensureSchema();
  const sql = db();
  const rows = await sql<StateRow[]>`
    select source.row ->> 'itemId' as "rowId",
           source.row as row,
           md5(source.row::text) as "rowFingerprint",
           review.row_fingerprint as "storedFingerprint",
           review.decision,
           review.version,
           review.actor,
           review.updated_at as "updatedAt"
      from board.work_items item
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(item.draft -> 'rows') = 'array' then item.draft -> 'rows'
          else '[]'::jsonb
        end
      ) with ordinality as source(row, position)
      left join risk_row_reviews review
        on review.site_id = ${siteId}::uuid
       and review.work_item_id = ${workItemId}
       and review.row_id = source.row ->> 'itemId'
     where item.site_id = ${siteId}::uuid
       and item.item_id = ${workItemId}
       and item.draft ->> 'form' = '회의록'
       and jsonb_typeof(source.row) = 'object'
       and coalesce(source.row ->> 'itemId', '') <> ''
     order by source.position
  `;
  if (rows.length === 0) {
    const emptyDraft = await sql<{ exists: boolean }[]>`
      select exists (
        select 1
          from board.work_items item
         where item.site_id = ${siteId}::uuid
           and item.item_id = ${workItemId}
           and item.draft ->> 'form' = '회의록'
           and jsonb_typeof(item.draft -> 'rows') = 'array'
           and jsonb_array_length(item.draft -> 'rows') = 0
      ) as exists
    `;
    if (emptyDraft[0]?.exists) return [];
    throw new RiskRowReviewNotFoundError();
  }
  return rows.map((row) => {
    if (!isRiskRowDraft(row.row) || row.row.itemId !== row.rowId) {
      throw new RiskRowReviewUnavailableError("저장된 위험행 초안의 형식이 올바르지 않습니다.");
    }
    const invalidatedReview = row.decision !== null && row.storedFingerprint !== row.rowFingerprint;
    return {
      rowId: row.rowId,
      row: row.row,
      rowFingerprint: row.rowFingerprint,
      decision: row.decision === null || invalidatedReview ? "pending" : row.decision,
      version: row.version === null ? 0 : version(row.version),
      actor: invalidatedReview ? null : row.actor,
      updatedAt: invalidatedReview || row.updatedAt === null ? null : iso(row.updatedAt),
      invalidatedReview,
    };
  });
}

function replayMatches(event: EventRow, command: RiskRowReviewCommand, actor: string): boolean {
  return (
    event.siteId === command.siteId && event.workItemId === command.workItemId && event.rowId === command.rowId &&
    event.rowFingerprint === command.expectedRowFingerprint && event.decision === command.decision &&
    version(event.expectedVersion) === command.expectedVersion && event.actor === actor
  );
}

export async function applyRiskRowReview(
  command: RiskRowReviewCommand,
  actor: string,
): Promise<{ review: RiskRowReview; replayed: boolean }> {
  assertCommand(command);
  if (!actor.trim()) throw new TypeError("actor 가 필요합니다.");
  await ensureSchema();
  const sql = db();

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    const prior = await tx<EventRow[]>`
      select command_id as "commandId", site_id as "siteId", work_item_id as "workItemId",
             row_id as "rowId", row_fingerprint as "rowFingerprint", decision, version,
             expected_version as "expectedVersion", actor,
             review_created_at as "createdAt", review_updated_at as "updatedAt"
        from risk_row_review_events
       where command_id = ${command.commandId}::uuid
       for update
    `;
    if (prior[0]) {
      if (!replayMatches(prior[0], command, actor)) throw new RiskRowReviewCommandReuseError();
      return { review: asReview(prior[0]), replayed: true };
    }

    await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.siteId}\u001f${command.workItemId}\u001f${command.rowId}`}, 0))`;
    const items = await tx<{ draft: unknown }[]>`
      select draft
        from board.work_items
       where item_id = ${command.workItemId} and site_id = ${command.siteId}::uuid
       for share
    `;
    if (!items[0]) throw new RiskRowReviewNotFoundError();
    const draft = items[0].draft as { form?: unknown; rows?: unknown } | null;
    const row = draft?.form === "회의록" && Array.isArray(draft.rows)
      ? draft.rows.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as { itemId?: unknown }).itemId === command.rowId)
      : null;
    if (!row) throw new RiskRowReviewNotFoundError();
    const [fingerprint] = await tx<{ value: string }[]>`select md5(${JSON.stringify(row)}::text::jsonb::text) as value`;
    if (!fingerprint?.value) throw new RiskRowReviewNotFoundError();
    if (fingerprint.value !== command.expectedRowFingerprint) {
      throw new RiskRowReviewRowConflictError(command.expectedRowFingerprint, fingerprint.value);
    }

    const current = await tx<ReviewRow[]>`
      select site_id as "siteId", work_item_id as "workItemId", row_id as "rowId",
             row_fingerprint as "rowFingerprint", decision, version, actor,
             created_at as "createdAt", updated_at as "updatedAt"
        from risk_row_reviews
       where site_id = ${command.siteId}::uuid and work_item_id = ${command.workItemId} and row_id = ${command.rowId}
       for update
    `;
    const actualVersion = current[0] ? version(current[0].version) : 0;
    if (actualVersion !== command.expectedVersion) {
      throw new RiskRowReviewVersionConflictError(command.expectedVersion, actualVersion);
    }
    if (current[0]?.decision === "approved" && current[0].rowFingerprint === fingerprint.value) {
      throw new RiskRowReviewApprovedLockedError();
    }

    const saved = current[0]
      ? (await tx<ReviewRow[]>`
          update risk_row_reviews
             set decision = ${command.decision}, row_fingerprint = ${fingerprint.value}, version = version + 1,
                 actor = ${actor}, updated_at = now()
           where site_id = ${command.siteId}::uuid and work_item_id = ${command.workItemId} and row_id = ${command.rowId}
           returning site_id as "siteId", work_item_id as "workItemId", row_id as "rowId",
                     row_fingerprint as "rowFingerprint", decision, version, actor,
                     created_at as "createdAt", updated_at as "updatedAt"
        `)[0]
      : (await tx<ReviewRow[]>`
          insert into risk_row_reviews (site_id, work_item_id, row_id, row_fingerprint, decision, version, actor)
          values (${command.siteId}::uuid, ${command.workItemId}, ${command.rowId}, ${fingerprint.value}, ${command.decision}, 1, ${actor})
          returning site_id as "siteId", work_item_id as "workItemId", row_id as "rowId",
                    row_fingerprint as "rowFingerprint", decision, version, actor,
                    created_at as "createdAt", updated_at as "updatedAt"
        `)[0];
    const review = asReview(saved);
    await tx`
      insert into risk_row_review_events
        (command_id, site_id, work_item_id, row_id, row_fingerprint, decision, version, expected_version,
         actor, review_created_at, review_updated_at)
      values (${command.commandId}::uuid, ${command.siteId}::uuid, ${command.workItemId}, ${command.rowId},
              ${fingerprint.value}, ${command.decision}, ${review.version}, ${command.expectedVersion},
              ${actor}, ${review.createdAt}, ${review.updatedAt})
    `;
    return { review, replayed: false };
  });
}
