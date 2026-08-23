import { createHash } from "node:crypto";

import { db } from "@/lib/context/db";
import { isRiskRowDraft } from "@/lib/risk/row-review-types";
import type { Sql, TransactionSql } from "postgres";

import {
  applicationFingerprint,
  assertRiskRowApplicationCommand,
  targetDocumentId,
  toRiskRowApplicationFact,
  type RiskRowApplicationCommand,
  type RiskRowApplicationDescriptor,
  type RiskRowApplicationResult,
  RISK_ROW_APPLICATION_UUID,
} from "./row-application-types";

type ApplicationRow = {
  commandId: string;
  siteId: string;
  workItemId: string;
  requestFingerprint: string;
  actor: string;
  result: unknown;
};

type ItemRow = {
  status: string;
  confirmedBy: string | null;
  confirmedAt: Date | string | null;
  draft: unknown;
  produces: unknown;
  invalidates: unknown;
  trigger: unknown;
  blockedBy: unknown;
};

type DraftRow = { rowId: string; row: unknown; rowFingerprint: string; position: number | string };

type ReviewRow = { rowId: string; rowFingerprint: string; decision: string; version: number | string };
type QuerySql = Sql | TransactionSql;

const advisoryKey = (siteId: string, workItemId: string) => `${siteId}\u001f${workItemId}`;

export class RiskRowApplicationNotFoundError extends Error {
  readonly code = "not_found";
  constructor(message = "이 현장의 위험성평가 카드를 찾지 못했습니다.") {
    super(message);
    this.name = "RiskRowApplicationNotFoundError";
  }
}

export class RiskRowApplicationConflictError extends Error {
  readonly code = "application_conflict";
  constructor(message: string) {
    super(message);
    this.name = "RiskRowApplicationConflictError";
  }
}

export class RiskRowApplicationUnavailableError extends Error {
  readonly code = "unavailable";
  constructor(message = "위험성평가 반영 저장소를 사용할 수 없습니다.") {
    super(message);
    this.name = "RiskRowApplicationUnavailableError";
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asItem(row: ItemRow) {
  return {
    status: row.status,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
    draft: row.draft,
    produces: asArray(row.produces).flatMap((value) => value && typeof value === "object" && !Array.isArray(value) ? [value as { into?: string }] : []),
    invalidates: asArray(row.invalidates).flatMap((value) => value && typeof value === "object" && !Array.isArray(value) ? [value as { docId?: string }] : []),
    trigger: row.trigger && typeof row.trigger === "object" && !Array.isArray(row.trigger) ? row.trigger as { sourceDocRefs?: string[] } : null,
    blockedBy: asArray(row.blockedBy).flatMap((value) => {
      const id = asString(value);
      return id ? [id] : [];
    }),
  };
}

function uniqueRows(rows: DraftRow[]): { rows: Array<{ rowId: string; row: import("@/lib/board/types").RiskRowDraft; rowFingerprint: string }>; issue: string | null } {
  const ids = new Set<string>();
  const normalized = [] as Array<{ rowId: string; row: import("@/lib/board/types").RiskRowDraft; rowFingerprint: string }>;
  for (const entry of rows) {
    if (!entry.rowId || ids.has(entry.rowId) || !isRiskRowDraft(entry.row) || entry.row.itemId !== entry.rowId) {
      return { rows: [], issue: "회의록 초안의 위험행 식별자가 비어 있거나 중복되었거나 형식이 올바르지 않습니다." };
    }
    ids.add(entry.rowId);
    normalized.push({ rowId: entry.rowId, row: entry.row, rowFingerprint: entry.rowFingerprint });
  }
  return normalized.length > 0 ? { rows: normalized, issue: null } : { rows: [], issue: "반영할 위험성평가 행이 없습니다." };
}

function requestFingerprint(
  command: RiskRowApplicationCommand & { expectedApplicationFingerprint: string },
  actor: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    commandId: command.commandId,
    siteId: command.siteId,
    workItemId: command.workItemId,
    expectedApplicationFingerprint: command.expectedApplicationFingerprint,
    actor,
  })).digest("hex");
}

