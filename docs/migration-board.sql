-- ============================================================================
-- 태스크 보드 스키마 — 초안 (2026-08-22)
--
--   이 파일은 `inevitable2026/tbm-check` 레포에 넘기는 초안이다.
--   ▸ 스키마의 소유자는 tbm-check 다. 마이그레이션도 그쪽에 있다.
--   ▸ 이 레포(frontend)는 이 파일을 실행하지 않는다. 실행할 수단도 없다 —
--     ORM 도 마이그레이션 도구도 없고, `postgres` 는 package.json 에만 있고
--     node_modules 에는 설치되어 있지 않다.
--   ▸ 여기서 `psql -f` 로 치는 순간 두 레포의 스키마 인식이 갈린다. HANDOFF.md 가
--     같은 이유로 `ALTER TABLE` 을 금지한다. 이 파일도 같은 규칙 아래 있다.
--
--   받는 쪽에서 할 일: 아래 [0] 확인 블록을 먼저 돌려 실제 컬럼 타입을 보고,
--   [5] 외래 키 블록을 그 값에 맞춘 뒤 전체를 트랜잭션으로 적용한다.
--
--   대응 관계 — 컬럼 이름과 제약은 `lib/board/store-pg.ts` 의 질의문에서 그대로 왔다.
--     board.work_items       ← WorkItem       · upsertItems · listItems · moveItem · rejectItem
--     board.snapshot_facts   ← SnapshotFact   · appendFacts · listFacts · latestSnapshotAt
--     board.detection_events ← Detection      · appendDetections · listDetections
--     board.invalidations    ← Invalidation   · upsertItems · appendDetections
--
--   `createPgBoardStore()` 의 `ensureSchema()` 가 첫 호출에서 이 네 이름을
--   `to_regclass('board.' || name)` 으로 확인하고, 없으면 무엇이 없는지 말하고 멈춘다.
--   스키마 이름(`board`)과 테이블 이름 넷은 그 함수와 글자까지 같아야 한다.
--
--   기존 테이블(public.sites · public.documents · public.document_chunks)은
--   읽기만 하고 참조만 건다. **이 파일에 기존 테이블을 고치는 문장은 없다.**
--   [5] 의 ALTER 는 전부 board.* 즉 이 파일이 방금 만든 테이블만 대상으로 한다.
--
--   임베딩 컬럼(public.document_chunks.embedding)에는 손대지 않는다.
--   4096 차원이라 pgvector 0.8 의 hnsw 상한(vector 2000 · halfvec 4000)을 넘는다.
--   이미 확인된 사실이고, 여기서 인덱스를 붙이려는 시도는 실패한다.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- [0] 붙기 전 확인 — 기존 테이블의 실제 타입을 눈으로 본다
--
-- frontend 레포에서는 이 값을 확인할 수 없었다. node_modules 에 `postgres` 가 없고
-- psql 도 깔려 있지 않아 라이브 DB 를 들여다볼 수단이 없었다.
-- public.sites.id · public.documents.id 의 타입은 코드의 질의문에서 역으로 읽어 낸
-- 것이라 **uuid 인지 text 인지 확정하지 못했다.** 아래 블록이 그 값을 찍는다.
-- ----------------------------------------------------------------------------
do $$
declare
  v_sites_id_type     text;
  v_documents_id_type text;
begin
  if to_regclass('public.sites') is null then
    raise exception '[board] public.sites 가 없습니다. 이 마이그레이션의 전제가 깨졌습니다.';
  end if;

  select format_type(a.atttypid, a.atttypmod) into v_sites_id_type
    from pg_attribute a
   where a.attrelid = to_regclass('public.sites') and a.attname = 'id' and a.attnum > 0;

  select format_type(a.atttypid, a.atttypmod) into v_documents_id_type
    from pg_attribute a
   where a.attrelid = to_regclass('public.documents') and a.attname = 'id' and a.attnum > 0;

  raise notice '[board] public.sites.id     = %', coalesce(v_sites_id_type, '(없음)');
  raise notice '[board] public.documents.id = %', coalesce(v_documents_id_type, '(없음)');

  if v_sites_id_type is null then
    raise exception '[board] public.sites 에 id 컬럼이 없습니다. 이 마이그레이션의 전제가 깨졌습니다.';
  end if;

  if v_sites_id_type <> 'text' then
    raise notice '[board] ▶ board.*.site_id 를 % 로 바꾸고 [5] 를 다시 보십시오.', v_sites_id_type;
  end if;
  if v_documents_id_type is not null and v_documents_id_type <> 'text' then
    raise notice '[board] ▶ board.snapshot_facts.source_doc_id 를 % 로 바꾸십시오.', v_documents_id_type;
  end if;
