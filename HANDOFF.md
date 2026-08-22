# 현장 맥락 관리 인수인계 — 문서 업로드 · OCR · Vector DB

> 2026-08-22 · 사이드바 두 번째 탭(`현장 맥락 관리`)의 전부.
> 챗봇(첫 탭)은 `docs/company-chatbot-plan.md` 를 본다.

## 무엇을 만들었나

문서를 올리면 **Upstage 가 레이아웃과 필드를 읽고 → 검색 단위로 잘라 → 4096차원 벡터로
Postgres 에 넣는다.** 어느 현장 문서인지는 문서에서 뽑은 현장명으로 자동 추천하되,
사람이 고른 값이 이긴다.

```
components/site-context-panel.tsx    탭 화면 전부
lib/context/upstage-doc.ts           파싱 · 추출 · 임베딩
lib/context/chunk.ts                 청킹
lib/context/site-match.ts            현장 자동 판정
lib/context/pipeline.ts              8단계 실행기
lib/context/db.ts                    Postgres 연결
app/api/context/…                    ingest · ingest/[jobId]/stream · documents · search · sites
```

`construction-console.tsx` 는 `activeNav === 1` 일 때 `<SiteContextPanel />` 을 렌더한다.
그 한 줄 말고는 기존 화면을 건드리지 않았다.

## 지금 상태

| | |
| --- | --- |
| 빌드 / 타입 / 린트 | 통과 (`npm run build`, `npm run typecheck`, `npm run lint`) |
| 인제스트 | 실호출 통과 — 아래 "검증된 것" |
| 저장된 문서 | **16건** (현장 4 × 종류 4 · 청크 112) |
| 데모 모드 | 동작함. Upstage 호출 0회 · 저장 차단 (아래) |
| 인증 | **없다.** 의도된 결정이고 아래 위험에 적었다 |

### 검증된 것 (실호출, 2026-08-22)

```
라이브                  8/8 단계 26.5s · upstageCalls 3 · 저장 201
데모                    8/8 단계 10.4s · upstageCalls 0 · 저장 409 (거부)
                        데모 실행 후 문서함 16건 그대로 — 오염 없음
문서 목록               4종 × 4현장 정확히 분리, siteId+kind 필터 동작
검색                    "굴착 붕괴" → 토공사 현장 3문서 (0.517/0.496/0.493)
                        철골 현장으로 좁히면 토공사 청크 사라짐 — 현장 격리 확인
단계 실측               레이아웃 13.4s · 추출 12.0s · 임베딩 5.0s · 색인 7.3s
```

## 설정

```bash
cp .env.example .env.local   # DATABASE_URL · UPSTAGE_API_KEY 채운다
npm install
npm run dev
```

| 변수 | 쓰는 곳 |
| --- | --- |
| `UPSTAGE_API_KEY` | 파싱 · 추출 · 임베딩. 챗봇과 같은 키를 쓴다 |
| `DATABASE_URL` | Railway Postgres. **TCP 프록시 주소를 쓴다** — 내부 도메인은 Vercel 에서 닿지 않는다 |

**둘 다 서버 전용이다.** `NEXT_PUBLIC_` 을 붙이지 마라.

### 스키마는 여기서 만들지 않는다

테이블(`sites` · `ingest_jobs` · `document_files` · `documents` · `document_chunks`)과
`pgvector` 확장은 **`inevitable2026/tbm-check` 레포가 소유**한다. 마이그레이션도 그쪽에 있다.
이 레포는 같은 DB 를 읽고 쓰기만 하므로 ORM 도 마이그레이션 도구도 없다 — 의존성은 `postgres` 하나다.

컬럼을 바꿔야 하면 tbm-check 에서 `drizzle-kit generate` 로 만들고 `db:migrate` 를 돌린 뒤
여기 타입을 맞춰라. 여기서 `ALTER TABLE` 을 직접 치면 두 레포의 스키마 인식이 갈린다.

## 파이프라인

```
POST /api/context/ingest              file · kind · mode → { jobId }   바이트만 저장하고 즉시 반환
GET  /api/context/ingest/:jobId/stream SSE 8단계          여기서 파이프라인이 돈다
POST /api/context/documents           { jobId, siteId }  → 문서 확정. 현장이 여기서 정해진다
GET  /api/context/documents           ?siteId=&kind=&q=
GET  /api/context/sites               현장 목록 + 문서 수
POST /api/context/search              { q, siteId?, kind?, k? }
```

