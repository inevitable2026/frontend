# 태스크 보드 구현 계획

> 2026-08-22 · 기획안 아티팩트 「현장 안전 코파일럿」(01~07장)을 이 레포에 구현하기 위한 계획.
> 시나리오 데이터의 출처는 `docs/scenario-gimpo-logistics.md` 이고, 기존 화면 언어는
> `app/globals.css` 와 `components/construction-console.tsx` 를 그대로 따른다.

## 확정된 결정

| 항목 | 결정 |
| --- | --- |
| 데이터 원천 | **이 레포가 소유하는 DB 를 따로 만들고 API 라우트를 붙인다.** 감지·오케스트레이션을 담당할 조율 장치는 나중에 그 사이에 들어온다 |
| AI 도우미 패널 | **기존 `/api/chat` 실연결.** 스크립트 재생이 아니라 실제 스트리밍과 도구 호출 표시를 그대로 쓴다 |
| 상태 저장 | **DB 영속화.** 승인·기각·이동이 새로고침 뒤에도 남고, 기각 사유와 초안 대비 수정분이 이력으로 쌓인다 |
| 진입 위치 | **사이드바 첫 항목이자 기본 화면.** `activeNav` 초기값이 0 이 되고 기존 챗봇은 두 번째로 밀린다 |

### 가정 하나

`board` 스키마를 **`DATABASE_URL` 과 같은 인스턴스 안에 새로** 만든다. tbm-check 가 소유한
`public` 스키마의 테이블(`sites` · `documents` · `document_chunks` …)은 읽지도 고치지도 않는다.
연결 모듈은 `BOARD_DATABASE_URL ?? DATABASE_URL` 순으로 읽으므로, 나중에 인스턴스를 갈라야
하면 환경변수 한 줄만 추가하면 된다.

---

## 1. 화면

### 1.1 배치

```
.construction-console
├── .sidebar                    336px · 기존 그대로, nav 첫 항목에 "태스크 보드" + 배지 11
└── .workspace.is-board         padding 0 · 보드가 폭을 온전히 쓴다
    └── .board-shell            position: relative — AI 패널의 위치 기준점
        ├── <BoardHeader/>      현장명 · 공정 · 카운터 3개 · 연결된 맥락 소스 4줄
        ├── <DailyBriefing/>    메트릭 6개 + 조건 항목 접기·펼치기
        ├── <WeekCalendar/>     8/17–23 · 일자 카드 7개 · 월간 펼치기
        ├── <KanbanBoard/>      Todo · 승인 · 완료 3열
        ├── <AssistantPanel/>   position: absolute · 보드를 덮는다
        └── <AssistantFab/>     닫힌 상태 · 배지는 닫혀 있는 동안 생긴 제안 수
```

기존 `.workspace` 는 `padding: 64px 0` 과 `.content-stack` 의 1123px 폭에 묶여 있다. 보드는
캘린더 7열과 칸반 3열을 동시에 세워야 하므로 `.workspace.is-board` 변형을 하나 두어 패딩을
없애고 폭 제한을 푼다. 챗봇과 현장 맥락 관리 탭의 렌더 경로는 그대로 둔다.

### 1.2 파일

```
components/task-board/
  task-board.tsx        컨테이너 — 데이터 로드, 낙관적 갱신, 키보드 단축키
  board-header.tsx      현장 헤더와 맥락 소스 줄
  daily-briefing.tsx    브리핑 문단과 메트릭
  briefing-item.tsx     조건 한 건 — 관측·대조·판단·무효화·만든 것·불확실성 여섯 칸
  week-calendar.tsx     주간 격자와 월간 전개
  kanban-board.tsx      3열 + 드래그 상태 관리
  kanban-column.tsx     열 하나
  task-card.tsx         카드 한 장 (세 유형 공통 스키마)
  draft-preview.tsx     "초안 보기" 펼침 — 회의록·공문·회의 자료·TBM 네 서식
  reject-dialog.tsx     기각 사유 입력 (사유 없이는 닫히지 않는다)
  assistant-panel.tsx   AI 도우미 오버레이
lib/board/
  types.ts              카드·조건·브리핑 타입 (아래 3절)
  db.ts                 board 스키마 전용 연결
  queries.ts            읽기·쓰기 질의
  briefing.ts           조건 행 → 브리핑 문장 조립
app/api/board/…         라우트 (아래 4절)
app/globals.css         .board-* 클래스 추가 (기존 토큰 재사용)
```

