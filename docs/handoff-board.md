# 태스크 보드 인수인계 — 계약 · 화면 · 감지 · 스키마

> 2026-08-22 18:07 기준. 사이드바 첫 탭(`오늘의 보드`)이 될 것의 전부.
> 문서 인제스트(두 번째 탭)는 `HANDOFF.md`, 챗봇은 `docs/company-chatbot-plan.md` 를 본다.
>
> **이 문서는 그 시각의 `git status` 와 `ls` 를 그대로 옮긴 것이다.** 여러 사람이 같은 시각에
> 파일을 만들고 있었으므로, 읽는 시점에는 아래 표에 없는 파일이 더 있을 수 있다.
> 없는 것을 있다고 적지 않았다.

## 무엇을 만들었나

여덟 개 조건을 감지해 카드로 올리고, 사람이 승인·기각하는 칸반이다. 화면·계약·감지·스키마를
동시에 세웠고 **아직 하나로 이어 붙이지 않았다.**

```
계약과 로직
  lib/board/types.ts            계약의 단일 진실. WorkItem · SnapshotFact · Detection · BoardStore 등 31개 타입
  lib/board/store.ts            BOARD_STORE 로 갈리는 저장소 선택기 + BoardStoreError 네 갈래
  lib/board/store-json.ts       JSON 파일 구현. 지금 실제로 도는 것
  lib/board/store-pg.ts         Postgres 구현. 테이블이 없어 아직 실행되지 않는다
  lib/board/transition.ts       열 이동 · 확정 · 기각의 상태 전이 규칙
  lib/board/briefing.ts         Detection[] → Briefing. 여섯 칸이 비어도 자리를 지킨다

감지
  lib/detect/delta.ts           SnapshotFact[] → FactDelta[]. 자리는 (현장·종류·키)
  lib/detect/engine.ts          규칙 여덟 개를 한 시각에 대해 동기로 돌린다
  lib/detect/rules/index.ts     규칙 등록
  lib/detect/rules/t01-weather.ts · t02-followup.ts · t03-material.ts · t04-review.ts
  lib/detect/rules/t05-nearmiss.ts · t06-inspection.ts · t07-score-gap.ts · t08-new-worker.ts

커넥터
  lib/connect/types.ts          커넥터 계약. 출처가 무엇이든 SnapshotFact[] 만 돌려준다
  lib/connect/index.ts          커넥터 등록과 실행
  lib/connect/weather.ts        기상. WEATHER_API_KEY 있으면 기상청, 없으면 시나리오 시드
  lib/connect/schedule.ts       공정
  lib/connect/roster.ts         출역 명부

라우트 (계약 2절의 다섯 개가 전부 있다)
  app/api/board/items/route.ts            GET   카드 목록
  app/api/board/items/[itemId]/route.ts   PATCH 열 이동 · 확정 · 기각
  app/api/board/briefing/route.ts         GET   브리핑
  app/api/board/detect/route.ts           POST  감지 실행
  app/api/board/week/route.ts             GET   주간 배치

데이터
  data/board/seed-items.json    8월 19일 카드. JSON 저장소가 읽는다

화면
  components/task-board/types.ts     뷰 모델. 서버 타입과 별도이고 스네이크 케이스를 보지 않는다
  components/task-board/fixtures.ts  8월 19일 장면 목 데이터 (957줄)
  components/task-board/board-data.ts · fixture.ts
  components/task-board/board-header.tsx    헤더와 카운터
  components/task-board/daily-briefing.tsx  브리핑 접힘/펼침
  components/task-board/briefing-item.tsx   브리핑 항목 여섯 칸
  components/task-board/kanban-board.tsx · kanban-column.tsx · task-card.tsx
  components/task-board/draft-preview.tsx   초안 미리보기 (서식별 분기)
  components/task-board/reject-dialog.tsx   기각 사유 입력
  components/task-board/week-calendar.tsx   주간 캘린더

그 밖
  lib/agent/upstage-agent.ts   Upstage Studio 에이전트 경로 클라이언트 (문서 미기재 경로 포함)
  scripts/make-docs/           더미 문서 생성기. Chrome headless 로 HTML → PDF, 새 패키지 없음
  docs/board-contract.md       라우트 다섯 개의 요청·응답을 예시로 고정한 계약서
  docs/plan-task-board.md      6단계 구현 계획
  docs/migration-board.sql     ← 이 작업. board 스키마 마이그레이션 초안
  docs/handoff-board.md        ← 이 문서
```

