# 태스크 보드 계약

> 2026-08-22 · `lib/board/types.ts` 가 단일 진실이다. 이 문서는 그 타입을 화면 쪽 언어로
> 옮겨 적고, 라우트 다섯 개의 요청·응답을 예시로 고정한다. 화면은 이 문서만 읽고 붙일 수 있다.
> 타입과 이 문서가 어긋나면 **타입이 이긴다.**

## 0. 작명 규칙

- **시스템 필드는 영어 카멜이다.** `itemId` · `siteId` · `ruleId` · `status` · `laneOrder` · `confidence`.
- **화면이 문장으로 읽는 도메인 필드는 한국어다.** 브리핑 여섯 칸(`관측` · `대조` · `판단` ·
  `무효화` · `만든것` · `불확실성`)과 초안 서식 내부(`수신` · `본문` · `안건`)가 그렇다.
  `lib/context/types.ts` 의 `IngestStage` 와 같은 감각이다.
- **문자열 리터럴 유니온은 서식만 한국어**(`DraftForm`), 열거형 상태값은 영어다
  (`timing` · `status` · `origin`). 각 유니온에는 런타임 검증용 배열이 짝으로 있다:
  `WORK_ITEM_TIMINGS` · `WORK_ITEM_STATUS_ORDER` · `WORK_ITEM_ORIGINS` · `TRIGGER_RULE_IDS` ·
  `FACT_TYPES` · `DRAFT_FORMS`.
- DB 컬럼은 스네이크 케이스이지만 **화면은 스네이크 케이스를 보지 않는다.** 질의 계층이 바꾼다.

---

## 1. 타입 요약

### 1.1 카드 — `WorkItem`

칸반 한 장. 세 열이 공유하는 단일 스키마다.

| 필드 | 타입 | 뜻 |
| --- | --- | --- |
| `itemId` | `string` | 카드 식별자 |
| `siteId` | `string` | 현장 |
| `timing` | `"daily" \| "schedule" \| "trigger"` | 왜 생겼나 — 매일 / 주기 도래 / 조건 발생 |
| `status` | `"todo" \| "approval" \| "done"` | 칸반 열. 진행 단계가 아니라 **지금 이 카드를 움직일 수 있는 주체**다 |
| `origin` | `"machine" \| "human"` | 기계가 올렸나 사람이 적었나. `machine` + `approval` 이 보라 테두리(`.is-ai`) |
| `title` | `string` | 카드 제목 |
| `summary` | `string \| null` | "왜 올렸나" 한 줄. 아티팩트의 `why` 가 이 자리다 |
| `trigger` | `WorkItemTrigger \| null` | 근거 칩의 재료. `timing: "daily"` 카드는 `null` |
| `invalidates` | `Invalidation[]` | 이 카드가 무효화한 문서 |
| `produces` | `Produces[]` | 이 카드가 만들어 낼 산출물 |
| `draft` | `Draft \| null` | "초안 보기" 펼침 내용. 서식별 판별 유니온 |
| `confirmedBy` | `string \| null` | 확정 주체. 초안 상태에서는 항상 `null` |
| `confirmedAt` | `string \| null` | 확정 시각 (ISO8601 + 09:00) |
| `dueBy` | `string \| null` | 기한. **ISO 가 아닐 수 있다** — 3절 참고 |
| `estimatedMinutes` | `number \| null` | 예상 소요 |
| `assignee` | `string \| null` | 담당자 |
| `delegable` | `boolean` | `false` 면 담당자 변경 메뉴 비활성 + 이유 툴팁 |
| `blockedBy` | `string[]` | 선행 카드의 `itemId`. 비어 있지 않으면 흐리게 + 선행 제목 표기 |
| `laneOrder` | `number` | 열 안의 순서. **실수다** — 두 카드 사이 삽입은 앞뒤 중간값 |
| `createdAt` / `updatedAt` | `string` | |

