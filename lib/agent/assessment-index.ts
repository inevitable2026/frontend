import { db, toVectorLiteral } from "@/lib/context/db";
import type { SourceGrade } from "@/lib/context/types";
import { embedQuery } from "@/lib/context/upstage-doc";

/**
 * 위험성평가 색인 — 챗봇의 `search_assessments` · `read_assessment` 도구.
 *
 * `lib/agent/official-law.ts` 의 모양을 그대로 따른다. 검색은 후보만 돌려주고
 * (`citable: false`), 읽기에 성공한 것만 근거가 된다(`citable: true`).
 *
 * **다른 두 도구와 저장소가 다른 이유.** 사내 문서는 tbm-check 가 이미
 * public.document_chunks 에 임베딩까지 넣어 두어서 읽기만 하면 된다. 위험성평가만은
 * 그 저장소에 없다 — SAFEGRID(lib/risk/safegrid.ts)라는 별개 서비스의 DB 에 있고
 * 임베딩이 없다. 그래서 이 종류만 board.context_chunks 에 따로 색인한다
 * (docs/migration-board.sql [9] · scripts/index-assessments.mjs).
 *
 * **알려진 한계 — 현장 필터가 없다.** SAFEGRID 의 `GET /assessments` 는 인스턴스
 * 전체를 돌려준다(app/api/risk/list/route.ts 의 같은 주석). 따라서 이 색인에는 다른
 * 사람이 만든 평가도 섞여 있고, 검색 결과를 "우리 현장의 기록" 이라고 말하면 안 된다.
 * Assessment.site 가 채워지고 그것이 public.sites 로 이어지기 전까지는 좁힐 수단이 없다.
 */

/** board.context_chunks.source_kind 의 값. 마이그레이션 [9] 와 색인 스크립트가 공유한다. */
const SOURCE_KIND = "위험성평가";

/**
 * 이 근거의 등급.
 *
 * "실데이터" 가 아니다. 평가표의 위험요인·대책 문장은 SAFEGRID 가 모델로 만든 것이고,
 * 현장에서 실제로 이행된 기록이 아니다. 심사에서 "이거 진짜 데이터입니까" 가 나왔을 때
 * 답이 답변까지 도달해야 하므로 검색 결과와 읽기 결과 양쪽에 이 값을 싣는다.
 */
const SOURCE: SourceGrade = "합성";

/** 후보 개수. 검색 라우트(app/api/context/search)와 같은 범위로 맞춘다. */
const DEFAULT_K = 8;
const MAX_K = 30;

/** 후보 미리보기 길이. 200자를 넘기지 않는다 — 넘치면 199자 + 말줄임. */
const SNIPPET_LIMIT = 200;

export type AssessmentCandidate = {
  ref: string;
  assessmentId: string;
  title: string;
  seq: number;
  score: number;
  snippet: string;
  source: SourceGrade;
  citable: false;
};

export type AssessmentReference = { assessmentId: string; seq: number };

export type AssessmentReadResult = {
  assessmentId: string;
  title: string;
  seq: number;
  text: string;
  source: SourceGrade;
  /**
   * 이 평가가 우리 현장 것인지. 값은 늘 "확인되지 않음" 이다 — 위의 "현장 필터가 없다"
   * 를 근거 JSON 이 스스로 말하게 하는 자리다. 이 말이 없으면 종합 단계가 남이 만든
   * 평가를 "우리 현장에서는 이미 식별했습니다" 로 쓴다. source("합성")는 "진짜
   * 데이터냐" 에만 답하고 "누구의 기록이냐" 에는 답하지 못한다.
   */
  현장소속: "확인되지 않음";
  url: string;
  citable: true;
};

export function isAssessmentIndexConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.UPSTAGE_API_KEY);
}

/* --------------------------------------------------------------- 평탄화 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `Risk` 한 덩이를 한 조각으로 편다. after 는 null 일 수 있다(개선 대책이 없는 행). */
function 위험도(value: unknown): string {
  if (!isRecord(value)) return "없음";
  const 등급 = asText(value.level) || "등급미상";
  const 점수 = asText(value.score);
  const 빈도 = asText(value.frequency);
  const 강도 = asText(value.severity);
  const 눈금 = asText(value.matrix);
  const 셈 = 빈도 && 강도 ? `빈도 ${빈도}×강도 ${강도}${눈금 ? `, ${눈금}` : ""}` : "";
  return `${등급}${점수 ? ` ${점수}` : ""}${셈 ? `(${셈})` : ""}`;
}

/**
 * 조문은 `label` 만 쓴다.
 *
 * `Clause.label` 은 SAFEGRID 가 만드는 표시용 문자열이다(lib/risk/types.ts).
 * article 과 title 을 여기서 다시 조합하면 저쪽 표기와 갈라져, 화면에 보이는 근거와
 * 챗봇이 말하는 근거의 글자가 달라진다.
 */