end
$$;

create schema if not exists board;

comment on schema board is
  '태스크 보드. frontend 레포의 lib/board/types.ts 가 단일 진실이다. public 스키마는 읽기만 한다.';

-- 질의는 반드시 board. 로 스키마를 한정한다. public 에 같은 이름이 있을 수 있어
-- search_path 에 기대면 남의 테이블을 읽는다. store-pg.ts 의 질의가 전부 그 형태다.

-- ----------------------------------------------------------------------------
-- [1] board.work_items — 칸반 카드 한 장
--
-- WorkItem 의 필드 하나하나에 대응한다. 세 열(todo · approval · done)이 서로 다른
-- 테이블이 아니라 하나의 스키마를 공유한다 — status 는 진행 단계가 아니라
-- "지금 이 카드를 움직일 수 있는 주체"이기 때문이다.
--
-- 열거형에 enum 타입 대신 text + check 를 쓴다. 유니온의 원본이 TS 배열
-- (WORK_ITEM_TIMINGS · FACT_TYPES …)이라 값이 늘 때 저쪽은 배열 한 줄만 고치는데,
-- Postgres enum 은 ALTER TYPE ADD VALUE 가 필요하고 그 값을 같은 트랜잭션 안에서
-- 쓰지 못한다는 제약을 달고 온다.
-- ----------------------------------------------------------------------------
create table if not exists board.work_items (
  item_id            text primary key,
  site_id            text        not null,

  timing             text        not null check (timing in ('daily', 'schedule', 'trigger')),
  status             text        not null default 'todo'
                                 check (status in ('todo', 'approval', 'done')),
  origin             text        not null default 'machine'
                                 check (origin in ('machine', 'human')),

  title              text        not null check (length(btrim(title)) > 0),
  summary            text,

  -- ▼ 네 개의 jsonb 는 전부 store-pg.ts 가 `JSON.stringify(v ?? null)::jsonb` 로 넣는다.
  -- 값이 null 이면 SQL NULL 이 아니라 **jsonb 의 null 리터럴**이 들어온다는 뜻이다.
  -- 그래서 아래 check 가 'null' 을 함께 허용한다. 'object' 만 허용하면
  -- timing='daily' 카드(trigger 가 없는 카드)의 insert 가 전부 실패한다. 실제로 밟았다.
  trigger            jsonb       check (trigger is null or jsonb_typeof(trigger) in ('object', 'null')),

  invalidates        jsonb       not null default '[]'::jsonb
                                 check (jsonb_typeof(invalidates) in ('array', 'null')),
  produces           jsonb       not null default '[]'::jsonb
                                 check (jsonb_typeof(produces) in ('array', 'null')),

  -- Draft | null. draft.form 으로 갈리는 판별 유니온이라 컬럼으로 펴지 않는다.
  -- 회의록 행 · 공문 본문 · 회의 안건 · TBM 자료는 서식이 전부 달라서
  -- 공통 컬럼으로 펴면 빈칸만 늘어난다.
  draft              jsonb       check (draft is null or jsonb_typeof(draft) in ('object', 'null')),

  confirmed_by       text,
  confirmed_at       timestamptz,

  -- ▼ due_by 가 text 인 것은 실수가 아니다.
  -- 시나리오 카드 셋은 시각이 확정되지 않아 사람이 읽는 문장으로 들어온다:
  --   '2026-08-19 오전 중 (시각 미상)'
  --   '2026-08-19 중 발송 (반입 2026-08-24 이전)'
  -- timestamptz 로 받으면 이 셋이 들어오지 못하고 화면 계약(3절)이 깨진다.
  -- 날짜로 좁히는 일은 앞 열 글자를 정규식으로 뽑아서 한다 — 아래 표현식 인덱스.
  due_by             text,

  estimated_minutes  integer     check (estimated_minutes is null or estimated_minutes > 0),
  assignee           text,
  delegable          boolean     not null default true,

  -- ▼ text[] 가 아니라 jsonb 다. store-pg.ts 가 `json(item.blockedBy)::jsonb` 로 넣고
  -- 읽을 때 `row.blocked_by ?? []` 로 그대로 배열을 받는다. text[] 로 잡으면 insert 가
  -- 타입 오류로 죽는다. 배열 원소에 외래 키를 걸 수 없는 것은 어느 쪽이든 같다 —
  -- 없는 id 가 섞이면 화면이 흐린 카드만 그린다.
  blocked_by         jsonb       not null default '[]'::jsonb
                                 check (jsonb_typeof(blocked_by) in ('array', 'null')),

  -- 열 안의 순서. 실수다. 두 카드 사이에 끼울 때 앞뒤 값의 중간값을 넣으면
  -- 다른 행을 건드리지 않는다. 정수로 반올림하면 자리가 겹친다.
  lane_order         double precision not null default 0,

  -- store-pg.ts 가 nowIso() 로 직접 채운다(KST 벽시계 + '+09:00').
  -- **updated_at 트리거를 달지 마라.** 달면 저쪽이 계산한 값을 조용히 덮어쓴다.
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 확정 주체와 확정 시각은 함께 있거나 함께 없다. moveItem 이 confirming 일 때만
  -- 둘을 같이 채우고 rejectItem 이 둘을 같이 지운다 — 그 불변식을 DB 에도 적는다.
  constraint work_items_confirmed_pair
    check ((confirmed_by is null) = (confirmed_at is null))
);