`app/globals.css` 에 보드 스타일이 1770줄 들어갔다(추가만 했고 기존 규칙은 건드리지 않았다).

### `docs/migration-board.sql` 이 하는 일

테이블 넷을 `board` 스키마에 만든다. **이 레포는 이 파일을 실행하지 않는다.**

| 테이블 | 대응 타입 | 무엇을 담나 |
| --- | --- | --- |
| `board.work_items` | `WorkItem` | 칸반 카드. 세 열이 하나의 스키마를 공유한다 |
| `board.snapshot_facts` | `SnapshotFact` · `FactDelta` | 감지가 읽는 현장 사실. **추가만 한다** |
| `board.detection_events` | `Detection` · `DetectionRun` | 감지 한 건. run 은 `run_id` 로 묶이는 집합일 뿐 별도 테이블이 아니다 |
| `board.invalidations` | `Invalidation` | "이 문서가 지금 무효인가"에 답하는 역방향 색인 |

`public.sites` · `public.documents` 를 참조만 하고 고치지 않는다. 파일 안에 기존 테이블을
`ALTER` 하는 문장은 없다 — `[5]` 블록의 `ALTER` 는 전부 방금 만든 `board.*` 가 대상이다.

## 지금 상태

| | |
| --- | --- |
| `npx tsc --noEmit` | **10건 실패 — 전부 기준선.** 아래 참고. 18:06 실측 |
| `npx eslint .` | 통과 (exit 0). 오류 0 · 경고 6 (전부 `scripts/make-docs/**` 의 익명 default export) |
| `npm run build` | **돌려 보지 않았다.** `postgres` 가 없어 빌드가 어디서 깨지는지 모른다 |
| `lib/board/types.ts` | 확정. 31개 타입 |
| `BoardStore` 구현 | 두 벌 다 있다. JSON 은 `data/board/seed-items.json` 을 읽고, **Postgres 는 테이블이 없어 첫 호출에서 멈춘다** |
| `app/api/board/**` | 다섯 개 전부 있다. **실호출로 확인하지 않았다** |
| 감지 규칙 | 여덟 개 전부 있다. **실행해 보지 않았다** |
| 커넥터 | `weather` · `schedule` · `roster` 셋. 사실 종류 열넷 가운데 나머지 열하나는 공급처가 없다 |
| 화면 | 조각 열셋. **묶는 컨테이너가 없고 사이드바에 붙지 않았다.** `construction-console.tsx` 에 `task-board` 를 부르는 줄이 없다 |
| 시드 데이터 | `data/board/seed-items.json` (JSON 저장소용)과 `components/task-board/fixtures.ts` (화면 목). **DB 에는 없다** |
| 마이그레이션 실행 | **한 번도 돌려 보지 않았다.** 문법 검증조차 못 했다 — 아래 함정 ① |
| 인증 | 없다. `/api/context/*` 와 같은 상태다 |

### 타입 오류 10건은 새 것이 아니다

```
lib/context/db.ts(1,22): Cannot find module 'postgres'          ← 1건
… Parameter 's'/'tx'/'r' implicitly has an 'any' type            ← 9건, 위 1건의 파생
```

`node_modules` 에 `postgres` 가 설치되어 있지 않다(`package.json` 에는 있다). `npm install` 이
막혀 있어 이 게이트는 넘을 수 없다. **판정 기준은 "기준선과 같은 10건 외에 새 오류 없음"이고,
18:06 실측으로 새 오류는 0건이다.**

