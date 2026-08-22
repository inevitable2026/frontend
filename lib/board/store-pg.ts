import { db } from "@/lib/context/db";

import { BoardStoreError } from "./store";
import {
  WORK_ITEM_STATUS_ORDER,
  type BoardPage,
  type BoardQuery,
  type BoardStore,
  type Detection,
  type DetectionRun,
  type Draft,
  type Evidence,
  type FactDelta,
  type FactType,
  type Invalidation,
  type ItemPatch,
  type Produces,
  type RuleId,
  type SnapshotFact,
  type WorkItem,
  type WorkItemOrigin,
  type WorkItemStatus,
  type WorkItemTiming,
  type WorkItemTrigger,
} from "./types";

// 같은 인터페이스의 Postgres 구현이다. **아직 테이블이 없으므로 이 파일은 실행되지 않는다.**
// 스키마가 합의되는 날 BOARD_STORE=pg 한 줄로 바꿔 끼우려고 질의를 미리 정확히 써 둔 것이고,
// 첫 호출에서 테이블이 없으면 조용히 비어 있는 척하지 않고 무엇이 없는지 말하고 멈춘다.
//
// 스키마를 board 로 한정하는 이유는 tbm-check 가 소유한 public.sites 와 이름이 겹치기 때문이다.
// search_path 에 기대면 남의 테이블을 읽는 사고가 난다. 컬럼은 전부 snake_case 이고,
// 화면은 snake_case 를 보지 않는다 — 여기서 카멜로 되돌린다.
//
// due_by 가 timestamptz 가 아니라 text 인 것은 실수가 아니다. 계약 3절대로 기한 셋은
// "2026-08-19 중 발송 (반입 2026-08-24 이전)" 같은 사람 문장으로 들어온다.
// lane_order 가 double precision 인 것도 마찬가지다 — 두 카드 사이 삽입이 중간값이라
// 정수로 반올림하면 자리가 겹친다.

const TABLES = ["work_items", "snapshot_facts", "detection_events", "invalidations"] as const;

type WorkItemRow = {
  item_id: string;
  site_id: string;
  timing: WorkItemTiming;
  status: WorkItemStatus;
  origin: WorkItemOrigin;
  title: string;
  summary: string | null;
  trigger: WorkItemTrigger | null;
  invalidates: Invalidation[] | null;
  produces: Produces[] | null;
  draft: Draft | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  due_by: string | null;
  estimated_minutes: number | null;
  assignee: string | null;
  delegable: boolean;
  blocked_by: string[] | null;
  lane_order: number;
  created_at: string;
  updated_at: string;
};

type FactRow = {
  site_id: string;
  fact_type: FactType;
  key: string;
  value: unknown;
  observed_at: string;
  source_doc_id: string | null;
  confidence: number;
};

type DetectionRow = {
  rule_id: RuleId;
  site_id: string;
  detected_at: string;
  confidence: number;
  evidence: Evidence[] | null;
  invalidates: Invalidation[] | null;
  produces: Produces[] | null;
  summary: string;
};

function fail(code: "invalid" | "notFound" | "conflict" | "unavailable", message: string): never {
  throw new BoardStoreError(code, message);
}

