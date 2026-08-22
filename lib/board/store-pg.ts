import { db } from "@/lib/context/db";

import { BoardStoreError } from "./store";
import {
  WORK_ITEM_STATUS_ORDER,
  type BoardPage,
  type BoardQuery,
  type BoardStore,
  type Detection,
  type DetectionNarrative,
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
  type DraftEdit,
  type WorkItemEvent,
  type WorkItemEventType,
  type WorkItemOrigin,
  type WorkItemStatus,
  type WorkItemTiming,
  type WorkItemTrigger,
} from "./types";

// 같은 인터페이스의 Postgres 구현이다. 2026-08-22 에 board 스키마가 실제로 만들어져
// (docs/migration-board.sql) BOARD_STORE=pg 로 도는 경로가 되었다. 그전까지는 테이블이
// 없어서 한 번도 실행되지 않았고, 그 사이에 숨어 있던 jsonb 바인딩 오류를 첫 실행에서
// 밟았다 — 아래 json() 의 주석에 그 내용을 적어 두었다.
// 첫 호출에서 테이블이 없으면 조용히 비어 있는 척하지 않고 무엇이 없는지 말하고 멈춘다.
//
// site_id 는 uuid 다. uuid 형식이 아닌 siteId 로 질의하면 22P02 로 죽는다. 옛 문자열
// 식별자(site_gimpo_gochon_01)가 코드에 남아 있으면 빈 보드가 아니라 오류로 드러난다.
//
// 스키마를 board 로 한정하는 이유는 tbm-check 가 소유한 public.sites 와 이름이 겹치기 때문이다.
// search_path 에 기대면 남의 테이블을 읽는 사고가 난다. 컬럼은 전부 snake_case 이고,
// 화면은 snake_case 를 보지 않는다 — 여기서 카멜로 되돌린다.
//
// due_by 가 timestamptz 가 아니라 text 인 것은 실수가 아니다. 계약 3절대로 기한 셋은
// "2026-08-19 중 발송 (반입 2026-08-24 이전)" 같은 사람 문장으로 들어온다.
// lane_order 가 double precision 인 것도 마찬가지다 — 두 카드 사이 삽입이 중간값이라
// 정수로 반올림하면 자리가 겹친다.

const TABLES = [
  "work_items",
  "snapshot_facts",
  "detection_events",
  "invalidations",
  "work_item_events",
  "briefing_narratives",
] as const;

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
  confirmed_at: Date | string | null;
  due_by: string | null;
  estimated_minutes: number | null;
  assignee: string | null;
  delegable: boolean;
  blocked_by: string[] | null;
  lane_order: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type FactRow = {
  site_id: string;
  fact_type: FactType;
  key: string;
  value: unknown;
  observed_at: Date | string;
  source_doc_id: string | null;
  confidence: number;
};

type DetectionRow = {
  rule_id: RuleId;
  site_id: string;
  detected_at: Date | string;
  confidence: number;
  evidence: Evidence[] | null;
  invalidates: Invalidation[] | null;
  produces: Produces[] | null;
  summary: string;
  narrative: DetectionNarrative | null;
};

/**
 * timestamptz 한 칸을 도메인 문자열로 되돌린다.
 *
 * postgres.js 는 timestamptz 를 JS Date 로 준다. 그런데 도메인 타입(lib/board/types.ts)의
 * 시각은 전부 문자열이고, 그 값은 서버 컴포넌트를 지나 클라이언트 컴포넌트까지 건너간다.
 * Date 를 그대로 흘리면 서버는 HTML 에 toString 결과("Tue Aug 18 2026 …")를 적고 RSC 는
 * 같은 값을 Date 로 직렬화하므로, 두 값이 어긋나 하이드레이션이 통째로 깨진다. 개발 모드
 * 에서는 오류 오버레이가 화면을 덮어 보드를 아예 만질 수 없게 된다.
 *
 * 되돌리는 형식은 nowIso() 가 넣을 때 쓰는 것과 같다(KST 벽시계 + '+09:00'). 읽은 값과
 * 쓴 값이 같은 모양이어야 화면 계약과 문자열 비교가 함께 성립한다.
 */
function 시각(value: Date | string): string {
  if (typeof value === "string") return value;
  const kst = new Date(value.getTime() + 9 * 60 * 60 * 1000).toISOString();
  return `${kst.slice(0, 19)}+09:00`;
}