```ts
type WorkItemTrigger = {
  ruleId: RuleId;                    // "T-03" · "S-02"
  condition: string;                 // 감지 조건을 사람 말로 적은 한 줄
  sourceDocRefs: string[];           // 원문 문서 id
  confidence: number;                // 0~1
  requiresHumanConfirmation: boolean;
};

type Invalidation = { docId: string; scope: string; reason: string };

type Produces = {
  form: DraftForm;                   // "회의록" | "공문" | "회의자료" | "TBM자료" | "점검표" | "기록"
  count?: number; into?: string; to?: string; for?: string; teams?: string[];
};
```

`RuleId` 는 `TriggerRuleId`(`"T-01"`~`"T-08"`)와 `ScheduleRuleId`(템플릿 리터럴 `` `S-${string}` ``)의
합집합이다. 주기 규칙은 아직 열거되지 않아 문자열 템플릿으로 열어 두었다.

### 1.2 초안 — `Draft`

`form` 으로 갈리는 판별 유니온이다. 화면은 `draft.form` 으로 미리보기 컴포넌트를 고른다.

```ts
type Draft =
  | { form: "회의록";   제목: string; supersedes: string | null; rows: RiskRowDraft[] }
  | { form: "공문";     수신: string; 제목: string; 본문: string; 첨부: string[] }
  | { form: "회의자료"; 제목: string; 안건: Array<{ 번호: number; 제목: string; 문항: string[] }> }
  | { form: "TBM자료";  팀: string; 항목: string[]; 통역필요인원: number }
  | { form: "점검표";   제목: string; 항목: Array<{ 확인: string; done: boolean }> }
  | { form: "기록";     제목: string; 본문: string };
```

`RiskRowDraft` 는 시나리오 8.2 의 위험 항목 JSON 을 **필드명까지 그대로** 옮긴 것이라
안쪽이 영어다(`itemId` · `process` · `hazard` · `risk.likelihood` …). 승인 시 화면이
고친 값을 `card_events.diff` 로 남길 때 이 경로 문자열(`risk.likelihood`)을 쓴다.

### 1.3 사실과 감지

```ts
type SnapshotFact = { siteId; factType: FactType; key; value: unknown; observedAt; sourceDocId: string|null; confidence };
type FactDelta    = { factType: FactType; key; before: unknown; after: unknown; observedAt; sourceDocId: string|null };
type Evidence     = { factType: FactType; key; observedAt; sourceDocId: string|null; excerpt: string };
type Detection    = { ruleId; siteId; detectedAt; confidence; evidence: Evidence[]; invalidates: Invalidation[]; produces: Produces[]; summary };
```

`FactType` 열네 개 — `weatherObservation` · `scheduleActiveTasks` · `riskAssessmentRow` ·
`tbmMinutesFeedback` · `tbmMinutesPreWorkCheck` · `tbmMinutesAttendees` · `documentExtraction` ·
`documentApprovalState` · `snapshotMaterials` · `externalReviewComment` · `nearMissReport` ·
`officialNotice` · `riskRecommendation` · `attendanceRoster`.

규칙 여덟 개는 `TriggerRule` 하나를 공유한다.

```ts
type TriggerRule = {
  id: RuleId;
  label: string;
  watches: FactType[];
  detect(input: DetectInput): Detection[];   // async 가 아니다
};
type DetectInput  = { siteId; now; deltas: FactDelta[]; facts: SnapshotFact[]; lookup: DetectLookup };
type DetectLookup = {
  fact(factType, key): SnapshotFact | null;
  factsOf(factType): SnapshotFact[];
  deltasOf(factType): FactDelta[];
  lastDetection(ruleId): Detection | null;
  daysBetween(from, to): number;
};
```

`detect` 가 동기인 것은 실수가 아니다. 감지 루프 안에서 네트워크를 부르면 규칙 여덟 개가
서로의 지연에 묶이고 같은 시각에 대해 다른 답이 나온다. 필요한 값은 호출자가 `facts` ·
`deltas` 로 먼저 채워 넣는다. **화면은 이 타입을 쓰지 않는다** — 감지 쪽 작업자용이다.

