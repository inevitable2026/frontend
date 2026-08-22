import { db, toVectorLiteral } from "@/lib/context/db";
import { DOCUMENT_KINDS, type DocumentKind, type SourceGrade } from "@/lib/context/types";
import { embedQuery } from "@/lib/context/upstage-doc";

// 후보에 붙일 본문 길이. 후보 단계에서 전문을 주면 모델이 read_company_document 를 건너뛰고
// 그대로 인용해 버린다. 인용 규약이 "읽기에 성공한 것만 근거" 이므로 후보는 이 문서가
// 맞는지 고르기에 딱 필요한 만큼만 보여준다.
const SNIPPET_LENGTH = 200;

const DEFAULT_K = 8;
const MIN_K = 1;
// 30 을 넘겨봐야 4096차원 순차 스캔 비용만 늘고 모델의 선택은 나빠진다.
// search 라우트가 쓰는 상한과 같은 값으로 맞춘다.
const MAX_K = 30;

// 앞뒤 청크를 한 칸씩 붙여 읽는다. 청킹이 문장 경계를 자르기 때문에 해당 청크만 주면
// 조치사항 같은 문장이 반토막 난 채 인용된다. 두 칸 이상은 토큰만 먹고 정확도를 못 올렸다.
const NEIGHBOR_SPAN = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompanyCandidate = {
  ref: string;
  title: string;
  kind: DocumentKind;
  siteName: string;
  page: number | null;
  score: number;
  snippet: string;
  source: SourceGrade;
  citable: false;
};

export type CompanyReference = {
  documentId: string;
  seq: number;
};

export type CompanyReadResult = {
  documentId: string;
  title: string;
  kind: DocumentKind;
  siteName: string;
  page: number | null;
  seq: number;
  text: string;
  source: SourceGrade;
  url: string;
  citable: true;
};

// 지금 스키마의 document_chunks·documents 에는 출처 등급 컬럼이 없다. 시드로 넣은 문서
// 16건이 전부 합성이라 app/api/context/search/route.ts 도 같은 자리에 "합성" 리터럴을
// 박아 두었고, 여기서만 다른 값을 만들면 같은 문서가 화면과 챗봇에서 다른 등급으로 보인다.
// 실데이터가 섞이는 순간 컬럼을 추가해야 하는 자리이므로 한 곳에 모아 둔다.
// (컬럼 추가는 public 스키마 소유 레포인 tbm-check 의 몫이다.)
const SOURCE_GRADE: SourceGrade = "합성";

export function isCompanyContextConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim()) && Boolean(process.env.UPSTAGE_API_KEY?.trim());
}

function clampK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k)) return DEFAULT_K;
  return Math.min(Math.max(Math.floor(k), MIN_K), MAX_K);
}

function toSnippet(text: string): string {
  // 청크 본문에는 표를 평탄화하며 생긴 줄바꿈과 연속 공백이 많다. 그대로 자르면 200자 중
  // 절반이 공백이라 모델이 문서를 구분하지 못한다.
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > SNIPPET_LENGTH ? `${compact.slice(0, SNIPPET_LENGTH - 1)}…` : compact;
}

export async function searchCompanyContext(
  query: string,
  options?: { kind?: DocumentKind; k?: number },
): Promise<{ candidates: CompanyCandidate[]; references: Map<string, CompanyReference> }> {
  const q = query.trim();
  if (!q) throw new Error("COMPANY_QUERY_EMPTY");

  const k = clampK(options?.k);
  // 모델이 만들어 낸 kind 는 어휘 밖일 수 있다. 그때 그대로 where 에 넣으면 0건이 나와
  // "사내 문서에 없다" 는 잘못된 결론이 된다. 모르는 값은 필터를 안 건 것으로 취급한다.
  const kind = options?.kind && DOCUMENT_KINDS.includes(options.kind) ? options.kind : null;

  const vector = toVectorLiteral(await embedQuery(q));

  const sql = db();
  const rows = await sql<
    Array<{
      document_id: string;
      title: string;
      kind: DocumentKind;
      site_name: string;
      page: number | null;
      seq: number;
      text: string;
      distance: number;
    }>
  >`
    select c.document_id, d.title, c.kind, s.name as site_name, c.page, c.seq, c.text,
           (c.embedding <=> ${vector}::halfvec)::float8 as distance
      from document_chunks c
      join documents d on d.id = c.document_id
      join sites s on s.id = c.site_id
     where c.document_id is not null
       ${kind ? sql`and c.kind = ${kind}` : sql``}
     order by c.embedding <=> ${vector}::halfvec
     limit ${k}
  `;

  // 이 Map 은 호출마다 새로 만든다. 모듈 수준에 캐시를 두면 이전 요청이 만든 ref 를
  // 다음 요청이 읽을 수 있게 되어, "검색이 만든 ref 만 읽는다" 는 인용 격리가 깨진다.
  const references = new Map<string, CompanyReference>();
  const candidates: CompanyCandidate[] = rows.map((row) => {
    const ref = `${row.document_id}#${row.seq}`;
    references.set(ref, { documentId: row.document_id, seq: row.seq });
    return {
      ref,
      title: row.title,
      kind: row.kind,
      siteName: row.site_name,
      page: row.page,
      score: Number((1 - row.distance).toFixed(4)),
      snippet: toSnippet(row.text),
      source: SOURCE_GRADE,
      citable: false,
    };
  });

  return { candidates, references };
}

export async function readCompanyDocument(reference: CompanyReference): Promise<CompanyReadResult> {
  // ref 를 라우트가 Map 에서 꺼내 주더라도 여기서 다시 검증한다. 이 함수는 서버 안에서
  // 다른 경로로도 불릴 수 있고, documentId 는 그대로 SQL 파라미터가 되므로 형식이 어긋난
  // 값은 질의를 보내기 전에 끊는 편이 실패 원인을 읽기 쉽다.
  if (!UUID.test(reference.documentId)) throw new Error("COMPANY_REFERENCE_INVALID");
  if (!Number.isInteger(reference.seq) || reference.seq < 0) throw new Error("COMPANY_REFERENCE_INVALID");

  const sql = db();
  const rows = await sql<
    Array<{
      document_id: string;
      title: string;
      kind: DocumentKind;
      site_name: string;
      page: number | null;
      seq: number;
      text: string;
    }>
  >`
    select c.document_id, d.title, d.kind, s.name as site_name, c.page, c.seq, c.text
      from document_chunks c
      join documents d on d.id = c.document_id
      join sites s on s.id = d.site_id
     where c.document_id = ${reference.documentId}
       and c.seq between ${reference.seq - NEIGHBOR_SPAN} and ${reference.seq + NEIGHBOR_SPAN}
     order by c.seq
  `;

  if (rows.length === 0) throw new Error("COMPANY_DOCUMENT_NOT_FOUND");

  // 앞뒤 청크는 없어도 되지만 가운데 청크가 없으면 그 ref 는 근거가 아니다. 이웃만 붙여
  // 놓고 citable: true 를 돌려주면 모델이 엉뚱한 문단을 그 자리 인용으로 쓴다.
  const anchor = rows.find((row) => row.seq === reference.seq);
  if (!anchor) throw new Error("COMPANY_CHUNK_NOT_FOUND");

  return {
    documentId: anchor.document_id,
    title: anchor.title,
    kind: anchor.kind,
    siteName: anchor.site_name,
    page: anchor.page,
    seq: anchor.seq,
    text: rows.map((row) => row.text.trim()).filter(Boolean).join("\n\n"),
    source: SOURCE_GRADE,
    url: `/api/context/documents/${anchor.document_id}`,
    citable: true,
  };
}