function replayResult(value: unknown, expected: { commandId: string; siteId: string; workItemId: string; actor: string }): Omit<RiskRowApplicationResult, "replayed"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RiskRowApplicationUnavailableError("저장된 반영 영수증의 형식이 올바르지 않습니다.");
  const result = value as Record<string, unknown>;
  const integerArray = (entry: unknown): number[] | null => Array.isArray(entry) && entry.every((item) => Number.isSafeInteger(item) && Number(item) > 0) ? entry as number[] : null;
  const stringArray = (entry: unknown): string[] | null => Array.isArray(entry) && entry.every((item) => typeof item === "string" && item.trim()) ? entry as string[] : null;
  if (
    result.commandId !== expected.commandId || result.siteId !== expected.siteId || result.workItemId !== expected.workItemId || result.actor !== expected.actor ||
    typeof result.targetDocumentId !== "string" || !result.targetDocumentId || !stringArray(result.rowIds) || !integerArray(result.factIds) ||
    !Number.isSafeInteger(result.workItemEventId) || Number(result.workItemEventId) < 1 || typeof result.appliedAt !== "string" || Number.isNaN(new Date(result.appliedAt).getTime())
  ) throw new RiskRowApplicationUnavailableError("저장된 반영 영수증의 형식이 올바르지 않습니다.");
  return result as Omit<RiskRowApplicationResult, "replayed">;
}

async function ensureSchema(): Promise<void> {
  const [row] = await db()<{ ready: boolean }[]>`
    select to_regclass('board.work_items') is not null
       and to_regclass('board.snapshot_facts') is not null
       and to_regclass('board.work_item_events') is not null
       and to_regclass('public.risk_row_reviews') is not null
       and to_regclass('public.risk_row_application_events') is not null as ready
  `;
  if (!row?.ready) throw new RiskRowApplicationUnavailableError("tbm-check 마이그레이션 0007·0008 과 board 스키마가 적용되지 않았습니다.");
}

async function draftRows(sql: QuerySql, siteId: string, workItemId: string): Promise<DraftRow[]> {
  return sql<DraftRow[]>`
    select source.row ->> 'itemId' as "rowId", source.row as row, md5(source.row::text) as "rowFingerprint", source.position
      from board.work_items item
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(item.draft -> 'rows') = 'array' then item.draft -> 'rows' else '[]'::jsonb end
      ) with ordinality as source(row, position)
     where item.site_id = ${siteId}::uuid and item.item_id = ${workItemId}
     order by source.position
  `;
}

function descriptor(item: ReturnType<typeof asItem>, rows: DraftRow[], reviews: ReviewRow[], siteId: string, workItemId: string, blocked: boolean): RiskRowApplicationDescriptor {
  const issues: RiskRowApplicationDescriptor["issues"] = [];
  if (item.status !== "approval" || item.confirmedBy !== null || item.confirmedAt !== null || !item.draft || typeof item.draft !== "object" || (item.draft as { form?: unknown }).form !== "회의록") {
    issues.push({ code: "work_item_not_unconfirmed_approval", message: "아직 확정하지 않은 승인 대기 카드만 반영할 수 있습니다." });
  }
  const target = targetDocumentId(item);
  if (!target) issues.push({ code: "target_document_missing", message: "반영 대상 문서를 찾지 못했습니다." });
  const normalized = uniqueRows(rows);
  if (normalized.issue) issues.push({ code: "draft_rows_invalid", message: normalized.issue });
  if (blocked) issues.push({ code: "blocked", message: "선행 카드가 아직 완료되지 않았습니다." });
  const reviewById = new Map(reviews.map((review) => [review.rowId, review]));
  const approvedRows: Array<{ rowId: string; rowFingerprint: string; reviewRowFingerprint: string; decision: "approved"; version: number }> = [];
  for (const row of normalized.rows) {
    const review = reviewById.get(row.rowId);
    const reviewVersion = review ? Number(review.version) : NaN;
    if (!review || review.decision !== "approved" || review.rowFingerprint !== row.rowFingerprint || !Number.isSafeInteger(reviewVersion) || reviewVersion < 1) {
      issues.push({ code: "rows_not_approved", message: "모든 현재 위험행이 승인되어야 합니다." });
      break;
    }
    approvedRows.push({ rowId: row.rowId, rowFingerprint: row.rowFingerprint, reviewRowFingerprint: review.rowFingerprint, decision: "approved", version: reviewVersion });
  }
  const fingerprint = target && !normalized.issue && approvedRows.length === normalized.rows.length
    ? applicationFingerprint({ siteId, workItemId, targetDocumentId: target, rows: approvedRows })
    : null;
  return { targetDocumentId: target, applicationFingerprint: fingerprint, eligible: issues.length === 0, issues, rowIds: normalized.rows.map((row) => row.rowId) };
}

