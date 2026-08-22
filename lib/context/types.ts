export type DocumentKind =
  | "하도급계약서"
  | "위험성평가표"
  | "TBM회의록"
  | "작업표준"
  | "순회점검일지"
  | "메일"
  | "기타";

export const DOCUMENT_KINDS: DocumentKind[] = [
  "하도급계약서",
  "위험성평가표",
  "TBM회의록",
  "작업표준",
  "순회점검일지",
  "메일",
  "기타",
];

export type StageName =
  | "수신"
  | "레이아웃분석"
  | "표·서명인식"
  | "필드추출"
  | "프로젝트판정"
  | "청킹"
  | "임베딩"
  | "색인";

export const STAGE_ORDER: StageName[] = [
  "수신",
  "레이아웃분석",
  "표·서명인식",
  "필드추출",
  "프로젝트판정",
  "청킹",
  "임베딩",
  "색인",
];

export type StageStatus = "대기" | "실행중" | "완료" | "실패" | "건너뜀";

export type IngestStage = {
  이름: StageName;
  상태: StageStatus;
  시작: string | null;
  소요ms: number | null;
  산출?: unknown;
  실패사유?: string;
};

export type LayoutElement = {
  id: number;
  page: number;
  category: string;
  content: { html?: string; markdown?: string; text?: string };
  coordinates?: Array<{ x: number; y: number }>;
};

/**
 * 「필드추출」 단계 산출 안에서 **실행 진단**이 들어앉는 칸의 이름.
 *
 * 문서에서 읽어낸 값과 어떻게 읽었는지를 한 객체에 평평하게 섞으면, 그 객체를
 * `ExtractedFields` 로 받아 `documents.extracted` 에 넣는 쪽이 둘을 구분하지 못한다.
 * 실제로 `agent`·`소요ms` 가 문서 필드로 저장될 뻔했다. 한 칸에 몰아넣고 읽는 쪽이
 * 그 칸만 걷어 내게 한다.
 */
export const 실행증거키 = "실행증거" as const;

export type 실행증거 = {
  agent: string;
  체인: string;
  최종스텝: string | null;
  소요ms: number;
  캐시: boolean;
};

/** 실행 진단을 걷어 내고 문서에서 읽어낸 값만 남긴다. */
export function 필드만(산출: unknown): ExtractedFields | null {
  if (!산출 || typeof 산출 !== "object" || Array.isArray(산출)) return null;
  const { [실행증거키]: _버림, ...필드 } = 산출 as Record<string, unknown>;
  void _버림;
  return 필드 as ExtractedFields;
}

export type ExtractedFields = {
  업체명?: string | null;
  현장명?: string | null;
  공종?: string[];
  장비?: string[];
  자재?: string[];
  계약금액?: string | null;
  공사기간?: string | null;
  일자?: string | null;
  참석자?: string[];
  중점위험요인?: string | null;
  작업명?: string | null;
  보호구?: string[];
  발신자?: string | null;
  수신처?: string[];
  제목?: string | null;
  요청사항?: string | null;
  회신기한?: string | null;
};

export type SiteRecommendation = {
  siteId: string;
  code: string;
  name: string;
  confidence: number;
  reason: string;
};

export type SourceGrade = "실데이터" | "합성" | "고정";

export type Citation = {
  documentId: string;
  title: string;
  page: number;
  excerpt: string;
  score: number;
  source: SourceGrade;
};

export type IngestEvent =
  | { 종류: "단계"; 단계: IngestStage }
  | {
      종류: "완료";
      jobId: string;
      upstageCalls: number;
      청크수: number;
      추천: SiteRecommendation | null;
    }
  | { 종류: "실패"; 단계: StageName | null; 사유: string };