comment on table  board.work_items            is 'WorkItem. 칸반 카드. 세 열이 하나의 스키마를 공유한다.';
comment on column board.work_items.status     is '진행 단계가 아니라 지금 이 카드를 움직일 수 있는 주체.';
comment on column board.work_items.due_by     is 'ISO 가 아닐 수 있다. 시각 미상 카드는 사람이 읽는 문장으로 들어온다.';
comment on column board.work_items.blocked_by is 'jsonb 배열. text[] 가 아니다 — store-pg.ts 가 jsonb 로 넣는다.';
comment on column board.work_items.lane_order is '실수. 삽입은 앞뒤 값의 중간값.';

-- listItems(siteId, status?) — 열별 목록.
create index if not exists work_items_site_status_lane_idx
  on board.work_items (site_id, status, lane_order);

-- listItems 의 date · from · to 필터. store-pg.ts 의 표현식과 **글자까지 같아야**
-- 계획기가 이 인덱스를 고른다. 파싱된 식으로 대조하므로 정규식 리터럴이 동일해야 한다.
-- (JS 템플릿 안에서는 '\\d{4}-…' 로 적혀 있고 SQL 로 나갈 때 '\d{4}-…' 가 된다.)
create index if not exists work_items_site_due_text_idx
  on board.work_items (site_id, (substring(due_by from '\d{4}-\d{2}-\d{2}')));

-- 같은 필터의 폴백 가지 — due_by 가 없으면 created_at 의 KST 날짜를 본다.
create index if not exists work_items_site_created_idx
  on board.work_items (site_id, created_at);

-- 낙관적 갱신 뒤 화면이 되읽는 경로.
create index if not exists work_items_site_updated_idx
  on board.work_items (site_id, updated_at desc);

-- ----------------------------------------------------------------------------
-- [2] board.snapshot_facts — 감지가 읽는 현장 사실
--
-- 추가만 한다. 같은 (site_id, fact_type, key) 가 시각마다 여러 행으로 쌓이고,
-- FactDelta 는 그 가운데 인접한 두 행의 차이다. UPDATE 로 덮으면 delta 를 만들
-- 재료가 사라지고 T-02(두 회차 연속 미조치)·T-07(추천값 이격)이 성립하지 않는다.
--
-- listFacts 가 최신 값만이 아니라 이력 전부를 관측 시각 오름차순으로 돌려주는 것도
-- 같은 이유다. 여기서 최신만 남기면 감지가 "무엇이 무엇으로 바뀌었나" 를 못 본다.
-- ----------------------------------------------------------------------------
create table if not exists board.snapshot_facts (
  fact_id        bigint generated always as identity primary key,
  site_id        text        not null,

  fact_type      text        not null check (fact_type in (
                   'weatherObservation', 'scheduleActiveTasks', 'riskAssessmentRow',
                   'tbmMinutesFeedback', 'tbmMinutesPreWorkCheck', 'tbmMinutesAttendees',
                   'documentExtraction', 'documentApprovalState', 'snapshotMaterials',
                   'externalReviewComment', 'nearMissReport', 'officialNotice',
                   'riskRecommendation', 'attendanceRoster')),

  key            text        not null,
  value          jsonb       not null,
  observed_at    timestamptz not null,

  -- 문서함(public.documents)의 행. 값이 없을 수 있어 nullable 이고,
  -- 외래 키는 [5] 에서 따로 건다 — 시나리오 문서 id 문제가 거기 걸린다.
  source_doc_id  text,

  confidence     double precision not null default 1
                 check (confidence >= 0 and confidence <= 1),

  -- observed_at 은 사실이 관측된 시각, 이것은 행이 쓰인 시각. appendFacts 가
  -- 충돌 시 value 를 덮으므로, 재적재를 원본과 구별할 유일한 자국이다.
  recorded_at    timestamptz not null default now(),

  -- appendFacts 의 `on conflict (site_id, fact_type, key, observed_at)` 대상이다.
  -- 같은 스냅샷을 두 번 밀어 넣어도 행이 두 벌 생기지 않는다.
  -- POST /api/board/detect 의 멱등성 가운데 첫 겹.
  constraint snapshot_facts_unique_observation
    unique (site_id, fact_type, key, observed_at)
);