18:02 에는 6건이 더 있었다. 라우트 넷이 `getStore` 를 부르는데 `lib/board/store.ts` 가
내보내는 이름은 `boardStore` 였다 — 같은 시각에 두 사람이 쓴 파일의 이름이 어긋난 것이다.
지금은 맞춰져 있다. **`lib/board/**` 와 `app/api/board/**` 를 동시에 고칠 때 다시 나기 쉬운
종류의 오류다.** 이름이 계약이다.

## 왜 이 모양인가

### 감지가 async 가 아닌 이유

`TriggerRule.detect(input): Detection[]` 는 `Promise` 를 돌려주지 않는다. 실수가 아니다.

규칙 여덟 개는 **같은 시각에 대해 하나의 답을 내야 한다.** 루프 안에서 네트워크나 DB 를 부르면
T-01 이 기상 API 를 기다리는 동안 T-03 이 먼저 끝나고, 그 사이에 스냅샷이 한 번 더 들어오면
두 규칙이 서로 다른 세계를 본 채로 카드를 만든다. 8월 19일 장면에서 T-03(자재 변경)과
S-02(이행확인 미표시)가 **같은 협의체 안건 자료 한 장**에 안건 3번과 4번으로 함께 실리는데,
두 규칙이 다른 시각의 사실을 봤다면 그 한 장이 만들어지지 않는다.

그래서 호출자가 `facts` · `deltas` 를 **먼저 전부 채워** `DetectInput` 으로 넘기고, 규칙은
`lookup` 으로만 되짚는다. 부수 효과로 규칙 여덟 개가 순수 함수가 되어 DB 없이 테스트된다.

값을 모으는 쪽(커넥터)은 당연히 async 다. 경계가 `DetectInput` 이다.

### 저장소가 JSON 과 Postgres 두 벌인 이유

**스키마의 소유자가 이 레포가 아니기 때문이다.** 테이블은 `inevitable2026/tbm-check` 가 만든다.
`docs/migration-board.sql` 은 그쪽에 넘기는 초안이고, 그쪽이 언제 적용할지 우리가 정하지 않는다.

그 사이에 화면이 멈춰 있을 수는 없다. 그래서 `BOARD_STORE` 환경변수 하나로 갈린다 —
기본값이 JSON 구현이고 `BOARD_STORE=pg` 일 때만 Postgres 구현이다. 두 구현이 같은
`BoardStore` 인터페이스(메서드 열 개)를 만족하므로 라우트는 어느 쪽인지 모른다.

한 벌로 줄이려면 둘 중 하나를 포기해야 한다. Postgres 만 쓰면 테이블이 생기는 날까지 화면에
넣을 값이 없다. JSON 만 쓰면 서버리스에서 요청 사이에 살아남는 파일시스템이 없어서(Vercel 은
읽기 전용) 승인·기각이 새로고침에 사라진다. **두 벌이 비용이 아니라 그 두 사실의 결과다.**

`store.ts` 가 Postgres 구현을 **동적 `import()` 로 미룬다**. 정적으로 부르면
`store-pg` → `lib/context/db` → `postgres` 가 모듈 평가 시점에 딸려 들어오는데,
지금 `postgres` 가 설치되어 있지 않아 **JSON 으로 돌 때조차 보드 전체가 import 에서 죽는다.**
`BOARD_STORE=pg` 를 켠 사람만 그 대가를 치르게 하는 구조다.

### `due_by` 가 `text` 인 이유

시나리오 카드 셋은 시각이 확정되지 않아 사람이 읽는 문장으로 들어온다.

```
"2026-08-19 오전 중 (시각 미상)"
"2026-08-19 중 발송 (반입 2026-08-24 이전)"
```