### 1.4 브리핑 — `Briefing`

```ts
type Briefing = {
  generatedAt: string; windowHours: number;
  conditionCount: number; createdCount: number; draftedCount: number;
  paragraphs: string[];        // 접힌 상태에서 읽히는 문단
  entries: BriefingEntry[];    // 펼친 근거 패널
};
type BriefingEntry = {
  ruleId; label; headline; detectedAt; createdCount; itemIds: string[];
  관측: string[]; 대조: string[]; 판단: string[]; 무효화: string[]; 만든것: string[]; 불확실성: string[];
};
```

여섯 칸은 **항상 같은 순서로, 비어도 자리를 지킨다.** 빈 배열이면 화면이 "없습니다"를 적는다.
칸이 사라지면 읽는 순서를 매번 다시 배워야 한다.

### 1.5 저장소 — `BoardStore`

`listItems` · `getItem` · `upsertItems` · `moveItem` · `rejectItem` · `listFacts` ·
`appendFacts` · `latestSnapshotAt` · `appendDetections` · `listDetections`.
전부 `Promise` 를 돌려주는 async 메서드다. **인터페이스만 있고 구현은 아직 없다.**

---

## 2. 엔드포인트

공통 규약 — `/api/context/*` 를 그대로 따른다.

- 모든 응답에 `X-Robots-Tag: noindex, nofollow`.
- 오류는 평평한 `{ "error": "..." }`. 문구는 한국어 완결 문장이고 마침표로 끝난다.
- 쓰는 상태 코드는 201 · 400 · 404 · 409 · 기본 200. 그 밖은 500 으로 던져진다.
- 목록 응답은 `{ total, items }` 처럼 카운트 + 이름 붙은 배열.

### 2.1 `GET /api/board/items?siteId=&status=&date=`

`siteId` 는 필수, `status` 와 `date` 는 선택. `date` 는 KST `'YYYY-MM-DD'` 이고 그 날짜에
기한이 걸린 카드로 좁힌다.

```jsonc
// 200
{
  "total": 11,
  "siteId": "site_gimpo_gochon_01",
  "date": "2026-08-19",
  "items": [
    {
      "itemId": "card_ra_draft_3rows",
      "siteId": "site_gimpo_gochon_01",
      "timing": "trigger",
      "status": "approval",
      "origin": "machine",
      "title": "수시 위험성평가 회의록 신규 3행",
      "summary": "위험도 점수는 제품이 확정하지 않습니다. 숫자를 고쳐 승인하면 그 차이가 이력으로 남습니다.",
      "trigger": {
        "ruleId": "T-03",
        "condition": "동바리 자재가 MAT_SYS_SHORE 에서 MAT_PIPE_SHORE 로 바뀌고, 그 자재가 붙은 task_4f_slab 이 착수 예정입니다.",
        "sourceDocRefs": ["doc_2_k3f9x1qm", "doc_5_p8w2zzt1"],
        "confidence": 0.91,
        "requiresHumanConfirmation": true
      },
      "invalidates": [
        { "docId": "ra_2026_07_regular", "scope": "4층 슬래브를 다루는 행 전체", "reason": "shoringAssumption 이 시스템동바리로 적혀 있어 전제를 잃었습니다." }
      ],
      "produces": [{ "form": "회의록", "count": 3, "into": "ra_draft_20260819" }],
      "draft": {
        "form": "회의록",
        "제목": "수시 위험성평가 회의록 (초안)",
        "supersedes": "ra_2026_07_regular",
        "rows": [
          {
            "itemId": "RI-01",
            "process": "4층 슬래브 동바리 설치",
            "hazard": "층고 8.2m 구간에서 강관동바리 4단 조립 시 좌굴에 의한 붕괴",
            "hazardClass": "붕괴·도괴",
            "currentControl": "시스템동바리 기준의 기존 설치 지침만 존재합니다.",
            "risk": { "likelihood": 3, "severity": 4, "score": 12, "level": "높음" },
            "measures": [
              { "measureId": "M-01-1", "text": "혼용 구간 전용 구조 검토서를 반입 전까지 수령하고 원청 공무팀이 검토합니다.", "type": "관리적", "owner": "user_park", "dueDate": "2026-08-23", "status": "open" }
            ],
            "residualRisk": { "likelihood": 2, "severity": 4, "score": 8, "level": "보통" },
            "legalReferences": [{ "ref": "law_2_c1v7bd", "citable": true, "note": "수시평가 실시 사유의 근거로 조회한 원문입니다." }],
            "derivedFrom": { "evidenceIds": ["ev_20260819_a"], "contextDocRefs": ["doc_2_k3f9x1qm"] }
          }
        ]
      },
      "confirmedBy": null,
      "confirmedAt": null,
      "dueBy": "2026-08-23T18:00:00+09:00",
      "estimatedMinutes": 240,
      "assignee": "user_park",
      "delegable": false,
      "blockedBy": [],
      "laneOrder": 1000,
      "createdAt": "2026-08-18T18:12:00+09:00",
      "updatedAt": "2026-08-18T18:12:00+09:00"
    }
  ]
}
```

