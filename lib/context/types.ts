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

/** Studio live/document demo ingestion is pinned to these six manifest contracts. */
export const INGEST_DOCUMENT_KINDS = DOCUMENT_KINDS.filter(
  (kind): kind is Exclude<DocumentKind, "메일"> => kind !== "메일",
);

export type IngestDocumentKind = (typeof INGEST_DOCUMENT_KINDS)[number];

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

export type RawEvidenceAnchor = {
  page: number;
  elementId: string;
  sourceKey: string;
  coordinates: Array<{ x: number; y: number }> | null;
};

export type EvidenceRef = RawEvidenceAnchor & {
  evidenceId: string;
  responseId: string;
  stepName: string;
};

export type EvidenceAnchor = RawEvidenceAnchor | EvidenceRef;

export type AssessmentItem = {
  itemId: string;
  hazard: string;
  riskLevel: string | null;
  mitigationIds: string[];
  evidence: EvidenceAnchor[];
};

export type AssessmentMitigation = {
  mitigationId: string;
  assessmentItemIds: string[];
  description: string;
  status: string | null;
  evidence: EvidenceAnchor[];
};

export type WorkStep = {
  stepId: string;
  order: number;
  name: string;
  hazard: string | null;
  controls: string[];
  ppe: string[];
  evidence: EvidenceAnchor[];
};

export type Finding = {
  findingId: string;
  description: string;
  severity: string | null;
  actionIds: string[];
  evidence: EvidenceAnchor[];
};

export type PatrolAction = {
  actionId: string;
  findingIds: string[];
  description: string;
  status: string | null;
  dueDate: string | null;
  evidence: EvidenceAnchor[];
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
  발신자?: string | null;
  수신처?: string[];
  제목?: string | null;
  요청사항?: string | null;
  회신기한?: string | null;
  평가항목?: AssessmentItem[];
  저감조치?: AssessmentMitigation[];
  작업단계?: WorkStep[];
  점검일자?: string | null;
  지적사항?: Finding[];
  조치사항?: PatrolAction[];
  문서유형?: string | null;
  요약?: string | null;
  evidence?: EvidenceAnchor[];
};

export type CleanupStatus = "not_started" | "deleted" | "pending" | "failed";

export type IngestExecution = {
  mode: "studio" | "demo";
  source: SourceGrade | "recorded" | "synthetic";
  agent?: string;
  agentId?: string;
  /** Config requested under the readiness receipt; never response-attested. */
  requestedConfigId?: string;
  boundByReceipt?: { id: string; scheme: "request-config-id-v1" };
  servedConfigEchoVerified?: false;
  fingerprint?: string;
  manifestSha?: string;
  responseId?: string;
  servedIdentity?: string;
  steps?: string[];
  cleanup: CleanupStatus | "not_applicable";
  validation?: { owner: "application"; valid: boolean; issueCount: number };
  review?: {
    owner: "application";
    decision: "accepted" | "corrected" | "needs_human_review" | "rejected";
    issueCount: number;
    evidenceCount: number;
  };
  recordedAt?: string;
  selectedKind?: DocumentKind;
  networkCalls?: number;
};

export type SiteRecommendation = {
  siteId: string;
  code: string;
  name: string;
  confidence: number;
  /**
   * 이 추천을 **화면이 대신 골라도 되는지.** `CONFIDENCE_THRESHOLD` 를 넘었는지다.
   *
   * `confidence` 숫자만 내려보내면 읽는 쪽마다 임계값을 다시 정하게 되고, 실제로
   * 아무도 안 읽어서 12% 짜리 추천이 그대로 선택되고 있었다. 판정을 만든 쪽에서
   * 내린다.
   */
  충분함: boolean;
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
      execution?: IngestExecution;
      provenance?: IngestExecution;
    }
  | { 종류: "실패"; 단계: StageName | null; 사유: string; code?: string; execution?: IngestExecution };