function 시각또는없음(value: Date | string | null): string | null {
  return value === null || value === undefined ? null : 시각(value);
}

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
    confirmedAt: 시각또는없음(row.confirmed_at),
    dueBy: row.due_by,
    estimatedMinutes: row.estimated_minutes,
    assignee: row.assignee,
    delegable: row.delegable,
    blockedBy: row.blocked_by ?? [],
    laneOrder: Number(row.lane_order),
    createdAt: 시각(row.created_at),
    updatedAt: 시각(row.updated_at),
  };
}

function toFact(row: FactRow): SnapshotFact {
  return {
    siteId: row.site_id,
    factType: row.fact_type,
    key: row.key,
    value: row.value,
    observedAt: 시각(row.observed_at),
    sourceDocId: row.source_doc_id,
    confidence: Number(row.confidence),
  };
}

function toDetection(row: DetectionRow): Detection {
  return {
    ruleId: row.rule_id,
    siteId: row.site_id,
    detectedAt: 시각(row.detected_at),
    confidence: Number(row.confidence),
    evidence: row.evidence ?? [],
    invalidates: row.invalidates ?? [],
    produces: row.produces ?? [],
    summary: row.summary,
    narrative: row.narrative,
  };
}

/**
 * jsonb 컬럼에 넣을 값을 문자열로 만든다.
 *
 * 이 함수의 결과에는 반드시 `::text::jsonb` 를 붙인다. `::jsonb` 만 붙이면 안 된다.
 * postgres.js 는 `${문자열}::jsonb` 를 만나면 그 매개변수를 jsonb 타입으로 보내면서 값을
 * 한 번 더 JSON 으로 감싼다. 그래서 '[]' 를 넣으면 배열이 아니라 문자열 스칼라 '"[]"' 가
 * 들어가고, board.work_items 의 jsonb_typeof 체크가 23514 로 그 행을 거절한다.
 * 중간에 `::text` 를 끼우면 매개변수가 text 로 나가고 서버가 그 문자열을 jsonb 로 파싱한다.
 *
 *   select ${'[]'}::jsonb       → jsonb_typeof = 'string'   ← 틀림
 *   select ${'[]'}::text::jsonb → jsonb_typeof = 'array'    ← 맞음
 *
 * 이 파일이 라이브 DB 를 처음 만난 2026-08-22 에 실제로 밟은 오류다. 그전까지는 테이블이
 * 없어서 한 번도 실행되지 않았기 때문에 드러나지 않았다. 체크 제약이 없는 컬럼
 * (snapshot_facts.value · work_item_events.diff)은 오류 없이 잘못된 모양으로 들어가므로
 * 더 나쁘다 — 나중에 값을 읽을 때에야 문자열이 나온다.
 */
function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// board.*.site_id 는 uuid 다. uuid 가 아닌 문자열을 그대로 바인딩하면 Postgres 가
// 22P02 'invalid input syntax for type uuid' 를 던지고, 라우트는 그것을 BoardStoreError 로
// 알아보지 못해 500 을 돌려준다. /api/board/* 의 ?siteId= 는 사용자가 아무 문자열이나 넣을
// 수 있는 자리이므로 여기서 먼저 걸러 400 으로 내린다. 옛 문자열 식별자
// (site_gimpo_gochon_01)가 코드 어딘가에 남아 있을 때 "서버가 터졌다" 가 아니라
// "형식이 틀렸다" 로 읽히게 하는 것이 이 함수의 목적이다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSiteId(siteId: string): void {
  if (!siteId) fail("invalid", "siteId 가 필요합니다.");
  if (!UUID.test(siteId)) {
    fail("invalid", `siteId 는 uuid 형식이어야 합니다. '${siteId}' 는 현장 uuid 가 아닙니다.`);
  }
}

function nowIso(): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  return `${now.slice(0, 19)}+09:00`;
}