8단계: `수신 → 레이아웃분석 → 표·서명인식 → 필드추출 → 프로젝트판정 → 청킹 → 임베딩 → 색인`

SSE 이벤트 세 가지 (`lib/context/types.ts` 의 `IngestEvent`):

```ts
| { 종류: "단계"; 단계: IngestStage }
| { 종류: "완료"; jobId; upstageCalls; 청크수; 추천: SiteRecommendation | null }
| { 종류: "실패"; 단계: StageName | null; 사유: string }
```

`10초마다 ": ping"` 주석 줄이 섞여 오니 `data: ` 로 시작하는 줄만 파싱한다.

**`레이아웃분석` 산출의 `coordinates` 가 0~1 로 정규화된 네 꼭짓점이다.** 올린 PDF 위에 박스를
그려 "이 값이 저 자리에서 나왔다"를 보여줄 수 있다. 지금 화면은 아직 안 쓰고 있다 — 붙일 값이 있다.

## 왜 이 모양인가

**청크가 문서보다 먼저 생긴다.** `documents.site_id` 는 NOT NULL 인데 그 값을 사람이 고른다.
파이프라인은 55초 안에 끝나지만 사람이 드롭다운을 고르는 데는 그보다 오래 걸린다. 그래서 청크를
`document_id = null` 스테이징으로 넣어 두고 저장 API 가 붙인다 — 행 생성 자체가 저장 시점이라
경합 구간이 없고, 고른 값이 처음부터 그 행에 들어간다.

임베딩을 메모리에 들고 다음 요청까지 기다릴 수 없다는 것도 이유다. 서버리스에서 요청 사이에
살아남는 메모리가 없고, 저장 시점에 다시 임베딩하면 Upstage 를 두 번 부른다. **DB 가 스테이징 자리다.**

**벡터 인덱스가 없다.** pgvector 0.8 의 hnsw 상한이 `vector` 2000 / `halfvec` 4000 차원인데
Upstage 임베딩이 4096 이라 어느 쪽으로도 안 들어간다. 지금 규모에서는 순차 스캔이 충분하고
recall 도 100% 다. 느려지면 표현식 인덱스로 한 줄이면 붙는다:
`CREATE INDEX ... USING hnsw ((binary_quantize(embedding)::bit(4096)) bit_hamming_ops)`.
`bit` 의 hamming 상한이 64000 차원이라 4096 이 들어간다. **전환 신호는 행 수가 아니라 p95 지연 300ms.**

## 데모 모드

무대에서 네트워크가 흔들려도 화면이 멎지 않게 하는 경로다.

- **올린 파일은 그대로 보인다.** 미리보기는 `URL.createObjectURL` 이라 브라우저 안에서 끝난다.
- **분석 결과는 고정이다.** `lib/context/demo-fixture.json` 을 재생한다. 8단계가 순서대로 켜지고
  소요시간은 녹화값의 1/4 로 줄여 보여준다(0.3~2.6초 사이로 자른다).
- **Upstage 호출 0회.** `ingest_jobs.upstage_calls` 가 0 으로 남는다 — 브라우저 네트워크 탭으로는
  증명할 수 없다. Upstage 호출은 서버에서 나가므로 라이브 모드에서도 탭에 뜨지 않기 때문이다.
- **저장이 막힌다.** 고정 결과를 문서함에 넣으면 사실이 아닌 항목이 남는다. 저장 API 가 409 를
  주고 화면도 저장 버튼 대신 안내를 띄운다.
- 화면 상단에 데모라는 것과 무엇이 고정인지 항상 적혀 있다.

### 픽스처를 다시 녹화하려면

```bash
npm run dev
node scripts/record-demo.mjs <문서.pdf> [종류]
```

**손으로 쓰지 마라.** 라이브 실행에서 뽑아야 이벤트 형태가 라이브와 같다는 게 검증된 사실이 된다.
스크립트는 완료 이벤트가 없으면 저장하지 않고, 녹화에 쓴 잡은 지운다.
Vercel 파일시스템은 읽기 전용이라 **로컬에서만** 돈다 — 픽스처는 커밋해서 번들에 싣는다.

## 함정

시간을 태운 것들.