```jsonc
// 400 — siteId 누락
{ "error": "siteId 가 필요합니다." }
// 404 — 없는 현장
{ "error": "그런 현장이 없습니다." }
```

### 2.2 `PATCH /api/board/items/[itemId]`

열 이동과 확정. 본문은 `{ status, confirmedBy?, rejectReason? }`.

```jsonc
// 요청 — 승인 열에서 완료로
{ "status": "done", "confirmedBy": "user_park" }
```
```jsonc
// 요청 — 기각. status 는 todo 로 돌아가고 사유가 필수다
{ "status": "todo", "rejectReason": "이 구간은 이미 8월 12일에 조치가 끝났습니다." }
```
```jsonc
// 200 — 갱신된 카드 한 장을 그대로 돌려준다
{ "item": { "itemId": "card_ra_draft_3rows", "status": "done", "confirmedBy": "user_park", "confirmedAt": "2026-08-19T11:20:44+09:00", "...": "나머지 필드는 2.1 과 동일" } }
```
```jsonc
// 400 — 사유 없는 기각
{ "error": "기각 사유가 필요합니다." }
// 400 — 열 값이 셋 중 하나가 아님
{ "error": "status 는 todo · approval · done 중 하나여야 합니다." }
// 404
{ "error": "그런 카드가 없습니다." }
// 409 — 이미 확정된 카드를 다시 확정
{ "error": "이미 확정된 카드입니다." }
```

기각에 사유를 강제하는 근거는 시나리오 6절의 `act_dismiss.requiresReason: true` 다.
**승인 시 초안에서 고친 값과 기각 사유는 이력으로 쌓인다** — 화면은 그 값을 보내기만 하면 된다.

### 2.3 `GET /api/board/briefing?siteId=&at=`

`at` 은 선택이며 없으면 지금이다. `windowHours` 만큼 거슬러 올라가 감지를 모은다.

