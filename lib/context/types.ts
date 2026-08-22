export type DocumentKind =
  | "하도급계약서"
  | "위험성평가표"
  | "TBM회의록"
  | "작업표준"
  | "순회점검일지"
  | "기타";

export const DOCUMENT_KINDS: DocumentKind[] = [
  "하도급계약서",
  "위험성평가표",
  "TBM회의록",
  "작업표준",
  "순회점검일지",
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