**① Upstage 문서 파싱은 동기 경로를 쓴다.** `POST /v1/document-digitization` 이 한 번의 요청으로
끝나고 `coordinates` 와 `category` 를 준다. Studio 에이전트 경로(`/v2/files` 업로드 → `/v2/responses`
잡 생성 → 3초 폴링, 데드라인 180초)로 가면 반나절을 태운다. 그 3단 구조가 참조 구현에 남아 있어
그대로 옮기기 쉬운데, 얻는 게 없다.

**② `EventSource` 를 쓰지 마라.** 연결이 비정상 종료되면 브라우저가 알아서 재접속하고, 그러면 새
함수 인스턴스가 파이프라인을 처음부터 돌려 청크가 두 번 들어가고 Upstage 도 두 번 불린다.
서버에 `pending → running` CAS 가드와 `(job_id, seq)` UNIQUE 를 두 겹 걸어 두긴 했지만,
지금 화면처럼 **`fetch` + `ReadableStream`** 으로 읽으면 자동 재접속 자체가 없다.

**③ `similarity()` 를 청크 검색에 쓰지 마라.** 두 문자열 **전체** 트라이그램의 Jaccard 라
300~800자 청크와 짧은 질의에서 구조적으로 0 에 수렴한다. 긴 쪽에서 잘 맞는 구간만 보려면
`word_similarity` 다. `site-match.ts` 가 짧은 현장명끼리 비교하는 건 원래 용도라 문제없다.

**④ 현장 이름이 로마자면 자동 판정이 죽는다.** `banpo-2` 같은 이름과 "반포 재건축" 같은 한국어
질의는 trigram 유사도가 **0** 이다. 실측했다 — 한글 현장을 넣기 전에는 전 현장 점수가 0.000 이었다.

**⑤ 효과 안에서 setState 를 바로 부르지 마라.** 이 레포의 eslint 가 `react-hooks/set-state-in-effect`
로 막는다. `await` 경계 뒤로 옮기고 `cancelled` 플래그를 두면 통과한다 —
`site-context-panel.tsx` 의 두 effect 가 그 형태다.

## 남은 일

- **레이아웃 박스 오버레이.** `coordinates` 는 이미 온다. PDF 미리보기 위에 겹치면
  "이 값이 저 자리에서 나왔다"가 화면에서 증명된다.
- **챗봇에 문서 검색 툴 붙이기.** `POST /api/context/search` 의 `citations[]` 가
  `documentId · title · page · excerpt · score · source` 로 나간다. 법령 툴 옆에
  `search_site_documents` 를 하나 더 다는 형태가 자연스럽다 — 법은 국가법령정보센터에서,
  현장 사실은 여기서 가져와 같은 답변에 나란히 인용하면 "법적으로 빠진 서류" 같은 질문에
  양쪽 근거가 함께 붙는다.
- **출처 배지.** 검색 결과의 `source` 가 지금 전부 `"합성"` 이다 — 시드 문서 16건은 우리가
  만든 것이다. 화면에 드러내라. 심사에서 "이거 진짜 데이터입니까" 가 반드시 나오는데,
  발표자의 구두 고지는 심사위원이 나중에 혼자 눌러 볼 때 남지 않는다.
- **Vercel 환경변수** — `DATABASE_URL` 이 아직 로컬에만 있다.
  `UPSTAGE_API_KEY` 는 **로테이트하지 마라** — SAFEGRID 백엔드가 같은 키를 읽는다.

## 알려진 위험

**`/api/context/*` 에 인증이 없다.** 문서함에 하도급계약서(계약금액·업체 상호)가 들어가는데
URL 만 알면 열린다. 해커톤 데모를 위한 의도된 결정이다. 실질 완화책은 **실제 계약서를 올리지 않는
것**이다 — 지금 들어 있는 16건은 전부 합성이다. 응답에 `X-Robots-Tag: noindex` 를 붙여 색인만
실제로 막아 뒀다(`robots.txt` 는 요청을 막지 않으므로 통제가 아니다).

**`siteId` 를 생략하면 전 현장이 나온다.** 무인증 콘솔이라 의도된 동작이지만, 현장별 화면에서
이 값을 빠뜨리면 다른 현장 문서가 섞여 뜬다.

**DB 가 남의 워크스페이스에 있다.** Railway `ysh3396's Projects` 의 `junction-risk-assessment`.
요금과 접근 권한이 팀 사정에 묶인다.