```jsonc
// 200
{
  "briefing": {
    "generatedAt": "2026-08-19T08:10:00+09:00",
    "windowHours": 24,
    "conditionCount": 3,
    "createdCount": 8,
    "draftedCount": 4,
    "paragraphs": [
      "어제 오후부터 조건 세 건이 발생했고 태스크 여덟 건이 올라왔습니다. 그중 넷은 초안이 붙어 승인 열에서 기다립니다.",
      "가장 급한 것은 구조 검토서 요청 공문입니다. 자재 반입 목표일이 8월 24일이라 오늘 안에 나가야 합니다."
    ],
    "entries": [
      {
        "ruleId": "T-03",
        "label": "자재 변경",
        "headline": "4층 슬래브 동바리가 시스템동바리에서 강관동바리 혼용으로 바뀔 예정입니다.",
        "detectedAt": "2026-08-18T14:33:40+09:00",
        "createdCount": 5,
        "itemIds": ["card_ra_draft_3rows", "card_letter_structure", "card_agenda_1400", "card_tbm_3", "card_photo_3f"],
        "관측": ["서진건설 메일 1건과 첨부 PDF 11쪽을 8월 18일 14시 31분에 받았습니다.", "첨부에서 규격과 수량을 표까지 복원했습니다. (doc_2_k3f9x1qm)"],
        "대조": ["현장 스냅샷의 MAT_SYS_SHORE 가 task_4f_slab 에 붙어 있습니다.", "task_4f_slab 은 8월 24일 착수 예정이라 아직 시작되지 않았습니다."],
        "판단": ["시스템동바리를 전제로 쓴 7월 정기 평가가 이 작업을 더는 설명하지 못합니다."],
        "무효화": ["ra_2026_07_regular — 4층 슬래브를 다루는 행 전체"],
        "만든것": ["승인 대기 4건 · 할 일 1건"],
        "불확실성": ["확신도 0.91", "사람 확인이 필요합니다 — 메일이 아직 검토 단계이고 최종 승인이 나지 않았습니다."]
      },
      {
        "ruleId": "T-02",
        "label": "환류 미완",
        "headline": "야간 타설 구간 조도 건이 두 회차 연속 미조치입니다.",
        "detectedAt": "2026-08-19T06:40:00+09:00",
        "createdCount": 1,
        "itemIds": ["card_light_feedback"],
        "관측": ["8월 18일 TBM 회의록의 제기 사항이 status 미조치로 남아 있습니다."],
        "대조": ["8월 19일 회의록에서도 같은 행의 상태가 바뀌지 않았고 preWorkCheck 의 조도 항목이 done: false 입니다."],
        "판단": ["작업 전 안전조치 확인란에 확인 표시를 붙일 수 없습니다."],
        "무효화": ["tbm_20260818_pour — 작업 전 안전조치 확인란(조도)"],
        "만든것": ["할 일 1건"],
        "불확실성": ["현장 육안 확인이 선행되어야 해 초안을 만들지 않았습니다."]
      }
    ]
  }
}
```

빈 칸은 `[]` 로 온다. 화면이 "없습니다"를 대신 적는다. 필드를 생략하지 않는다.

### 2.4 `POST /api/board/detect`

감지 실행. 본문은 `{ siteId, at? }`. `at` 이 없으면 지금 시각으로 돈다.

```jsonc
// 요청
{ "siteId": "site_gimpo_gochon_01", "at": "2026-08-19T08:10:00+09:00" }
```
```jsonc
// 201
{
  "run": {
    "runId": "run_20260819_0810",
    "siteId": "site_gimpo_gochon_01",
    "startedAt": "2026-08-19T08:10:00+09:00",
    "detections": [
      {
        "ruleId": "T-03",
        "siteId": "site_gimpo_gochon_01",
        "detectedAt": "2026-08-18T14:33:40+09:00",
        "confidence": 0.91,
        "evidence": [
          { "factType": "documentExtraction", "key": "doc_2_k3f9x1qm", "observedAt": "2026-08-18T14:33:40+09:00", "sourceDocId": "doc_2_k3f9x1qm", "excerpt": "강관동바리 혼용 · 4F A~C열 1,850㎡ · 반입 목표 2026-08-24" },
          { "factType": "snapshotMaterials", "key": "MAT_SYS_SHORE", "observedAt": "2026-08-18T18:00:00+09:00", "sourceDocId": null, "excerpt": "시스템동바리 · 대일가설 · appliedTo task_4f_slab" }
        ],
        "invalidates": [{ "docId": "ra_2026_07_regular", "scope": "4층 슬래브를 다루는 행 전체", "reason": "shoringAssumption 이 시스템동바리로 적혀 있어 전제를 잃었습니다." }],
        "produces": [{ "form": "회의록", "count": 3, "into": "ra_draft_20260819" }, { "form": "공문", "to": "서진건설" }],
        "summary": "4층 슬래브 동바리가 시스템동바리에서 강관동바리 혼용으로 변경될 예정입니다."
      }
    ],
    "created": ["...WorkItem[] — 2.1 과 같은 모양"]
  }
}
```
```jsonc
// 400
{ "error": "siteId 가 필요합니다." }
{ "error": "JSON 본문이 필요합니다." }
// 409 — 같은 현장의 감지가 아직 돌고 있음
{ "error": "이 현장의 감지가 아직 진행 중입니다." }
```

