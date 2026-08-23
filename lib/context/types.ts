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

/**
 * 진행 단계 이름.
 *
 * 저장된 진행 이벤트의 키다. 값을 바꾸면 이미 기록된 작업의 단계가 사라지므로 그대로 둔다.
 * 화면에 적을 이름은 `lib/context/stage-label.ts` 의 `단계이름` 이 정한다.
 * (`프로젝트판정` 도 나머지 화면과 같이 "현장 맞추기" 로 나간다. 화면에서 부르는 말은
 * 어디서나 "현장" 이고, 여기 남은 `프로젝트` 는 저장된 값일 뿐이다.)
 */
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
  근거미확인?: 근거미확인요약;
};

/**
 * 읽어내기는 했는데 **원문에서 위치를 짚지 못한** 항목이 얼마나 되는가.
 *
 * 손으로 쓴 부분에서 생긴다. 실측: 같은 종류·같은 현장의 순회점검일지를 활자와 손글씨로
 * 각각 태우면 활자는 근거 24개가 붙고 손글씨는 0개가 붙는다. 모델이 손글씨를 **읽기는
 * 한다** — 손으로 적어 넣은 지적사항 한 줄까지 읽어서 활자본보다 한 건을 더 냈다.
 * 못 하는 것은 그것을 원문 좌표에 묶는 일이다.
 *
 * 예전에는 이런 항목이 하나라도 있으면 문서를 통째로 거절했다. 짚지 못하는 주장을 받지
 * 않겠다는 뜻이었고 그 자체는 옳다. 그런데 그 결과로 **손글씨가 든 서류를 못 쓰게 된다** —
 * 현장에서 안전관리자가 가장 읽히고 싶어 하는 바로 그 문서다.
 *
 * 그래서 버리지도, 사실인 척하지도 않는다. **화면에서 가른다.** 짚은 항목과 못 짚은
 * 항목을 따로 보이고, 못 짚은 것은 사람이 확인해야 한다고 적고, 저장할 때는 기본으로
 * 뺀다. 항목 하나하나의 표시는 `evidence.length === 0` 이 이미 지고 있다 — 이 요약은
 * 화면이 한눈에 세어 보이려고 쓴다.
 */
export type 근거미확인요약 = {
  /** 근거를 못 댄 항목 수. 0 이면 이 요약 자체를 붙이지 않는다. */
  항목수: number;
  /** 갈래별 `못 짚은 수/전체 수`. 예: `{ 지적사항: [3, 3] }` */
  갈래: Record<string, [number, number]>;
  /** 문서 전체를 가리키는 근거가 하나도 없는가. */
  문서근거없음: boolean;
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

/**
 * 이 내용이 어디에서 온 것인지.
 *
 * 값은 저장·비교에 쓰이므로 그대로 두고, 화면에 적을 말은 `출처등급표시` 가 정한다.
 */
export type SourceGrade = "실데이터" | "합성" | "고정";

/**
 * 출처 등급 → 화면에 적을 이름.
 *
 * 세 등급은 뜻이 서로 다르다. 올린 문서에서 읽은 것인지, 시연을 위해 만든 것인지,
 * 화면에 미리 적어 둔 것인지를 합치면 없는 사실을 말하게 되므로 구분을 유지한다.
 */
export const 출처등급표시: Record<SourceGrade, string> = {
  실데이터: "실제 문서",
  합성: "만들어 낸 예시",
  고정: "고정해 둔 예시",
};

/** 배지만으로 부족할 때 붙일 한 줄 설명. */
export const 출처등급설명: Record<SourceGrade, string> = {
  실데이터: "올린 문서에서 읽은 내용입니다.",
  합성: "시연을 위해 만들어 둔 예시 내용입니다.",
  고정: "화면에 미리 적어 둔 예시 내용입니다.",
};

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