export function createPgBoardStore(): BoardStore {
  let checked = false;

  /**
   * 카드 이력 한 줄을 남긴다.
   *
   * 계약이 "승인 시 고친 값과 기각 사유는 이력으로 쌓인다" 고 못 박은 값이 들어가는 자리다.
   * 이 함수가 없던 동안 기각 사유는 console.warn 으로 흘렀고, 그러면 카드에 적힌
   * "숫자를 고쳐 승인하면 그 차이가 이력으로 남습니다" 가 거짓말이 된다.
   *
   * JSON 구현이 data/board/events.json 에 쌓는 것과 같은 모양이라 BOARD_STORE 를 바꿔
   * 끼워도 남는 기록이 달라지지 않는다. event_id 는 테이블이 identity 로 매기므로
   * 여기서 만들지 않는다 — JSON 구현만 문자열 id 를 직접 짓는다.
   */
  async function appendEvent(
    itemId: string,
    type: WorkItemEventType,
    actor: string,
    reason: string | null,
    diff: WorkItemEvent["diff"],
  ): Promise<void> {
    const sql = db();
    await sql`
      insert into board.work_item_events (item_id, type, actor, reason, diff, created_at)
      values (${itemId}, ${type}, ${actor}, ${reason}, ${json(diff)}::text::jsonb, ${nowIso()})
    `;
  }

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
          `docs/migration-board.sql 을 적용하거나 BOARD_STORE 를 비워 JSON 저장소로 돌리세요.`,
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
      const rows = await sql<Array<WorkItemRow & { inserted: boolean }>>`
        insert into board.work_items (
          item_id, site_id, timing, status, origin, title, summary, trigger,
          invalidates, produces, draft, confirmed_by, confirmed_at, due_by,
          estimated_minutes, assignee, delegable, blocked_by, lane_order, created_at, updated_at
        ) values (
          ${item.itemId}, ${item.siteId}, ${item.timing}, ${item.status}, ${item.origin},
          ${item.title}, ${item.summary}, ${json(item.trigger)}::text::jsonb,
          ${json(item.invalidates)}::text::jsonb, ${json(item.produces)}::text::jsonb, ${json(item.draft)}::text::jsonb,
          ${item.confirmedBy}, ${item.confirmedAt}, ${item.dueBy},
          ${item.estimatedMinutes}, ${item.assignee}, ${item.delegable},
          ${json(item.blockedBy)}::text::jsonb, ${item.laneOrder}, ${item.createdAt}, ${item.updatedAt}
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
        returning *, (xmax = 0) as inserted
      `;
      const row: (WorkItemRow & { inserted: boolean }) | undefined = rows[0];
      if (row) {
        saved.push(toItem(row));
        // xmax = 0 이면 이번에 새로 꽂힌 행이다. 같은 조건으로 두 번 감지해도 created 가
        // 두 번 쌓이지 않게 하는 자리이고, 이력의 첫 줄이 곧 카드가 태어난 시각이 된다.
        if (row.inserted) {
          await appendEvent(item.itemId, "created", item.origin === "machine" ? "system" : "user", null, []);
        }
      }

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
      assertSiteId(query.siteId);
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

      // 무엇이 달라졌는지를 갱신 전에 모은다. 갱신 뒤에 되짚으면 이전 값이 이미 사라진다.
      // 필드 목록과 판정 순서는 JSON 구현과 같아야 두 저장소의 이력이 같은 모양이 된다.
      const diff: WorkItemEvent["diff"] = [];
      if (current.status !== patch.status) {
        diff.push({ field: "status", from: current.status, to: patch.status });
      }
      if (humanTakeover && current.origin !== "human") {
        diff.push({ field: "origin", from: current.origin, to: "human" });
      }
      if (confirming && patch.confirmedBy) {
        diff.push({ field: "confirmedBy", from: current.confirmed_by, to: patch.confirmedBy });
      }
      if (patch.laneOrder !== undefined && patch.laneOrder !== current.lane_order) {
        diff.push({ field: "laneOrder", from: current.lane_order, to: patch.laneOrder });
      }
      if (patch.assignee !== undefined && patch.assignee !== current.assignee) {
        diff.push({ field: "assignee", from: current.assignee, to: patch.assignee });
      }

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

      await appendEvent(
        itemId,
        confirming ? "approved" : "moved",
        patch.confirmedBy ?? "user",
        null,
        diff,
      );
      return toItem(row);
    },

    async rejectItem(itemId: string, reason: string, actor: string): Promise<WorkItem> {
      if (!reason || !reason.trim()) fail("invalid", "기각 사유가 필요합니다.");
      await ensureSchema();
      const sql = db();

      // 이력의 diff 는 이전 값이 있어야 성립하므로 갱신 전에 한 번 읽는다.
      const before = await sql<WorkItemRow[]>`
        select status, origin from board.work_items where item_id = ${itemId} limit 1
      `;
      const current: WorkItemRow | undefined = before[0];
      if (!current) fail("notFound", "그런 카드가 없습니다.");

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

      // 기각 사유는 잘못된 감지를 학습에 반영하는 재료이면서, 담당자가 판단을 내렸다는
      // 기록 자체가 나중에 방어 근거가 된다. 스키마에도 사유 없는 기각을 막는 제약이 걸려 있다.
      await appendEvent(itemId, "rejected", actor, reason.trim(), [
        { field: "status", from: current.status, to: "todo" },
        { field: "origin", from: current.origin, to: "human" },
      ]);
      return toItem(row);
    },

    async listFacts(siteId: string, factType?: FactType): Promise<SnapshotFact[]> {
      assertSiteId(siteId);
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
              ${fact.siteId}, ${fact.factType}, ${fact.key}, ${json(fact.value)}::text::jsonb,
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
      assertSiteId(siteId);
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
            evidence, invalidates, produces, summary, narrative, created_item_ids
          ) values (
            ${run.runId}, ${detection.siteId}, ${run.startedAt}, ${detection.ruleId}, ${detection.detectedAt},
            ${detection.confidence}, ${json(detection.evidence)}::text::jsonb, ${json(detection.invalidates)}::text::jsonb,
            ${json(detection.produces)}::text::jsonb, ${detection.summary},
            ${detection.narrative ? json(detection.narrative) : null}::text::jsonb,
            ${json(run.created.map((item: WorkItem) => item.itemId))}::text::jsonb
          )
          on conflict (run_id, rule_id, detected_at) do update set
            confidence       = excluded.confidence,
            evidence         = excluded.evidence,
            invalidates      = excluded.invalidates,
            produces         = excluded.produces,
            summary          = excluded.summary,
            -- 이미 써 둔 서사를 null 로 덮지 않는다. 재실행에서 문장 생성만 실패하면
            -- excluded.narrative 가 null 로 오는데, 그것으로 덮으면 지난번에 성공한 문장이
            -- 사라지고 브리핑이 그 조건만 템플릿으로 되돌아간다. 새로 쓴 것이 있을 때만 바꾼다.
            narrative        = coalesce(excluded.narrative, board.detection_events.narrative),
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

    /**
     * 초안 대비 수정분을 이력으로 남긴다.
     *
     * DraftEdit 와 WorkItemEvent.diff 는 이름만 다르고 모양이 일대일로 대응하므로
     * 옮겨 담는 일이 전부다. 확정 이력('approved')과 따로 한 줄을 두는 이유는 무엇을
     * 고쳤는지와 누가 확정했는지가 서로 다른 물음이기 때문이다.
     */
    async recordDraftEdits(itemId: string, actor: string, edits: DraftEdit[]): Promise<void> {
      if (edits.length === 0) return;
      await ensureSchema();
      await appendEvent(
        itemId,
        "edited",
        actor,
        null,
        edits.map((edit) => ({ field: edit.path, from: edit.before, to: edit.after })),
      );
    },

    async listDetections(siteId: string, since?: string): Promise<Detection[]> {
      assertSiteId(siteId);
      await ensureSchema();
      const sql = db();
      const rows = await sql<DetectionRow[]>`
        select rule_id, site_id, detected_at, confidence, evidence, invalidates, produces, summary, narrative
          from board.detection_events
         where site_id = ${siteId}
           ${since ? sql`and detected_at >= ${since}` : sql``}
         order by detected_at desc
      `;
      return rows.map((row: DetectionRow) => toDetection(row));
    },

    /**
     * 브리핑 문단 캐시를 읽는다.
     *
     * 없으면 null 이고, 그때 호출한 쪽이 모델을 부른다. 캐시가 비어 있는 것은 오류가
     * 아니라 "아직 이 창을 본 적이 없다" 는 뜻이므로 여기서 예외를 던지지 않는다.
     */
    async readBriefingNarrative(cacheKey: string): Promise<string[] | null> {
      await ensureSchema();
      const sql = db();
      const rows = await sql<Array<{ paragraphs: string[] }>>`
        select paragraphs from board.briefing_narratives where cache_key = ${cacheKey}
      `;
      const found = rows[0]?.paragraphs;
      return Array.isArray(found) && found.length > 0 ? found : null;
    },

    async writeBriefingNarrative(
      cacheKey: string,
      siteId: string,
      paragraphs: string[],
    ): Promise<void> {
      if (paragraphs.length === 0) return;
      assertSiteId(siteId);
      await ensureSchema();
      const sql = db();
      // 같은 열쇠에 두 요청이 동시에 닿으면 나중 것이 이긴다. 열쇠가 같으면 내용도
      // 같아야 하므로 어느 쪽이 이겨도 결과가 달라지지 않는다.
      await sql`
        insert into board.briefing_narratives (cache_key, site_id, paragraphs)
        values (${cacheKey}, ${siteId}, ${json(paragraphs)}::text::jsonb)
        on conflict (cache_key) do update set
          paragraphs   = excluded.paragraphs,
          generated_at = now()
      `;
    },
  };
}