같은 시각에 두 번 불러도 같은 조건으로 카드가 두 장 생기지 않는다. `upsertItems` 가 받는다.

### 2.5 `GET /api/board/week?siteId=&from=`

`from` 은 그 주의 월요일(KST `'YYYY-MM-DD'`). 응답의 `days` 는 항상 7칸이고 카드가 없는 날도
빈 배열로 자리를 지킨다. `items` 는 그 주에 걸친 카드 전부이며 `days[].itemIds` 가 이를 가리킨다.
**카드 본문을 날짜마다 중복해서 싣지 않는다** — 같은 카드 집합의 다른 표현이기 때문이다.

```jsonc
// 200
{
  "siteId": "site_gimpo_gochon_01",
  "from": "2026-08-17",
  "to": "2026-08-23",
  "days": [
    { "date": "2026-08-17", "itemIds": [], "triggerCount": 0, "dueCount": 0, "draftCount": 0 },
    { "date": "2026-08-18", "itemIds": ["card_mail_parse"], "triggerCount": 1, "dueCount": 0, "draftCount": 0 },
    { "date": "2026-08-19", "itemIds": ["card_photo_3f", "card_light_feedback", "card_verify_9rows", "card_council_1400", "card_letter_structure", "card_agenda_1400"], "triggerCount": 2, "dueCount": 4, "draftCount": 2 },
    { "date": "2026-08-20", "itemIds": ["card_tbm_3"], "triggerCount": 0, "dueCount": 1, "draftCount": 1 },
    { "date": "2026-08-21", "itemIds": [], "triggerCount": 0, "dueCount": 0, "draftCount": 0 },
    { "date": "2026-08-22", "itemIds": [], "triggerCount": 0, "dueCount": 0, "draftCount": 0 },
    { "date": "2026-08-23", "itemIds": ["card_ra_draft_3rows"], "triggerCount": 0, "dueCount": 1, "draftCount": 1 }
  ],
  "items": ["...WorkItem[] — 2.1 과 같은 모양"]
}
```
```jsonc
// 400
{ "error": "from 은 YYYY-MM-DD 형식이어야 합니다." }
```

---

## 3. 화면이 걸려 넘어질 자리

**`dueBy` 가 항상 ISO 는 아니다.** 시나리오 카드 가운데 셋은 시각이 확정되지 않아
`"2026-08-19 오전 중 (시각 미상)"` · `"2026-08-19 중 발송 (반입 2026-08-24 이전)"` 처럼
사람이 읽는 문장으로 들어온다. `new Date(item.dueBy)` 를 무조건 부르면 `Invalid Date` 가 난다.
`/^\d{4}-\d{2}-\d{2}T/` 로 먼저 갈라 ISO 인 것만 시각으로 다루고, 나머지는 문자열 그대로 적는다.
캘린더 배치는 라우트가 `days[].itemIds` 로 이미 갈라 주므로 화면이 파싱할 일이 없다.

**날짜는 KST `'YYYY-MM-DD'` 문자열로만 왕복한다.** `Date` 객체로 돌리면 UTC 로 도는 서버리스
함수에서 하루가 밀린다. tbm-check 의 `DayEntry.date` 와 같은 규칙이다.