comment on table board.snapshot_facts is
  'SnapshotFact. 추가만 한다 — FactDelta 가 인접한 두 행의 차이다. UPDATE 로 덮지 마라.';

-- appendFacts 의 prev CTE — (site_id, fact_type, key) 안에서 observed_at 이하 최신 한 행.
-- 위 unique 제약의 인덱스가 그대로 이 경로를 탄다.

-- listFacts(siteId, factType?) 의 정렬(observed_at, fact_type, key)과
-- latestSnapshotAt 의 max(observed_at).
create index if not exists snapshot_facts_site_observed_idx
  on board.snapshot_facts (site_id, observed_at, fact_type, key);

-- 문서 하나가 무엇을 낳았는지 되짚을 때.
create index if not exists snapshot_facts_source_doc_idx
  on board.snapshot_facts (source_doc_id)
  where source_doc_id is not null;

-- ----------------------------------------------------------------------------
-- [3] board.detection_events — 감지 한 건
--
-- DetectionRun 은 별도 테이블이 아니다. 한 번의 실행이 낳은 Detection 들이 run_id 와
-- started_at 을 같이 지고 있고, run 은 그것들의 묶음으로만 존재한다. 테이블을 아끼려는
-- 것이 아니라, BoardStore 에 listRuns 가 없기 때문이다 — listDetections 는
-- Detection[] 을 돌려주고, 감지가 하나도 없는 실행에 대해 화면이 물어볼 것이 없다.
-- ----------------------------------------------------------------------------
create table if not exists board.detection_events (
  detection_id     bigint generated always as identity primary key,

  run_id           text        not null,
  site_id          text        not null,

  -- TriggerRuleId('T-01'~'T-08') 또는 ScheduleRuleId('S-…').
  -- 주기 규칙은 아직 열거되지 않아 타입이 템플릿 리터럴이므로 여기서도 열어 둔다.
  rule_id          text        not null check (rule_id ~ '^[TS]-[A-Za-z0-9_.-]+$'),

  -- 조건이 성립한 시각. 실행 시각(started_at)과 다르다 —
  -- 조건은 8월 18일에 감지되고 사람이 그것을 보는 화면은 8월 19일이다.
  detected_at      timestamptz not null,
  started_at       timestamptz not null,

  confidence       double precision not null check (confidence >= 0 and confidence <= 1),
  summary          text        not null,

  evidence         jsonb       not null default '[]'::jsonb
                               check (jsonb_typeof(evidence) in ('array', 'null')),
  invalidates      jsonb       not null default '[]'::jsonb
                               check (jsonb_typeof(invalidates) in ('array', 'null')),
  produces         jsonb       not null default '[]'::jsonb
                               check (jsonb_typeof(produces) in ('array', 'null')),

  -- 이 실행이 만든 카드의 item_id. **jsonb 배열이다** — store-pg.ts 가
  -- `json(run.created.map(i => i.itemId))::jsonb` 로 넣는다. text[] 로 잡으면 죽는다.
  created_item_ids jsonb       not null default '[]'::jsonb
                               check (jsonb_typeof(created_item_ids) in ('array', 'null')),

  created_at       timestamptz not null default now(),

  -- appendDetections 의 `on conflict (run_id, rule_id, detected_at)` 대상이다.
  -- 멱등성의 둘째 겹. 카드 쪽은 결정적 item_id 의 upsert 가 받는다.
  -- ▶ site_id 가 아니라 run_id 로 묶는다. 같은 조건이 다른 실행에서 다시 감지되면
  --   그것은 별개의 사건이고, 감지 이력이 실행 단위로 남아야 브리핑이
  --   "어제 오후부터 조건 세 건" 을 셀 수 있다.
  constraint detection_events_unique_condition
    unique (run_id, rule_id, detected_at)
);