function 조문(value: unknown): string {
  return asArray(value)
    .filter(isRecord)
    .map((clause) => asText(clause.label))
    .filter(Boolean)
    .join("; ");
}

/**
 * 평가 한 건을 검색 가능한 줄들로 편다. 색인 스크립트와 이 모듈이 공유하는 유일한 정본이다.
 *
 * 인자가 `unknown` 인 것은 스크립트가 SAFEGRID 응답을 그대로 넘기기 때문이다. 저쪽이
 * 필드를 빼먹어도 색인 전체가 죽는 대신 그 자리만 "미상" 으로 남아야 한다.
 *
 * **자연스러운 문장으로 풀지 않고 라벨을 붙인 한 줄로 만든다.** "슬래브 해체 중 붕괴가
 * 우려된다" 처럼 풀어 쓰면 사람이 실제로 던지는 질문 어휘("사고분류", "개선 후 위험도",
 * "법적 근거")가 본문에서 사라져 코사인 검색이 빗나간다. 라벨은 그 어휘를 본문에
 * 남겨 두면서 인용문으로도 그대로 읽힌다.
 *
 * 줄 앞의 'N행' 은 사람이 세는 1부터이고, 색인의 seq 는 배열 인덱스(0부터)다.
 * 둘이 1 차이 나는 것은 의도한 것이다 — seq 를 인덱스 그대로 두어야 읽기 결과로
 * `assessment.hazards[seq]` 를 되짚을 수 있다. `Hazard` 에는 행 번호 필드가 없고
 * 행의 정체성이 배열 순서뿐이라 그 대응이 유일한 연결 고리다.
 */
export function assessmentRows(assessment: unknown): string[] {
  if (!isRecord(assessment)) return [];
  return asArray(assessment.hazards)
    .filter(isRecord)
    .map((hazard, index) =>
      [
        `${index + 1}행`,
        `공종 ${asText(hazard.work_type) || "미상"}`,
        `단위작업 ${asText(hazard.unit_work) || "미상"}`,
        `사고분류 ${asText(hazard.accident_type) || "미상"}`,
        `위험요인 ${asText(hazard.hazard) || "미상"}`,
        `대책 ${asArray(hazard.controls).map(asText).filter(Boolean).join("; ") || "없음"}`,
        `개선전 위험도 ${위험도(hazard.before)}`,
        `개선후 위험도 ${위험도(hazard.after)}`,
        `법적근거 ${조문(hazard.clauses) || "없음"}`,
      ].join(" · "),
    );
}

/* ----------------------------------------------------------------- 검색 */

function clampK(k: number | undefined): number {
  return Math.min(Math.max(k ?? DEFAULT_K, 1), MAX_K);
}

function snippet(text: string): string {
  return text.length <= SNIPPET_LIMIT ? text : `${text.slice(0, SNIPPET_LIMIT - 1)}…`;
}

/**
 * 테이블이 없을 때를 빈 결과로 넘기지 않는다.
 *
 * 마이그레이션은 사람이 나중에 돌린다. 그 사이에 조용히 `[]` 를 돌려주면 챗봇이
 * "위험성평가 기록이 없습니다" 라고 답한다 — 기록은 SAFEGRID 에 멀쩡히 있는데
 * 색인만 없는 상태를, 사실이 없는 것처럼 말하게 된다. 그 거짓말이 이 도구가 만들 수
 * 있는 최악의 답이라 여기서 무엇이 없는지 정확히 말하며 실패시킨다.
 *
 * 42P01 undefined_table · 3F000 invalid_schema_name — board 스키마 자체가 없을 때다.
 */
function 색인없음(error: unknown): Error {
  const code = isRecord(error) ? asText(error.code) : "";
  if (code === "42P01" || code === "3F000") {
    return new Error(
      "위험성평가가 아직 색인되지 않았습니다. board.context_chunks 가 없습니다 — " +
        "docs/migration-board.sql 을 적용한 뒤 scripts/index-assessments.mjs 를 돌려야 합니다.",
    );
  }
  return error instanceof Error ? error : new Error("위험성평가 색인 조회에 실패했습니다.");
}

/** 표는 있는데 위험성평가가 한 줄도 없는 경우. 위와 같은 이유로 빈 결과로 넘기지 않는다. */
function 비어있음(): Error {
  return new Error(
    "위험성평가가 아직 색인되지 않았습니다. board.context_chunks 는 있지만 위험성평가가 한 건도 들어 있지 않습니다 — " +
      "scripts/index-assessments.mjs 를 돌려야 합니다.",
  );
}