**감지 시각과 보드 날짜가 다르다.** 조건은 8월 18일에 감지되고(`detectedAt`), 박 차장이 그것을
보는 화면은 8월 19일이다. 브리핑 항목의 `detectedAt` 이 어제인 것은 정상이다.

**`laneOrder` 는 실수다.** 두 카드 사이에 끼울 때 앞뒤 값의 중간값을 보내면 다른 행을 건드리지
않는다. 정수로 반올림하면 자리가 겹친다.

**`status` 세 열은 진행 단계가 아니다.** `todo` 는 사람이 직접 하는 일, `approval` 은 기계가
초안을 만들어 두고 사람의 확정을 기다리는 것, `done` 은 끝난 것이다. `approval` → `todo` 로
끄는 동작은 "사람이 직접 다시 쓴다"는 뜻이라 `origin` 이 `human` 으로 바뀌고 초안은 남는다.

---

## 4. 아직 없는 것

| 없는 것 | 상태 |
| --- | --- |
| `BoardStore` 구현 | 인터페이스만 있다. `lib/board/db.ts` · `queries.ts` 는 아직 파일이 없다 |
| 라우트 다섯 개 | `app/api/board/**` 가 비어 있다. 이 문서는 계약일 뿐 구현이 아니다 |
| `board` 스키마 · 마이그레이션 | `db/board/001_init.sql` 미작성. `db/` 디렉터리 자체가 없다 |
| 시드 데이터 | 8월 19일 장면이 아직 DB 에 없다 |
| 규칙 여덟 개의 `detect` | `TriggerRule` 모양만 확정되었고 구현은 별도 작업이다 |
| AI 패널 연결 | `/api/chat` 이 `{ question }` 한 필드만 받고 `parseQuestion` 이 **키 개수까지 검사**한다. `board` 를 얹으려면 그 파일을 고쳐야 하는데 이번 범위 밖이다 |
| 인증 | 없다. `/api/context/*` 와 같은 상태다. 담당자 이름과 하도급사 상호가 화면에 그대로 나오므로 `X-Robots-Tag: noindex, nofollow` 로만 막고 있다 |
| `estimatedMinutes` 의 산정 근거 | 시나리오 값을 그대로 옮겼다. 조율 장치가 붙으면 정해야 한다 |
| 완료 열 7일 접기 · 다중 현장 전환기 | 규격만 있고 데이터가 하루치·한 현장이라 지금은 드러나지 않는다 |

**화면 작업자가 지금 할 수 있는 것** — 위 응답 예시를 그대로 목 데이터로 두고 붙이면 된다.
라우트가 붙을 때 바뀌는 것은 값이지 모양이 아니다.

## 5. 계약 밖에서 걸린 것 (결정이 필요합니다)

- `npm run typecheck` 는 **기준선에서 이미 10건 실패한다**(`postgres` 타입 미해결 1건 +
  `postgres` 가 풀리지 않아 콜백 인자가 `any` 로 떨어지는 9건). `npm install` 이 막혀 있어
  이 게이트는 넘을 수 없다. 판정 기준을 "기준선과 같은 10건 외에 새 오류 없음"으로 읽어야 한다.
  `lib/board/types.ts` 는 새 오류를 만들지 않았고 `eslint` 도 통과한다.
- `board.sites` 와 tbm-check 소유 `public.sites` 는 이름이 같다. 질의는 **반드시 `board.` 로
  스키마를 한정**해야 `search_path` 에 따라 남의 테이블을 읽는 일이 없다.
- board 전용 연결을 만든다면 전역 싱글턴 이름을 `__contextSql` 과 달리 잡아야 한다(`__boardSql`).
- `BOARD_DATABASE_URL` 도입은 `.env.example` 수정을, `npm run db:board` 는 `package.json`
  수정을 부른다. 둘 다 읽기 전용이라 손대지 않았다.