`timestamptz` 로 받으면 이 셋이 아예 들어오지 못한다. 그런데 `items?date=` 와 `week` 는 날짜로
좁혀야 한다. `store-pg.ts` 는 **ISO 든 사람 문장이든 앞부분이 `YYYY-MM-DD` 라는 사실**을 써서
정규식으로 뽑는다.

```sql
substring(due_by from '\d{4}-\d{2}-\d{2}') = '2026-08-19'
```

마이그레이션은 그 식에 **표현식 인덱스**를 맞춰 뒀다. 계획기가 파싱된 식으로 대조하므로
정규식 리터럴이 글자까지 같아야 인덱스를 고른다 — 한쪽만 고치면 조용히 순차 스캔이 된다.

`due_date` 같은 생성 컬럼도 검토했다가 뺐다. `store-pg.ts` 가 그 컬럼을 보지 않아서
쓰이지 않는 컬럼이 하나 늘 뿐이다. 만들 거였다면 `due_by::date` 는 못 쓴다 —
`text::date` 캐스트는 `DateStyle` 에 걸려 `STABLE` 이라 생성 컬럼에 들어가지 않는다.
`to_date(substring(due_by from 1 for 10), 'YYYY-MM-DD')` 만 `IMMUTABLE` 이다.

### 열거형에 `enum` 대신 `text + check` 를 쓴 이유

유니온의 원본이 TS 배열(`FACT_TYPES` · `WORK_ITEM_TIMINGS` …)이다. 값이 늘 때 저쪽은 배열 한 줄만
고치는데 Postgres `enum` 은 `ALTER TYPE ... ADD VALUE` 가 필요하고, 그건 같은 트랜잭션 안에서
그 값을 쓸 수 없다는 제약을 달고 온다. `ScheduleRuleId` 가 `` `S-${string}` `` 인 것도 이유다 —
주기 규칙이 아직 열거되지 않았으므로 `enum` 으로 못 박을 값이 없다.

### `invalidations` 가 별도 테이블인 이유

`Invalidation` 은 `work_items.invalidates` 와 `detection_events.invalidates` 안에 jsonb 로도
들어 있다. 그 두 벌은 **카드/감지 한 건을 읽을 때 딸려 나오는 사본**이고, 테이블은 반대 방향
질문에 답한다: "`ra_2026_07_regular` 는 지금 무효인가. 누가 언제 무엇 때문에." jsonb 배열만
있으면 그 질문에 전 카드를 훑어야 한다.

`item_id` 와 `run_id` 는 둘 중 하나만 채워진다(카드가 넣으면 `item_id`, 감지가 넣으면 `run_id`).
그래서 unique 가 두 벌이고, `store-pg.ts` 가 한쪽은 대상을 지정한 `on conflict` 를,
다른 쪽은 대상 없는 `on conflict do nothing` 을 쓴다. 아래 함정 ③ 도 같이 본다.

### `DetectionRun` 에 테이블을 주지 않은 이유

`listDetections` 가 `Detection[]` 을 돌려주고 `BoardStore` 에 `listRuns` 가 없다. 감지가 하나도
없는 실행에 대해 화면이 물어볼 것이 없다. `run_id` 와 `started_at` 을 각 감지 행이 함께 지고
있으면 묶음은 `group by run_id` 로 언제든 복원된다.

## 함정

시간을 태울 자리들.

**① 이 마이그레이션은 한 번도 실행되지 않았다.** `postgres` 가 `node_modules` 에 없고 `psql` 도
깔려 있지 않아서 라이브 DB 를 들여다볼 수단이 없었다. **문법 검증조차 못 했다.**
tbm-check 에서 처음 돌릴 때 실패할 수 있다. 전체가 `begin` / `commit` 으로 감싸여 있으니
실패해도 절반만 적용되지는 않는다.