CSS 는 Tailwind 유틸리티가 아니라 `globals.css` 의 클래스 언어를 따른다. 콘솔 전체가 그 방식이고
아티팩트도 같은 전제로 그려졌다. 색은 `--purple-primary` · `--border-soft` · `--text-muted` 를
그대로 쓰고, 보드에만 필요한 값(열 배경, 카드 그림자, 자동 생성 테두리)만 `--board-*` 로 추가한다.

### 1.3 영역별 규격

**헤더** — 현장명과 공정 아래 카운터 세 개(조건 발생 · 오늘 기한 · 승인 대기)를 놓는다. 숫자는
카드 목록에서 파생하므로 별도 필드로 저장하지 않는다. 그 아래 "연결된 맥락을 보고 있습니다" 줄에
소스 네 개와 마지막 수신 시각을 적는다. 지금은 값이 DB 에 저장된 문자열이고, 조율 장치가 붙으면
실제 커넥터의 마지막 폴링 시각으로 바뀐다.

**브리핑** — 접힌 줄에는 조건 코드(T-03)·유형 배지·한 줄 요약·감지 시각·만든 태스크 수만 있다.
펼치면 여섯 칸이 **항상 같은 순서로** 나온다. 칸이 비면 자리를 지우지 않고 "없습니다"를 적는다.
자리가 옮겨 다니면 읽는 순서를 매번 다시 배워야 한다.

**캘린더** — 주간이 기본이고 일자 카드마다 상위 두 건과 `+N건` 을 적는다. 배지 색은 유형 세 가지
(조건 발생 · 기한 · AI 초안)로 나뉜다. 날짜를 누르면 칸반이 그 날짜로 필터링되고, "선택한 날만
보기" 토글로 해제한다. 월간 전개는 같은 데이터를 5주 격자로 다시 그리는 것이라 질의를 늘리지 않는다.

**칸반** — 열은 진행 단계가 아니라 **지금 이 카드를 움직일 수 있는 주체**로 나뉜다. 카드에는 근거
칩(조건 코드), 예상 소요, 담당자, 기한, "왜 올렸나" 한 줄이 붙는다. 승인 열의 카드는 자동 생성
표식과 보라 테두리(`.is-ai`)를 달고, 펼치면 서식별 초안 미리보기가 나온다. `blockedBy` 가 걸린
카드는 흐리게 처리하고 선행 카드 제목을 적는다.

**AI 패널** — `position: absolute` 로 보드 위에 뜬다. 열고 닫아도 칸반 열 너비가 바뀌지 않는다.
`Ctrl+K` 로 열고 `Esc` 로 닫으며, 닫히면 우측 하단 버튼으로 축소된다.

### 1.4 상호작용

| 동작 | 규격 |
| --- | --- |
| 카드 이동 | 포인터 드래그와 키보드 둘 다. 카드를 고른 뒤 `←` `→` 로 열을 옮기고 `↑` `↓` 로 순서를 바꾼다 |
| 승인 | 초안 미리보기에서 값을 고친 뒤 승인하면 **초안 대비 수정분이 이벤트로 남는다** |
| 기각 | 사유 입력이 필수다. 비어 있으면 대화 상자가 닫히지 않는다 |
| 승인 → Todo 끌기 | "사람이 직접 다시 쓴다"는 뜻이므로 `origin` 을 `human` 으로 바꾸고 초안은 첨부로 남긴다 |
| 이관 불가 | `delegable: false` 카드는 담당자 변경 메뉴가 비활성이고 이유를 툴팁으로 적는다 |
| 낙관적 갱신 | 이동·승인은 화면을 먼저 바꾸고 요청이 실패하면 되돌리며 토스트로 알린다 |

접근성은 열을 `role="list"`, 카드를 `role="listitem"` 에 `tabIndex={0}` 으로 두고, 이동 결과를
`aria-live="polite"` 영역에 "승인 열 두 번째로 옮겼습니다" 형태로 읽어 준다. 드래그만 되는 보드는
키보드 사용자에게 잠긴 화면이 된다.

---

## 2. 화면이 요구하는 데이터