async function blockedByIncomplete(sql: QuerySql, siteId: string, itemIds: string[]): Promise<boolean> {
  if (itemIds.length === 0) return false;
  const [row] = await sql<{ incomplete: boolean }[]>`
    select exists(
      select 1
        from unnest(${itemIds}::text[]) as required(item_id)
        left join board.work_items dependency
          on dependency.site_id = ${siteId}::uuid and dependency.item_id = required.item_id
       where dependency.item_id is null or dependency.status <> 'done'
    ) as incomplete
  `;
  return Boolean(row?.incomplete);
}

export async function getRiskRowApplicationDescriptor(siteId: string, workItemId: string): Promise<RiskRowApplicationDescriptor> {
  if (!RISK_ROW_APPLICATION_UUID.test(siteId) || !workItemId.trim()) throw new TypeError("siteId 와 workItemId 가 올바르지 않습니다.");
  await ensureSchema();
  const sql = db();
  const items = await sql<ItemRow[]>`
    select status, confirmed_by as "confirmedBy", confirmed_at as "confirmedAt", draft, produces, invalidates, trigger, blocked_by as "blockedBy"
      from board.work_items where site_id = ${siteId}::uuid and item_id = ${workItemId}
  `;
  if (!items[0]) throw new RiskRowApplicationNotFoundError();
  const item = asItem(items[0]);
  const rows = await draftRows(sql, siteId, workItemId);
  const reviews = await sql<ReviewRow[]>`
    select row_id as "rowId", row_fingerprint as "rowFingerprint", decision, version
      from risk_row_reviews where site_id = ${siteId}::uuid and work_item_id = ${workItemId}
  `;
  return descriptor(item, rows, reviews, siteId, workItemId, await blockedByIncomplete(sql, siteId, item.blockedBy));
}