**② `public.sites.id` 와 `public.documents.id` 의 타입을 모른다.** 초안은 `text` 로 잡았지만
근거는 "코드가 문자열로 다룬다"뿐이고, `postgres.js` 는 `uuid` 도 문자열로 준다. 파일 맨 앞
`[0]` 블록이 실제 타입을 `RAISE NOTICE` 로 찍는다. **먼저 그것부터 보고 `[5]` 를 맞춰라.**
타입이 다르면 `[5]` 에서 실패한다 — 그 지점 하나로 몰아 뒀다.

**③ `invalidations.doc_id` 에 외래 키를 걸지 마라.** 시나리오의 `ra_2026_07_regular` ·
`tbm_20260818_pour` 는 **도메인 문서 식별자**이고 `public.documents.id` 가 아니다.
문서함에 파일로 올라오지 않은 회의록도 무효화 대상이 된다. FK 를 걸면 그런 행을 기록할 수
없게 되고, 무효화를 기록 못 하는 것이 참조 무결성보다 나쁘다. 초안이 `document_id` 컬럼을
따로 두고 그쪽에만 FK 를 거는 안도 검토했는데, `store-pg.ts` 가 그 컬럼에 아무것도 넣지
않아서 뺐다 — 값이 안 들어가는 컬럼은 무결성이 아니라 오해다.

**④ 시드가 `site_gimpo_gochon_01` 을 그대로 쓰면 FK 가 깨진다.** 계약 예시의 `siteId` 가
그 문자열이다. `public.sites` 에 그 id 의 행이 먼저 있어야 한다. 없으면 시드가 아니라
`sites` 행부터다.

**⑤ 질의에 `board.` 를 반드시 붙여라.** `docs/plan-task-board.md` 3절이 `board.sites` 를 두려
했었다. 지금 초안은 만들지 않지만, 나중에 누가 만들면 `public.sites` 와 이름이 겹친다.
`search_path` 에 기대는 질의는 그날 조용히 남의 테이블을 읽는다.

**⑥ `postgres.js` 는 `timestamptz` 를 JS `Date` 로 준다.** 계약의 시각은 전부 `+09:00` 이 붙은
ISO 문자열이다. `Date` 를 그대로 `JSON.stringify` 하면 `Z` 로 나가서 화면이 하루 어긋난다.
질의 계층이 `to_char(... at time zone 'Asia/Seoul')` 로 찍거나 되돌려 포맷해야 한다.
**날짜는 KST `'YYYY-MM-DD'` 문자열로만 왕복한다** — tbm-check `DayEntry.date` 와 같은 규칙이다.

**⑦ `lane_order` 를 정수로 반올림하지 마라.** `double precision` 이다. 두 카드 사이 삽입은
앞뒤 값의 중간값이고, 반올림하면 자리가 겹쳐 순서가 무작위가 된다.

**⑧ 임베딩 컬럼에 인덱스를 붙이려 하지 마라.** `public.document_chunks.embedding` 은 4096차원이라
pgvector 0.8 의 hnsw 상한(`vector` 2000 · `halfvec` 4000)을 어느 쪽으로도 넘는다. 이미 확인된
사실이다. 붙이려면 표현식 인덱스(`binary_quantize` → `bit(4096) bit_hamming_ops`)여야 하고,
그건 `public` 테이블을 건드리는 일이라 이 파일의 범위 밖이다. 자세한 것은 `HANDOFF.md`.

**⑨ `snapshot_facts` 를 `UPDATE` 로 덮지 마라.** 추가만 하는 테이블이다. `FactDelta` 가 같은
`(site_id, fact_type, key)` 의 인접한 두 행의 차이인데, 덮으면 `before` 를 만들 재료가 사라진다.
T-02(두 회차 연속 미조치)와 T-07(추천값 이격)이 그 자리에서 성립하지 않게 된다.