comment on table  board.detection_events            is 'Detection. run 은 run_id 로 묶이는 이 행들의 집합이다.';
comment on column board.detection_events.detected_at is '조건이 성립한 시각. 사람이 보는 보드 날짜와 다를 수 있다.';
comment on column board.detection_events.created_item_ids is 'jsonb 배열. text[] 가 아니다.';

-- listDetections(siteId, since?) — 브리핑의 windowHours 창. order by detected_at desc.
create index if not exists detection_events_site_detected_idx
  on board.detection_events (site_id, detected_at desc);

-- 규칙 하나의 직전 감지(lookup.lastDetection).
create index if not exists detection_events_site_rule_idx
  on board.detection_events (site_id, rule_id, detected_at desc);

-- ----------------------------------------------------------------------------
-- [4] board.invalidations — 무엇이 전제를 잃었는가
--
-- Invalidation 은 work_items.invalidates 와 detection_events.invalidates 안에
-- jsonb 로도 들어 있다. 그 두 벌은 **카드/감지 한 건을 읽을 때 딸려 나오는 사본**이고,
-- 이 테이블은 반대 방향 질문에 답한다:
--   "ra_2026_07_regular 는 지금 무효화되어 있나. 누가 언제 무엇 때문에 그랬나."
-- jsonb 배열만 있으면 그 질문에 전 카드를 훑어야 답한다.
--
-- item_id 와 run_id 는 **둘 중 하나만** 채워진다.
--   upsertItems       → (item_id = 카드, run_id = null)
--   appendDetections  → (item_id = null, run_id = 실행)
-- 그래서 unique 를 두 벌 둔다. NULL 은 서로 충돌하지 않으므로 각 경로가 자기 쪽
-- 인덱스로만 중복을 막는다. store-pg.ts 가 한쪽은 대상을 지정한 on conflict 를,
-- 다른 쪽은 대상 없는 on conflict do nothing 을 쓰는 것이 이 구조 때문이다.
--
-- ▶ doc_id 는 public.documents.id 가 아니다. 'ra_2026_07_regular' ·
--   'tbm_20260818_pour' 같은 도메인 문서 식별자이고, 문서함에 파일로 올라오지 않은
--   것도 있다. 그래서 여기에는 외래 키를 걸지 않는다. 걸면 회의록의 무효화를
--   기록할 수 없게 된다.
-- ----------------------------------------------------------------------------
create table if not exists board.invalidations (
  invalidation_id bigint generated always as identity primary key,

  item_id         text,
  run_id          text,

  doc_id          text        not null,
  scope           text        not null,
  reason          text        not null,

  created_at      timestamptz not null,

  -- upsertItems 의 `on conflict (item_id, doc_id, scope) do update set reason = …`
  constraint invalidations_unique_by_item
    unique (item_id, doc_id, scope),

  -- appendDetections 의 대상 없는 `on conflict do nothing` 이 여기에 걸린다.
  constraint invalidations_unique_by_run
    unique (run_id, doc_id, scope)
);

comment on table  board.invalidations is
  'Invalidation. 카드/감지 안의 jsonb 사본과 달리 "이 문서가 지금 무효인가" 에 답하는 방향.';
comment on column board.invalidations.doc_id is
  '도메인 문서 식별자. public.documents.id 가 아니다 — 문서함에 없는 회의록도 있어 FK 를 걸지 않는다.';

-- "이 문서가 무효인가" 의 역방향 조회.
create index if not exists invalidations_doc_idx
  on board.invalidations (doc_id);

-- ----------------------------------------------------------------------------
-- [5] 외래 키 — 여기만 고치면 된다
--
-- 아래 ALTER 는 전부 board.* 즉 이 파일이 방금 만든 테이블을 대상으로 한다.
-- public.sites · public.documents 는 참조만 하고 고치지 않는다.
--
-- ▶ [0] 의 NOTICE 가 text 가 아닌 타입을 찍었다면, 참조하는 쪽 컬럼의 타입을 먼저
--   그 타입으로 바꾸고 이 블록을 돌린다. 타입이 다르면 여기서 실패한다.
--   (예: alter table board.work_items alter column site_id type uuid using site_id::uuid;)
--
-- ▶ 시드가 시나리오 문자열 id(site_gimpo_gochon_01 · doc_2_k3f9x1qm)를 그대로 쓴다면
--   public 쪽에 대응하는 행이 먼저 있어야 한다. 특히 snapshot_facts.source_doc_id 는
--   시나리오 문서 id 를 담는 자리라 문서함에 그 행이 없기 쉽다.
--   없다면 **마지막 제약 하나만** 주석 처리하고 나머지는 그대로 둔다.
-- ----------------------------------------------------------------------------