브리핑 문단은 지어내지 않는다. 카드의 `trigger` · `invalidates` · `produces` 세 필드를 읽어
조립하므로, 화면에 문장을 넣기 전에 이 세 필드가 먼저 채워져 있어야 한다. 브리핑 여섯 칸과
필드의 대응은 아티팩트 06장 그대로다.

| 브리핑 칸 | 읽는 곳 |
| --- | --- |
| 관측 | `condition.observation` + `trigger.sourceDocRefs` |
| 대조 | `condition.comparison` + `trigger.extracted` |
| 판단 | `condition.judgement` |
| 무효화 | `card.invalidates[]` |
| 만든 것 | `card.produces[]` 를 상태별로 묶어서 |
| 불확실성 | `trigger.confidence` · `trigger.requiresHumanConfirmation` + `condition.uncertainty` |

---

## 3. 데이터 모델

`lib/board/types.ts` 는 아티팩트 06장의 JSON 을 그대로 타입으로 옮긴다. DB 컬럼은 스네이크
케이스이고 질의 계층에서 카멜 케이스로 바꾼다 — 화면은 스네이크 케이스를 보지 않는다.

```
board.sites          id · name · phase · headcount · owner_name · scope_from · scope_to
board.sources        site_id · label · last_synced_at · kind          연결된 맥락 줄
board.conditions     condition_id · site_id · code(T-03) · kind · headline · detected_at
                     · observation · comparison · judgement · uncertainty
                     · confidence · requires_human_confirmation
board.cards          item_id · site_id · condition_id? · timing · status · origin
                     · title · why · assignee · due_by · estimated_minutes · delegable
                     · lane_order · blocked_by text[] · confirmed_by · confirmed_at
                     · trigger jsonb · invalidates jsonb · produces jsonb · draft jsonb
board.card_events    event_id · card_id · type · actor · reason · diff jsonb · created_at
```

세 가지를 짚어 둔다.

**`lane_order` 는 열 안의 순서다.** 이동이 잦으므로 정수 대신 실수 간격을 쓴다. 두 카드 사이에
끼울 때 앞뒤 값의 중간값을 넣으면 다른 행을 건드리지 않는다.

**`draft` 는 jsonb 한 덩어리다.** 회의록 행·공문 본문·회의 안건·TBM 자료는 서식이 전부 달라서
공통 컬럼으로 펴면 빈칸만 늘어난다. `draft.form` 으로 갈라 화면에서 서식별 컴포넌트를 고른다.

**`card_events` 가 신뢰의 근거다.** 승인 시점에 초안과 무엇이 달라졌는지, 기각 사유가 무엇인지가
여기 쌓인다. 기획안 07장이 말하는 "어떤 항목에서 기계의 추정이 반복적으로 어긋나는가"를 나중에
집계할 자리이기도 하다.

마이그레이션은 `db/board/001_init.sql` 한 파일로 두고 `npm run db:board` 로 적용한다. ORM 도
마이그레이션 도구도 새로 들이지 않는다 — 의존성은 이미 있는 `postgres` 하나로 충분하다.

---

## 4. API 계약

```
GET   /api/board?siteId=&date=          화면 한 장에 필요한 전부를 한 번에
                                        → { site, sources, briefing, conditions[], cards[], calendar[] }
PATCH /api/board/cards/:itemId          { status?, laneOrder?, assignee? }  이동
POST  /api/board/cards/:itemId/approve  { edits? } → confirmed_by 기록 + 이벤트
POST  /api/board/cards/:itemId/reject   { reason }  사유 없으면 400
POST  /api/board/cards                  새 태스크 (사람 또는 도우미가 만든 것)
POST  /api/board/ingest                 조건 + 파생 카드 묶음 주입 ← 조율 장치가 쓸 자리
```

화면 진입에 왕복 한 번만 쓰는 이유는 브리핑·캘린더·칸반이 **같은 카드 집합의 세 가지 표현**이기
때문이다. 따로 부르면 세 화면의 숫자가 서로 어긋나는 순간이 생긴다.

`POST /api/board/ingest` 는 지금 아무도 부르지 않지만 처음부터 만들어 둔다. 조율 장치가 나중에
붙을 때 화면과 스키마를 다시 건드리지 않으려면, **주입 경계가 처음부터 하나로 좁혀져 있어야
한다.** 시드 데이터도 이 경로로 넣어 계약이 실제로 도는지 미리 확인한다.