**⑩ `JSON.stringify(null)` 은 SQL NULL 이 아니다.** `store-pg.ts` 의 `json()` 헬퍼가
`JSON.stringify(v ?? null)` 이라 값이 없으면 문자열 `'null'` 이 나가고 `::jsonb` 캐스트가
그것을 **jsonb 의 null 리터럴**로 만든다. 컬럼은 SQL NULL 이 아니라 `'null'::jsonb` 를 받는다.
그래서 마이그레이션의 `jsonb_typeof` 검사가 전부 `'null'` 을 함께 허용한다.
`check (jsonb_typeof(trigger) = 'object')` 로 적으면 **`timing = 'daily'` 카드의 insert 가
전부 실패한다** — 그 카드들은 `trigger` 가 없다.

**⑪ `blocked_by` 와 `created_item_ids` 는 `text[]` 가 아니라 `jsonb` 다.** 배열이니 Postgres
배열이 자연스러워 보이는데, `store-pg.ts` 가 `json(...)::jsonb` 로 넣는다. `text[]` 로 잡으면
insert 가 타입 오류로 죽는다. 처음 마이그레이션 초안이 `text[]` 였고, `store-pg.ts` 가
디스크에 나타난 뒤 대조해서 고쳤다.

**⑫ `updated_at` 트리거를 달지 마라.** `store-pg.ts` 가 `nowIso()` 로 직접 채운다. 트리거를
얹으면 그 값을 조용히 덮어써서 화면의 낙관적 갱신 비교가 어긋난다. 초안에서 뺀 이유다.

**⑬ `detection_events` 의 멱등 키는 `run_id` 다.** `(site_id, rule_id, detected_at)` 이
아니라 `(run_id, rule_id, detected_at)` 이다. 같은 조건이 다른 실행에서 다시 감지되면 그것은
별개의 사건이고, 감지가 실행 단위로 남아야 브리핑이 "어제 오후부터 조건 세 건"을 셀 수 있다.

**⑭ `store-pg.ts` 의 오류 문구가 없는 경로를 가리킨다.** 테이블이 없을 때
*"db/board/001_init.sql 을 적용하거나…"* 라고 말하는데 **그런 파일은 없다.**
초안은 `docs/migration-board.sql` 이고, 애초에 이 레포에서 적용하는 물건이 아니다.
문구를 고치거나 파일을 그 경로로 옮겨야 한다 — 지금은 그 안내를 따라가면 막다른 길이다.

## 남은 일

순서대로다. 위가 아래를 막는다.

- **화면 컨테이너.** 조각 열셋이 있는데 묶는 것이 없다. `construction-console.tsx` 에
  `task-board` 를 부르는 줄이 아직 없어서 **보드가 화면에 안 뜬다.** `activeNav` 분기
  한 줄이면 된다 — 두 번째 탭(`<SiteContextPanel />`)이 그 형태다. 최우선.
- **실호출 확인.** 라우트 다섯 개와 규칙 여덟 개가 파일로는 다 있지만 **한 번도 돌려 보지
  않았다.** `npm run dev` 로 `GET /api/board/items?siteId=…` 부터 눌러 보는 것이 다음이다.
  `HANDOFF.md` 의 인제스트 절이 실측 수치를 남긴 것과 같은 자리를 여기도 채워야 한다.
- **마이그레이션을 tbm-check 에 전달.** `docs/migration-board.sql` 을 넘기고, 그쪽이
  `[0]` 블록의 NOTICE 를 보고 `[5]` 를 맞춘 뒤 적용한다. 이 레포에서 실행하지 않는다.
- **`BOARD_STORE=pg` 전환.** 테이블이 생긴 뒤. `store-pg.ts` 의 `ensureSchema()` 가 없는
  테이블 이름을 대고 멈추므로 전환 실패는 조용하지 않다.
- **DB 시드.** 지금 8월 19일 장면은 `data/board/seed-items.json` (JSON 저장소)과
  `fixtures.ts` (화면 목) 두 벌뿐이다. `scripts/make-docs/` 로 만든 더미 문서와 짝이 맞아야
  근거 칩의 `sourceDocRefs` 가 실제 문서를 가리킨다.