function toItem(row: WorkItemRow): WorkItem {
  return {
    itemId: row.item_id,
    siteId: row.site_id,
    timing: row.timing,
    status: row.status,
    origin: row.origin,
    title: row.title,
    summary: row.summary,
    trigger: row.trigger,
    invalidates: row.invalidates ?? [],
    produces: row.produces ?? [],
    draft: row.draft,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    dueBy: row.due_by,
    estimatedMinutes: row.estimated_minutes,
    assignee: row.assignee,
    delegable: row.delegable,
    blockedBy: row.blocked_by ?? [],
    laneOrder: Number(row.lane_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFact(row: FactRow): SnapshotFact {
  return {
    siteId: row.site_id,
    factType: row.fact_type,
    key: row.key,
    value: row.value,
    observedAt: row.observed_at,
    sourceDocId: row.source_doc_id,
    confidence: Number(row.confidence),
  };
}

function toDetection(row: DetectionRow): Detection {
  return {
    ruleId: row.rule_id,
    siteId: row.site_id,
    detectedAt: row.detected_at,
    confidence: Number(row.confidence),
    evidence: row.evidence ?? [],
    invalidates: row.invalidates ?? [],
    produces: row.produces ?? [],
    summary: row.summary,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function nowIso(): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return `${now.slice(0, 19)}+09:00`;
}

export function createPgBoardStore(): BoardStore {
  let checked = false;

  /**
   * 첫 호출에서 네 테이블이 실제로 있는지 본다. 없으면 빈 배열을 돌려주는 대신 무엇이
   * 없는지 이름을 대고 멈춘다 — "카드가 하나도 없네" 로 보이는 실패가 제일 오래 걸린다.
   */
  async function ensureSchema(): Promise<void> {
    if (checked) return;
    const sql = db();
    const rows = await sql<Array<{ present: string[] }>>`
      select coalesce(array_agg(t.name order by t.name), '{}') as present
        from unnest(${TABLES as unknown as string[]}::text[]) as t(name)
       where to_regclass('board.' || t.name) is not null
    `;
    const present: string[] = rows[0]?.present ?? [];
    const missing = TABLES.filter((name: string) => !present.includes(name));
    if (missing.length > 0) {
      fail(
        "unavailable",
        `board 스키마에 ${missing.join(" · ")} 테이블이 없습니다. ` +
          `db/board/001_init.sql 을 적용하거나 BOARD_STORE 를 비워 JSON 저장소로 돌리세요.`,
      );
    }
    checked = true;
  }

  /**
   * 같은 조건으로 두 번 감지해도 카드가 두 장 생기지 않는 자리다. item_id 충돌 시
   * 사람이 만진 필드(status · origin · confirmed_* · assignee · lane_order)는 그대로 두고
   * 기계가 다시 계산하는 필드만 덮는다.
   */
  async function upsertItems(items: WorkItem[]): Promise<WorkItem[]> {
    if (items.length === 0) return [];
    await ensureSchema();
    const sql = db();
    const saved: WorkItem[] = [];

    for (const item of items) {
      if (!item.itemId) fail("invalid", "itemId 가 없는 카드는 저장할 수 없습니다.");
      const rows = await sql<WorkItemRow[]>`
        insert into board.work_items (
          item_id, site_id, timing, status, origin, title, summary, trigger,
          invalidates, produces, draft, confirmed_by, confirmed_at, due_by,
          estimated_minutes, assignee, delegable, blocked_by, lane_order, created_at, updated_at
        ) values (
          ${item.itemId}, ${item.siteId}, ${item.timing}, ${item.status}, ${item.origin},
          ${item.title}, ${item.summary}, ${json(item.trigger)}::jsonb,
          ${json(item.invalidates)}::jsonb, ${json(item.produces)}::jsonb, ${json(item.draft)}::jsonb,
          ${item.confirmedBy}, ${item.confirmedAt}, ${item.dueBy},
          ${item.estimatedMinutes}, ${item.assignee}, ${item.delegable},
          ${json(item.blockedBy)}::jsonb, ${item.laneOrder}, ${item.createdAt}, ${item.updatedAt}
        )
        on conflict (item_id) do update set
          timing            = excluded.timing,
          title             = excluded.title,
          summary           = excluded.summary,
          trigger           = excluded.trigger,
          invalidates       = excluded.invalidates,
          produces          = excluded.produces,
          draft             = excluded.draft,
          due_by            = excluded.due_by,
          estimated_minutes = excluded.estimated_minutes,
          delegable         = excluded.delegable,
          blocked_by        = excluded.blocked_by,
          assignee          = coalesce(board.work_items.assignee, excluded.assignee),
          updated_at        = ${nowIso()}
        returning *
      `;
      const row: WorkItemRow | undefined = rows[0];
      if (row) saved.push(toItem(row));

      // 무효화는 카드 안에도 jsonb 로 남지만, "어느 문서가 무엇 때문에 유효하지 않은가" 를
      // 문서 쪽에서 되짚으려면 별도 색인이 필요하다. 그 자리가 invalidations 다.
      for (const invalidation of item.invalidates) {
        await sql`
          insert into board.invalidations (item_id, run_id, doc_id, scope, reason, created_at)
          values (${item.itemId}, null, ${invalidation.docId}, ${invalidation.scope}, ${invalidation.reason}, ${nowIso()})
          on conflict (item_id, doc_id, scope) do update set reason = excluded.reason
        `;
      }
    }

    return saved;
  }

  return {
    upsertItems,

    async listItems(query: BoardQuery): Promise<BoardPage> {
      if (!query.siteId) fail("invalid", "siteId 가 필요합니다.");
      await ensureSchema();
      const sql = db();

      // 날짜 판정은 JSON 구현과 같은 규칙이다 — 기한이 그날이거나, 그날 만들어졌거나,
      // 그날 움직인 카드가 그날의 보드에 걸린다. due_by 가 text 라 앞 열 글자를 자르고,
      // ISO 가 아닌 문장은 처음 나오는 날짜를 정규식으로 뽑는다.
      const date = query.date ?? null;
      const rows = await sql<WorkItemRow[]>`
        select *
          from board.work_items
         where site_id = ${query.siteId}
           ${query.status ? sql`and status = ${query.status}` : sql``}
           ${
             date
               ? sql`and (
                   substring(due_by from '\\d{4}-\\d{2}-\\d{2}') = ${date}
                   or to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') = ${date}
                   or to_char(updated_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') = ${date}
                   or to_char(confirmed_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') = ${date}
                 )`
               : sql``
           }
           ${
             query.from
               ? sql`and coalesce(
                   substring(due_by from '\\d{4}-\\d{2}-\\d{2}'),
                   to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                 ) >= ${query.from}`
               : sql``
           }
           ${
             query.to
               ? sql`and coalesce(
                   substring(due_by from '\\d{4}-\\d{2}-\\d{2}'),
                   to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                 ) <= ${query.to}`
               : sql``
           }
         order by array_position(${WORK_ITEM_STATUS_ORDER as string[]}::text[], status), lane_order, created_at
         ${query.limit && query.limit > 0 ? sql`limit ${query.limit}` : sql``}
      `;

      const items: WorkItem[] = rows.map((row: WorkItemRow) => toItem(row));
      return { total: items.length, siteId: query.siteId, date, items };
    },

    async getItem(itemId: string): Promise<WorkItem | null> {
      await ensureSchema();
      const sql = db();
      const rows = await sql<WorkItemRow[]>`
        select * from board.work_items where item_id = ${itemId} limit 1
      `;
      const row: WorkItemRow | undefined = rows[0];
      return row ? toItem(row) : null;
    },

    async moveItem(itemId: string, patch: ItemPatch): Promise<WorkItem> {
      if (!WORK_ITEM_STATUS_ORDER.includes(patch.status)) {
        fail("invalid", "status 는 todo · approval · done 중 하나여야 합니다.");
      }
      await ensureSchema();
      const sql = db();

      const before = await sql<WorkItemRow[]>`
        select * from board.work_items where item_id = ${itemId} limit 1
      `;
      const current: WorkItemRow | undefined = before[0];
      if (!current) fail("notFound", "그런 카드가 없습니다.");
      if (patch.status === "done" && current.status === "done" && current.confirmed_at !== null) {
        fail("conflict", "이미 확정된 카드입니다.");
      }
      if (patch.assignee !== undefined && patch.assignee !== current.assignee && !current.delegable) {
        fail("invalid", "이 카드는 담당자를 넘길 수 없습니다.");
      }

      const confirming = patch.status === "done" && Boolean(patch.confirmedBy);
      // 승인 → 할 일은 "사람이 직접 다시 쓴다"는 뜻이라 origin 이 human 이 되고 초안은 남는다.
      const humanTakeover = current.status === "approval" && patch.status === "todo";

      const rows = await sql<WorkItemRow[]>`
        update board.work_items set
          status       = ${patch.status},
          origin       = ${humanTakeover ? "human" : current.origin},
          confirmed_by = ${confirming ? (patch.confirmedBy ?? null) : current.confirmed_by},
          confirmed_at = ${confirming ? nowIso() : current.confirmed_at},
          lane_order   = ${patch.laneOrder ?? current.lane_order},
          assignee     = ${patch.assignee === undefined ? current.assignee : patch.assignee},
          updated_at   = ${nowIso()}
        where item_id = ${itemId}
        returning *
      `;
      const row: WorkItemRow | undefined = rows[0];
      if (!row) fail("notFound", "그런 카드가 없습니다.");
      return toItem(row);
    },

    async rejectItem(itemId: string, reason: string, actor: string): Promise<WorkItem> {
      if (!reason || !reason.trim()) fail("invalid", "기각 사유가 필요합니다.");
      await ensureSchema();
      const sql = db();

      const rows = await sql<WorkItemRow[]>`
        update board.work_items set
          status       = 'todo',
          origin       = 'human',
          confirmed_by = null,
          confirmed_at = null,
          updated_at   = ${nowIso()}
        where item_id = ${itemId}
        returning *
      `;
      const row: WorkItemRow | undefined = rows[0];
      if (!row) fail("notFound", "그런 카드가 없습니다.");

      // 기각 사유는 계약 2.2 가 "이력으로 쌓인다" 고 못 박은 값인데, 합의된 네 테이블에는
      // 카드 이력을 담을 자리가 없다. board.work_item_events 가 생기기 전까지는 로그로만 남는다.
      console.warn(`[board] 기각 사유를 저장할 테이블이 없습니다: ${itemId} · ${actor} · ${reason.trim()}`);
      return toItem(row);
    },

    async listFacts(siteId: string, factType?: FactType): Promise<SnapshotFact[]> {
      await ensureSchema();
      const sql = db();
      // 최신 값만이 아니라 이력 전부를 관측 시각 오름차순으로 돌려준다. 같은 key 의 앞뒤 값이
      // 곧 델타이므로, 여기서 최신만 남기면 감지가 "무엇이 무엇으로 바뀌었나" 를 볼 수 없다.
      const rows = await sql<FactRow[]>`
        select site_id, fact_type, key, value, observed_at, source_doc_id, confidence
          from board.snapshot_facts
         where site_id = ${siteId}
           ${factType ? sql`and fact_type = ${factType}` : sql``}
         order by observed_at, fact_type, key
      `;
      return rows.map((row: FactRow) => toFact(row));
    },

    async appendFacts(facts: SnapshotFact[]): Promise<FactDelta[]> {
      if (facts.length === 0) return [];
      await ensureSchema();
      const sql = db();
      const deltas: FactDelta[] = [];

      for (const fact of facts) {
        const rows = await sql<Array<{ before: unknown; after: unknown }>>`
          with prev as (
            select value
              from board.snapshot_facts
             where site_id = ${fact.siteId}
               and fact_type = ${fact.factType}
               and key = ${fact.key}
               and observed_at <= ${fact.observedAt}
             order by observed_at desc
             limit 1
          ), ins as (
            insert into board.snapshot_facts (site_id, fact_type, key, value, observed_at, source_doc_id, confidence)
            values (
              ${fact.siteId}, ${fact.factType}, ${fact.key}, ${json(fact.value)}::jsonb,
              ${fact.observedAt}, ${fact.sourceDocId}, ${fact.confidence}
            )
            on conflict (site_id, fact_type, key, observed_at) do update set
              value = excluded.value, source_doc_id = excluded.source_doc_id, confidence = excluded.confidence
            returning value
          )
          select (select value from prev) as before, (select value from ins) as after
        `;
        const row: { before: unknown; after: unknown } | undefined = rows[0];
        if (!row) continue;
        if (JSON.stringify(row.before ?? null) === JSON.stringify(row.after ?? null)) continue;
        deltas.push({
          factType: fact.factType,
          key: fact.key,
          before: row.before ?? null,
          after: row.after,
          observedAt: fact.observedAt,
          sourceDocId: fact.sourceDocId,
        });
      }

      return deltas;
    },

    async latestSnapshotAt(siteId: string): Promise<string | null> {
      await ensureSchema();
      const sql = db();
      const rows = await sql<Array<{ latest: string | null }>>`
        select max(observed_at)::text as latest from board.snapshot_facts where site_id = ${siteId}
      `;
      return rows[0]?.latest ?? null;
    },

    async appendDetections(run: DetectionRun): Promise<void> {
      await ensureSchema();
      const sql = db();

      for (const detection of run.detections) {
        await sql`
          insert into board.detection_events (
            run_id, site_id, started_at, rule_id, detected_at, confidence,
            evidence, invalidates, produces, summary, created_item_ids
          ) values (
            ${run.runId}, ${detection.siteId}, ${run.startedAt}, ${detection.ruleId}, ${detection.detectedAt},
            ${detection.confidence}, ${json(detection.evidence)}::jsonb, ${json(detection.invalidates)}::jsonb,
            ${json(detection.produces)}::jsonb, ${detection.summary},
            ${json(run.created.map((item: WorkItem) => item.itemId))}::jsonb
          )
          on conflict (run_id, rule_id, detected_at) do update set
            confidence       = excluded.confidence,
            evidence         = excluded.evidence,
            invalidates      = excluded.invalidates,
            produces         = excluded.produces,
            summary          = excluded.summary,
            created_item_ids = excluded.created_item_ids
        `;

        for (const invalidation of detection.invalidates) {
          await sql`
            insert into board.invalidations (item_id, run_id, doc_id, scope, reason, created_at)
            values (null, ${run.runId}, ${invalidation.docId}, ${invalidation.scope}, ${invalidation.reason}, ${run.startedAt})
            on conflict do nothing
          `;
        }
      }

      if (run.created.length > 0) await upsertItems(run.created);
    },

    async listDetections(siteId: string, since?: string): Promise<Detection[]> {
      await ensureSchema();
      const sql = db();
      const rows = await sql<DetectionRow[]>`
        select rule_id, site_id, detected_at, confidence, evidence, invalidates, produces, summary
          from board.detection_events
         where site_id = ${siteId}
           ${since ? sql`and detected_at >= ${since}` : sql``}
         order by detected_at desc
      `;
      return rows.map((row: DetectionRow) => toDetection(row));
    },
  };
}