alter table board.work_items
  add constraint work_items_site_fk
  foreign key (site_id) references public.sites (id) on delete cascade;

alter table board.snapshot_facts
  add constraint snapshot_facts_site_fk
  foreign key (site_id) references public.sites (id) on delete cascade;

alter table board.detection_events
  add constraint detection_events_site_fk
  foreign key (site_id) references public.sites (id) on delete cascade;

alter table board.invalidations
  add constraint invalidations_item_fk
  foreign key (item_id) references board.work_items (item_id) on delete cascade;

-- 문서함이 지워져도 사실 자체는 남는다. 근거 문서 링크만 끊긴다.
-- ▶ 시드가 문서함에 없는 문서 id 를 쓴다면 이 한 줄을 주석 처리한다.
alter table board.snapshot_facts
  add constraint snapshot_facts_source_doc_fk
  foreign key (source_doc_id) references public.documents (id) on delete set null;

-- ============================================================================
-- [6] board.work_item_events — 카드 이력
--
-- 계약 2.2 가 "승인 시 고친 값과 기각 사유는 이력으로 쌓인다" 고 못 박은 값이 들어가는
-- 자리다. 이 테이블이 없으면 store-pg.ts 의 rejectItem 이 기각 사유를 로그로만 흘리고,
-- "숫자를 고쳐 승인하면 그 차이가 이력으로 남습니다" 라는 카드 문구가 거짓이 된다.
--
-- diff 는 [{ field, from, to }] 배열이다. 승인 시점에 초안과 무엇이 달라졌는지가 여기
-- 쌓이고, 그 누적이 다음 초안의 품질을 정하는 되먹임 고리가 된다.
-- ============================================================================

create table if not exists board.work_item_events (
  event_id   bigint generated always as identity primary key,
  item_id    text        not null,
  type       text        not null,
  actor      text        not null,
  reason     text,
  diff       jsonb       not null default '[]'::jsonb,
  created_at timestamptz not null default now(),

  constraint work_item_events_type_ck
    check (type in ('created', 'moved', 'approved', 'rejected', 'edited')),

  -- 기각은 사유가 반드시 있어야 한다. 사유 없는 기각을 막는 것이 이 테이블의 존재 이유
  -- 절반이므로, 애플리케이션 검증에만 맡기지 않고 스키마로도 막는다.
  constraint work_item_events_reject_reason_ck
    check (type <> 'rejected' or (reason is not null and btrim(reason) <> ''))
);

-- 카드 하나의 이력을 최신순으로 읽는 것이 유일한 조회 패턴이다.
create index if not exists work_item_events_item_idx
  on board.work_item_events (item_id, created_at desc);

alter table board.work_item_events
  add constraint work_item_events_item_fk
  foreign key (item_id) references board.work_items (item_id) on delete cascade;


commit;

-- ============================================================================
-- 이 초안에 없는 것 (의도적으로 비웠다)
--
-- ▸ updated_at 트리거. store-pg.ts 가 nowIso() 로 직접 채운다. 트리거를 달면
--   그 값을 조용히 덮어써서 화면의 낙관적 갱신 비교가 어긋난다.
--
-- ▸ 인증 · RLS. /api/context/* 와 같은 상태다. 담당자 이름과 하도급사 상호가
--   그대로 들어가는데 행 수준 제한이 없다.
--
-- ▸ public.document_chunks.embedding 인덱스. 4096 차원이라 hnsw 상한 밖이다.
--   붙이려면 표현식 인덱스여야 하고(binary_quantize → bit(4096) bit_hamming_ops),
--   그건 public 테이블을 건드리는 일이라 이 파일의 범위가 아니다.
--
-- ▸ board.sites · board.sources · board.conditions · board.cards · board.card_events.
--   docs/plan-task-board.md 3절의 이름이다. lib/board/types.ts 가 확정되면서
--   대체되었다. cards → work_items, conditions → detection_events 로 읽으면 된다.
--   sites 는 만들지 않는다 — public.sites 를 참조한다.
-- ============================================================================