- **커넥터 나머지 열하나.** `weatherObservation` · `scheduleActiveTasks` · `attendanceRoster`
  셋만 공급처가 있다. `riskAssessmentRow` · `tbmMinutesFeedback` · `documentExtraction` …
  은 시드로 채울지 실연동할지 미정.
- **`board.work_item_events`.** 아래 위험 참고. 다음 마이그레이션의 1순위다.
- **`.env.example` 에 `BOARD_STORE` · `WEATHER_API_KEY` 추가.** 읽기 전용으로 취급해
  손대지 않았다.

## 알려진 위험

**승인 시 무엇을 고쳤는지가 남지 않는다.** 카드 "수시 위험성평가 회의록 신규 3행"의 문구가
*"숫자를 고쳐 승인하면 그 차이가 이력으로 남습니다"* 인데, **지금 스키마로는 사실이 아니다.**
`lib/board/types.ts` 에 `WorkItemEvent`(`type` · `actor` · `reason` · `diff`)가 이미 있는데
대응 테이블이 없다. 이번 배정이 테이블 넷이었다. `store-pg.ts` 의 `rejectItem` 이 그래서
기각 사유를 `console.warn` 으로만 남기고, 승인 diff 는 어디에도 안 남는다.
초안 단계에서 `work_items.reject_reason` 컬럼을 하나 두려다 뺐다 — 사유를 컬럼 하나에
덮어쓰면 "이력으로 쌓인다"를 반쯤 만족한 척하게 되는데, 그게 로그보다 나쁘다.
붙일 테이블의 모양은 `docs/migration-board.sql` 맨 끝에 적어 뒀다.
기획안 07장의 "기계의 추정이 어디서 반복적으로 어긋나는가"를 집계할 자리도 함께 없다.
화면에 저 문구를 띄운 채로 데모하면 확인 가능한 거짓말이 된다. **테이블을 만들거나 문구를 내려라.**

**인증이 없다.** `/api/context/*` 와 같은 상태다. 보드는 더 나쁘다 — 담당자 이름
(`confirmedBy` · `assignee`)과 하도급사 상호(서진건설 · 한빛가설)가 화면에 그대로 나온다.
`X-Robots-Tag: noindex, nofollow` 로 색인만 막고 있고, 그건 접근 통제가 아니다.
실질 완화책은 시드를 전부 가상 값으로만 채우는 것이다.

**행 수준 제한이 없다.** `siteId` 를 빠뜨린 질의는 전 현장을 돌려준다. 무인증 콘솔이라
의도된 동작이지만 현장별 화면에서 이 값을 놓치면 다른 현장 카드가 섞여 뜬다.
`work_items` 의 인덱스가 전부 `site_id` 선두인 것은 그 실수를 성능으로도 드러내려는 것이다.

**`estimatedMinutes` 에 근거가 없다.** 시나리오 값을 그대로 옮겼다. 기획안 02장의 업무 부하
59.6시간이 이 값들의 합이므로, 숫자 하나를 바꾸면 문제 정의가 흔들린다.

**DB 가 남의 워크스페이스에 있다.** Railway `ysh3396's Projects` 의 `junction-risk-assessment`.
스키마 소유는 tbm-check, 요금과 접근 권한은 팀 사정에 묶인다. 이 두 가지가 겹쳐서
`BOARD_STORE=pg` 로 넘어가는 날짜를 우리가 정하지 못한다.

**`BOARD_STORE` · `WEATHER_API_KEY` 가 `.env.example` 에 없다.** 그 파일은 읽기 전용으로
취급해 손대지 않았다. 배포 전에 누군가 추가해야 한다. 지금은 기본값(JSON 구현 · 시드 폴백)으로
조용히 도는데, 조용히 도는 것이 함정이다 — Postgres 를 켰다고 생각하면서 JSON 을 쓰게 된다.