인증은 `/api/context/*` 와 같은 상태다. 즉 **없다.** 같은 근거로 의도된 결정이지만, 보드는
담당자 이름과 하도급사 상호가 화면에 그대로 나오므로 응답에 `X-Robots-Tag: noindex` 를 붙이고
시드는 전부 가상 시나리오 값으로만 채운다.

---

## 5. AI 도우미 패널 연결

기존 `/api/chat` 은 `{ question }` **한 필드만** 받도록 `parseQuestion` 이 키 개수까지 검사한다
(`app/api/chat/route.ts`). 보드 맥락을 넘기려면 이 계약을 먼저 넓혀야 한다.

```ts
{ question: string, board?: { siteId: string, date: string, cardRefs?: string[] } }
```

`board` 가 오면 시스템 프롬프트에 현재 보드 요약(열별 카드 수, 오늘 기한, 참조된 카드의 제목과
근거)을 덧붙인다. 도구 목록은 지금의 법령 두 개를 그대로 두고, 다음 순서로 늘린다.

1. `search_site_documents` — 이미 도는 `POST /api/context/search` 를 감싼다. 법은 국가법령정보센터에서,
   현장 사실은 벡터 검색에서 가져와 **같은 답변에 나란히 인용**되면 "법적으로 빠진 서류" 류의
   질문에 양쪽 근거가 함께 붙는다.
2. `propose_board_card` — 도우미가 카드를 **제안**만 한다. 곧바로 쓰지 않고 화면에 미리보기를
   띄운 뒤 "보드에 적용"을 눌러야 `POST /api/board/cards` 가 나간다. 기계가 보드를 직접 고치면
   기획안 07장이 그은 선이 무너진다.

도구 호출 진행 표시는 `construction-console.tsx` 의 `TOOL_LABELS` 와 타임라인 렌더를 재사용한다.
새로 만들지 않는다.

---

## 6. 구현 순서

각 단계 끝에서 화면이 실제로 돌아야 하고, `npm run build` · `typecheck` · `lint` 세 개가 통과해야 한다.

| 단계 | 내용 | 끝나면 확인할 것 |
| --- | --- | --- |
| 1 | `board` 스키마 · `lib/board/types.ts` · 시드를 `POST /api/board/ingest` 로 주입 | 8월 19일 장면이 DB 에 들어가고 `GET /api/board` 가 JSON 을 돌려준다 |
| 2 | 사이드바 첫 항목 추가 · 보드 껍데기 · 헤더 · 브리핑 (읽기 전용) | 브리핑 세 건이 펼쳐지고 여섯 칸이 같은 자리에 나온다 |
| 3 | 캘린더 · 칸반 3열 · 카드와 초안 미리보기 (읽기 전용) | 아티팩트의 8/19 화면이 그대로 재현된다 |
| 4 | 이동 · 승인 · 기각 + `card_events` 기록 + 낙관적 갱신 | 새로고침해도 옮긴 자리가 유지되고 기각 사유가 남는다 |
| 5 | AI 패널 — `/api/chat` 계약 확장, 보드 요약 주입, 제안·적용 흐름 | 실제 스트리밍으로 답이 오고 제안 카드가 보드에 붙는다 |
| 6 | 다듬기 — 반응형(1440 아래), 키보드 이동, `aria-live`, 빈 상태 | 마우스 없이 카드를 옮길 수 있다 |

화면을 먼저 세우라는 요청에 따라 2·3단계가 무게 중심이다. 1단계는 그 화면에 넣을 값을 만드는
최소 작업이고, 4단계부터가 보드를 살아 있게 만드는 부분이다.

---

## 7. 아직 열려 있는 것

- **`estimatedMinutes` 의 출처.** 시드에서는 시나리오 값을 그대로 쓰지만, 조율 장치가 붙으면
  무엇을 근거로 이 숫자를 매길지 정해야 한다. 02장의 업무 부하 계산(59.6시간)이 이 값의 합이다.
- **완료 열의 7일 접기.** 기획안 05장에 규격이 있으나 시드가 하루치라 지금은 드러나지 않는다.
  감사 대응 묶음과 함께 다루는 편이 자연스럽다.
- **다중 현장.** 담당자가 두 현장을 겸임한다는 것이 문제 정의의 핵심인데, 지금 계획은 한 현장만
  그린다. 현장 전환기를 헤더에 둘지 사이드바에 둘지는 보드가 선 뒤에 정하는 편이 낫다.
