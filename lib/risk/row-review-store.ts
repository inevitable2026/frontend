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
    // 숫자를 문장에 넣지 않는다. `expectedVersion`·`actualVersion` 은 이 오류의 필드이고
    // 라우트가 응답에 따로 실어 보내므로(app/api/risk/row-reviews/route.ts) 진단은 남는다.
    // 화면을 읽는 사람에게 「예상 3, 현재 4」 는 아무 뜻이 없다.
    super("다른 사람이 이 행의 검토 상태를 먼저 바꿨습니다. 화면을 새로 고친 뒤 다시 골라 주세요.");
    this.name = "RiskRowReviewVersionConflictError";
  }
}

export class RiskRowReviewRowConflictError extends Error {
  readonly code = "row_content_conflict";
  constructor(readonly expectedRowFingerprint: string, readonly actualRowFingerprint: string) {
    super("검토하는 사이에 이 행의 내용이 바뀌었습니다. 화면을 새로 고친 뒤 다시 확인해 주세요.");
    this.name = "RiskRowReviewRowConflictError";
  }
}

export class RiskRowReviewCommandReuseError extends Error {
  readonly code = "command_reuse";
  constructor() {
    // 같은 요청이 두 번 오는 것 자체는 막지 않는다(그래야 재시도가 안전하다). 내용이
    // 달라진 채 같은 표시를 달고 오는 것만 막는다 — 그건 화면과 서버가 어긋났다는 뜻이다.
    super("직전 요청과 내용이 어긋났습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.");
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
    super("이미 승인된 행입니다. 승인을 되돌리는 절차를 거쳐야 바꿀 수 있습니다.");
    this.name = "RiskRowReviewApprovedLockedError";
  }
}

export class RiskRowReviewUnavailableError extends Error {
  readonly code = "unavailable";
  /**
   * `detail` 은 **화면에 나가지 않는다.** 라우트가 `message` 만 응답에 싣는다.
   *
   * 예전에는 「tbm-check 마이그레이션 0007 또는 board.work_items 가 적용되지 않았습니다」
   * 가 그대로 화면에 떴다. 읽는 사람이 할 수 있는 일이 없는 문장이고, 그렇다고 그 사실을
   * 버리면 담당자가 무엇이 빠졌는지 알 길이 없다. 그래서 갈랐다.
   */
  constructor(
    message = "검토 기록을 읽고 쓸 수 없습니다. 시스템 담당자에게 문의해 주세요.",
    readonly detail?: string,
  ) {
    super(message);
    this.name = "RiskRowReviewUnavailableError";
    if (detail) console.error("[risk-row-review] unavailable:", detail);
  }
}

function version(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RiskRowReviewUnavailableError(undefined, "stored review version is not a safe non-negative integer");
  return parsed;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RiskRowReviewUnavailableError(undefined, "stored review timestamp is unparsable");
  return date.toISOString();
}

function asReview(row: ReviewRow): RiskRowReview {
  return { ...row, version: version(row.version), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function assertIdentity(siteId: string, workItemId: string): void {
  if (!UUID.test(siteId) || !workItemId.trim()) throw new TypeError("현장 또는 카드가 지정되지 않았습니다. 화면을 새로 고쳐 주세요.");
}

function assertCommand(command: RiskRowReviewCommand): void {
  assertIdentity(command.siteId, command.workItemId);
  if (!UUID.test(command.commandId) || !command.rowId.trim() || !command.expectedRowFingerprint.trim()) {
    throw new TypeError("검토 요청이 올바르게 만들어지지 않았습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.");
  }
  if (command.decision !== "held" && command.decision !== "approved") {
    throw new TypeError("검토 결과는 보류 또는 승인만 가능합니다.");
  }
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) {
    throw new TypeError("검토 요청이 올바르게 만들어지지 않았습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.");
  }
}

async function ensureSchema(): Promise<void> {
  const sql = db();
  const [row] = await sql<{ ready: boolean }[]>`
    select to_regclass('board.work_items') is not null
       and to_regclass('public.risk_row_reviews') is not null
       and to_regclass('public.risk_row_review_events') is not null as ready
  `;
  if (!row?.ready) throw new RiskRowReviewUnavailableError(
      "검토 기록을 담을 준비가 서버에 되어 있지 않습니다. 시스템 담당자에게 문의해 주세요.",
      "tbm-check migration 0007 or board.work_items is not applied",
    );
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
      throw new RiskRowReviewUnavailableError(undefined, "stored draft row payload has an unexpected shape");
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
  if (!actor.trim()) throw new TypeError("누가 검토했는지 확인되지 않았습니다. 다시 로그인한 뒤 시도해 주세요.");
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
