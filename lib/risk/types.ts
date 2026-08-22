/**
 * 위험성평가 타입 — SAFEGRID 백엔드(`backend/app/schema.py`)의 거울.
 *
 * 저쪽이 정본이므로 여기서 필드를 새로 만들지 않는다. 저쪽에 없는 값을 화면이 지어내면
 * 저장했다가 다시 읽을 때 사라져, 있는 줄 알았던 정보가 조용히 없어진다.
 *
 * 형제 탭(`lib/context/types.ts`)의 한글 필드 관례를 따른다. 다만 **SAFEGRID 와
 * 주고받는 값은 저쪽 이름 그대로** 둔다 — 경계에서 이름을 바꾸면 어느 쪽 이름인지
 * 매번 되짚어야 한다.
 */

/** 빈도 x 강도 눈금. 최대 위험도와 "높음" 기준이 매트릭스마다 다르다. */
export const MATRICES = ["4x3", "5x4", "3x3"] as const;
export type Matrix = (typeof MATRICES)[number];

/** `backend/app/schema.py` 의 MATRIX_SPEC 과 같은 값. 화면이 눈금을 그리는 데 쓴다. */
export const MATRIX_SPEC: Record<Matrix, { 빈도: number; 강도: number; 높음: number }> = {
  "4x3": { 빈도: 4, 강도: 3, 높음: 9 },
  "5x4": { 빈도: 5, 강도: 4, 높음: 15 },
  "3x3": { 빈도: 3, 강도: 3, 높음: 6 },
};

export type Risk = {
  frequency: number;
  severity: number;
  matrix: string;
  /** 서버가 계산한다. 화면에서 곱하지 않는다 — 매트릭스마다 상한이 달라 어긋난다. */
  score: number;
  level: string;
};

export type Clause = {
  article: string;
  title: string;
  body: string;
  /** 서버가 만드는 표시용 문자열(computed). 화면에서 조합하지 않는다. */
  label: string;
};

/**
 * 평가표 1행. **필드 이름은 `backend/app/schema.py` 의 `Hazard` 와 정확히 같다.**
 *
 * 여기에 `no` 같은 행 번호는 **없다.** 처음에 있을 거라 짐작하고 `no` 로 행을 찾도록
 * 짰다가, 모든 행의 `no` 가 `undefined` 라 한 행을 고치면 아홉 행이 전부 바뀌는 버그를
 * 만들었다. 행의 정체성은 배열 순서로만 정한다.
 */
export type Hazard = {
  work_type: string;
  unit_work: string;
  accident_type: string;
  hazard: string;
  before: Risk;
  controls: string[];
  after: Risk | null;
  clauses: Clause[];
  /** 조문 매칭 출처: keyword | bm25 | embedding */
  match_source: string | null;
  /** 이행확인 — 안전관리자가 현장에서 체크한다. */
  confirmed: boolean;
  owner: string | null;
};

/** 평가의 근거가 된 문서. 인제스트 결과를 버리지 않고 여기 담는다. */
export type SourceDoc = {
  filename: string;
  extracted_at: string;
  engine: string;
  fields: Record<string, unknown>;
};

export type Assessment = {
  id: string | null;
  industry: string;
  work_types: string[];
  equipment: string[];
  materials: string[];
  photos: string[];
  hazards: Hazard[];
  summary: string | null;
  method: string;
  matrix: string;
  criteria: Record<string, unknown>;
  created_at: string;
  /** 맥락 DB 대비 — 지금은 비어 있을 수 있다. 자리를 비워 두는 것이 목적이다. */
  site: string | null;
  previous_assessment_id: string | null;
  source_documents: SourceDoc[];
};

/** 문서 1건 파싱 결과. */
export type 문서분석 = {
  source: string;
  company: string | null;
  site: string | null;
  work_types: string[];
  equipment: string[];
  materials: string[];
  engine: string;
};

/** 사진 판독 결과. */
export type 사진분석 = {
  photos: string[];
  scenes: string[];
  confidence: number[];
  ppe_missing: string[];
  work_types: string[];
  equipment: string[];
  materials: string[];
  photo_findings: string[];
  engine: string;
};

/** 드롭다운의 단일 출처. 실패하면 화면이 내장 목록으로 버틴다. */
export type 어휘 = {
  industries: { value: string; label: string; badge?: string; disabled?: boolean }[];
  methods: string[];
  matrices: string[];
  equipment: string[];
  materials: string[];
  criteria: {
    occurrence_cycles: string[];
    damage_levels: string[];
    past_fatality: string[];
  };
};

/**
 * 생성 모드. 형제 탭(`site-context-panel.tsx`)과 같은 개념이다.
 *
 * 데모는 녹화한 응답을 재생한다 — 시연 중 네트워크나 예산에 기대지 않기 위해서다.
 * 다만 **문서 파싱은 데모에서도 진짜로 돈다.** 올린 PDF 가 화면에 뜨는데 분석만
 * 가짜면, 그게 어느 문서에서 나온 값인지 아무도 답할 수 없기 때문이다.
 */
export type 생성모드 = "데모" | "라이브";

/** 진행 단계 — 화면이 무엇을 기다리는 중인지 보여주는 데 쓴다. */
export const 단계순서 = ["문서 파싱", "사진 판독", "위험요인 생성", "법령 대조"] as const;
export type 단계이름 = (typeof 단계순서)[number];

export type 단계 = {
  이름: 단계이름;
  상태: "대기" | "실행중" | "완료" | "실패" | "건너뜀";
  소요: number | null;
  메모?: string;
};