export async function applyRiskRowApplication(command: RiskRowApplicationCommand, actor: string): Promise<RiskRowApplicationResult> {
  assertRiskRowApplicationCommand(command);
  if (!actor.trim()) throw new TypeError("actor 가 필요합니다.");
  await ensureSchema();
  const sql = db();
  const requested = requestFingerprint(command, actor);

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    const prior = await tx<ApplicationRow[]>`
      select command_id as "commandId", site_id as "siteId", work_item_id as "workItemId", request_fingerprint as "requestFingerprint", actor, result
        from risk_row_application_events where command_id = ${command.commandId}::uuid for update
    `;
    if (prior[0]) {
      if (prior[0].requestFingerprint !== requested || prior[0].actor !== actor) {
        throw new RiskRowApplicationConflictError("같은 명령 식별자를 다른 요청으로 재사용할 수 없습니다.");
      }
      return { ...replayResult(prior[0].result, { commandId: command.commandId, siteId: command.siteId, workItemId: command.workItemId, actor }), replayed: true };
    }

    await tx`select pg_advisory_xact_lock(hashtextextended(${advisoryKey(command.siteId, command.workItemId)}, 0))`;
    const items = await tx<ItemRow[]>`
      select status, confirmed_by as "confirmedBy", confirmed_at as "confirmedAt", draft, produces, invalidates, trigger, blocked_by as "blockedBy"
        from board.work_items where site_id = ${command.siteId}::uuid and item_id = ${command.workItemId} for update
    `;
    if (!items[0]) throw new RiskRowApplicationNotFoundError();
    const item = asItem(items[0]);

    const alreadyApplied = await tx<ApplicationRow[]>`
      select command_id as "commandId", site_id as "siteId", work_item_id as "workItemId", request_fingerprint as "requestFingerprint", actor, result
        from risk_row_application_events where site_id = ${command.siteId}::uuid and work_item_id = ${command.workItemId} for update
    `;
    if (alreadyApplied[0]) throw new RiskRowApplicationConflictError("이 카드는 이미 위험성평가표에 반영되었습니다.");

    const rows = await draftRows(tx, command.siteId, command.workItemId);
    const normalized = uniqueRows(rows);
    const rowIds = normalized.rows.map((row) => row.rowId);
    const reviews = rowIds.length === 0 ? [] : await tx<ReviewRow[]>`
      select row_id as "rowId", row_fingerprint as "rowFingerprint", decision, version
        from risk_row_reviews
       where site_id = ${command.siteId}::uuid and work_item_id = ${command.workItemId} and row_id = any(${rowIds}::text[])
       order by row_id for update
    `;
    const state = descriptor(item, rows, reviews, command.siteId, command.workItemId, await blockedByIncomplete(tx, command.siteId, item.blockedBy));
    if (!state.eligible || !state.targetDocumentId || !state.applicationFingerprint) {
      throw new RiskRowApplicationConflictError(state.issues.map((issue) => issue.message).join(" ") || "위험성평가표를 반영할 수 없습니다.");
    }
    if (state.applicationFingerprint !== command.expectedApplicationFingerprint) {
      throw new RiskRowApplicationConflictError("반영할 초안 또는 검토 상태가 바뀌었습니다. 최신 상태를 다시 확인하세요.");
    }

    const appliedAt = new Date().toISOString();
    const factIds: number[] = [];
    for (const row of normalized.rows) {
      const [fact] = await tx<{ factId: number | string }[]>`
        insert into board.snapshot_facts (site_id, fact_type, key, value, observed_at, source_doc_id, confidence)
        values (
          ${command.siteId}::uuid, 'riskAssessmentRow', ${`${state.targetDocumentId}#${row.rowId}`},
          ${JSON.stringify(toRiskRowApplicationFact(row.row, state.targetDocumentId))}::text::jsonb,
          ${appliedAt}::timestamptz, ${state.targetDocumentId}, 1
        ) returning fact_id as "factId"
      `;
      if (!fact) throw new RiskRowApplicationUnavailableError("위험성평가 행을 저장하지 못했습니다.");
      factIds.push(Number(fact.factId));
    }

    const completed = await tx<{ itemId: string }[]>`
      update board.work_items set status = 'done', confirmed_by = ${actor}, confirmed_at = ${appliedAt}::timestamptz, updated_at = ${appliedAt}::timestamptz
       where site_id = ${command.siteId}::uuid and item_id = ${command.workItemId}
         and status = 'approval' and confirmed_by is null and confirmed_at is null
       returning item_id as "itemId"
    `;
    if (!completed[0]) throw new RiskRowApplicationConflictError("카드 상태가 바뀌어 반영을 완료할 수 없습니다.");
    const [event] = await tx<{ eventId: number | string }[]>`
      insert into board.work_item_events (item_id, type, actor, reason, diff, created_at)
      values (${command.workItemId}, 'approved', ${actor}, null,
        ${JSON.stringify([{ field: "status", from: item.status, to: "done" }, { field: "riskRowApplication", from: null, to: state.targetDocumentId }])}::text::jsonb,
        ${appliedAt}::timestamptz)
      returning event_id as "eventId"
    `;
    if (!event) throw new RiskRowApplicationUnavailableError("카드 승인 이력을 저장하지 못했습니다.");
    const stored: Omit<RiskRowApplicationResult, "replayed"> = {
      commandId: command.commandId, siteId: command.siteId, workItemId: command.workItemId,
      targetDocumentId: state.targetDocumentId, rowIds, factIds, workItemEventId: Number(event.eventId), actor, appliedAt,
    };
    await tx`
      insert into risk_row_application_events
        (command_id, site_id, work_item_id, request_fingerprint, target_document_id, row_ids, fact_ids, work_item_event_id, actor, applied_at, result)
      values (${command.commandId}::uuid, ${command.siteId}::uuid, ${command.workItemId}, ${requested}, ${state.targetDocumentId},
              ${rowIds}::text[], ${factIds}::bigint[], ${stored.workItemEventId}, ${actor}, ${appliedAt}::timestamptz,
              ${JSON.stringify(stored)}::text::jsonb)
    `;
    return { ...stored, replayed: false };
  });
}