export async function searchAssessments(
  query: string,
  options?: { k?: number },
): Promise<{ candidates: AssessmentCandidate[]; references: Map<string, AssessmentReference> }> {
  const k = clampK(options?.k);
  const vector = toVectorLiteral(await embedQuery(query));
  const sql = db();

  type Row = { source_id: string; title: string; seq: number; text: string; distance: number };
  let rows: Row[];
  try {
    // 정렬식과 거리식이 **같아야** 한다. app/api/context/search/route.ts 의 정본과 같은
    // 모양이다. 여기서 한쪽만 바꾸면 점수와 순서가 어긋난다.
    rows = await sql<Row[]>`
      select c.source_id, c.title, c.seq, c.text,
             (c.embedding <=> ${vector}::halfvec)::float8 as distance
        from board.context_chunks c
       where c.source_kind = ${SOURCE_KIND}
       order by c.embedding <=> ${vector}::halfvec
       limit ${k}
    `;
  } catch (error) {
    throw 색인없음(error);
  }

  // 표는 있는데 위험성평가가 한 줄도 없는 상태도 "색인되지 않았다" 다. 순차 스캔이라
  // 후보가 하나라도 있으면 반드시 k 개까지 채워지므로, 0건은 곧 비어 있다는 뜻이다.
  // 그 확인을 결과가 비었을 때만 한 번 더 물어 평소 경로에는 질의를 늘리지 않는다.
  if (rows.length === 0) {
    let 있음: Array<{ one: number }>;
    try {
      있음 = await sql<Array<{ one: number }>>`
        select 1 as one from board.context_chunks where source_kind = ${SOURCE_KIND} limit 1
      `;
    } catch (error) {
      throw 색인없음(error);
    }
    if (있음.length === 0) throw 비어있음();
  }

  const candidates: AssessmentCandidate[] = [];
  const references = new Map<string, AssessmentReference>();

  for (const row of rows) {
    // ref 는 `${assessmentId}#${seq}` 로 **짐작할 수 있는 문자열이다.** 그러므로 읽기
    // 권한을 이 문자열의 모양으로 판단하면 안 된다. 같은 요청 안에서 검색이 만든
    // 것만 읽을 수 있다는 규약은 호출하는 쪽이 이 Map 을 들고 대조해서 지킨다 —
    // 문자열을 다시 파싱해 읽으면 모델이 지어낸 ref 가 그대로 통과한다.
    const ref = `${row.source_id}#${row.seq}`;
    references.set(ref, { assessmentId: row.source_id, seq: row.seq });
    candidates.push({
      ref,
      assessmentId: row.source_id,
      title: row.title,
      seq: row.seq,
      score: Number((1 - row.distance).toFixed(4)),
      snippet: snippet(row.text),
      source: SOURCE,
      citable: false,
    });
  }

  return { candidates, references };
}

/* ----------------------------------------------------------------- 읽기 */

/**
 * 후보 한 줄을 근거로 승격한다.
 *
 * **이웃 줄을 붙이지 않는다.** 사내 문서(readCompanyDocument)는 seq-1·seq·seq+1 을
 * 이어 붙이는데, 거기서는 한 청크가 문장 중간에서 잘려 앞뒤가 있어야 뜻이 서기
 * 때문이다. 평가표는 다르다. 한 행이 그 자체로 완결된 문장이고, 이웃 행은 **다른**
 * 위험요인의 대책이다. 붙이면 인용문이 가리키는 행과 실제로 읽히는 내용이 어긋난다.
 */
export async function readAssessment(reference: AssessmentReference): Promise<AssessmentReadResult> {
  const sql = db();

  type Row = { source_id: string; title: string; seq: number; text: string };
  let rows: Row[];
  try {
    rows = await sql<Row[]>`
      select c.source_id, c.title, c.seq, c.text
        from board.context_chunks c
       where c.source_kind = ${SOURCE_KIND}
         and c.source_id = ${reference.assessmentId}
         and c.seq = ${reference.seq}
       limit 1
    `;
  } catch (error) {
    throw 색인없음(error);
  }

  const row = rows[0];
  if (!row) {
    throw new Error(
      `위험성평가 ${reference.assessmentId} 의 ${reference.seq}번 행이 색인에 없습니다.`,
    );
  }

  return {
    assessmentId: row.source_id,
    title: row.title,
    seq: row.seq,
    text: row.text,
    source: SOURCE,
    현장소속: "확인되지 않음",
    // 원본을 사람이 직접 확인하는 자리. 이 경로는 SAFEGRID 의 평가 1건 조회를 감싼다
    // (app/api/risk/[id]/route.ts). 색인이 아니라 원본을 보여 주는 것이 목적이다.
    url: `/api/risk/${reference.assessmentId}`,
    citable: true,
  };
}
