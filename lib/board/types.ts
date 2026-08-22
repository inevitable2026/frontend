export type WorkItemTiming = "daily" | "schedule" | "trigger";

export const WORK_ITEM_TIMINGS: WorkItemTiming[] = ["daily", "schedule", "trigger"];

export type WorkItemStatus = "todo" | "approval" | "done";

export const WORK_ITEM_STATUS_ORDER: WorkItemStatus[] = ["todo", "approval", "done"];

export type WorkItemOrigin = "machine" | "human";

export const WORK_ITEM_ORIGINS: WorkItemOrigin[] = ["machine", "human"];

export type TriggerRuleId =
  | "T-01"
  | "T-02"
  | "T-03"
  | "T-04"
  | "T-05"
  | "T-06"
  | "T-07"
  | "T-08";

export const TRIGGER_RULE_IDS: TriggerRuleId[] = [
  "T-01",
  "T-02",
  "T-03",
  "T-04",
  "T-05",
  "T-06",
  "T-07",
  "T-08",
];

export type ScheduleRuleId = `S-${string}`;

export type RuleId = TriggerRuleId | ScheduleRuleId;

export type FactType =
  | "weatherObservation"
  | "scheduleActiveTasks"
  | "riskAssessmentRow"
  | "tbmMinutesFeedback"
  | "tbmMinutesPreWorkCheck"
  | "tbmMinutesAttendees"
  | "documentExtraction"
  | "documentApprovalState"
  | "snapshotMaterials"
  | "externalReviewComment"
  | "nearMissReport"
  | "officialNotice"
  | "riskRecommendation"
  | "attendanceRoster";

export const FACT_TYPES: FactType[] = [
  "weatherObservation",
  "scheduleActiveTasks",
  "riskAssessmentRow",
  "tbmMinutesFeedback",
  "tbmMinutesPreWorkCheck",
  "tbmMinutesAttendees",
  "documentExtraction",
  "documentApprovalState",
  "snapshotMaterials",
  "externalReviewComment",
  "nearMissReport",
  "officialNotice",
  "riskRecommendation",
  "attendanceRoster",
];

export type DraftForm = "회의록" | "공문" | "회의자료" | "TBM자료" | "점검표" | "기록";

export const DRAFT_FORMS: DraftForm[] = ["회의록", "공문", "회의자료", "TBM자료", "점검표", "기록"];

export type WorkItemTrigger = {
  ruleId: RuleId;
  condition: string;
  sourceDocRefs: string[];
  confidence: number;
  requiresHumanConfirmation: boolean;
};

export type Invalidation = {
  docId: string;
  scope: string;
  reason: string;
};

export type Produces = {
  form: DraftForm;
  count?: number;
  into?: string;
  to?: string;
  for?: string;
  teams?: string[];
};

export type RiskScoreDraft = {
  likelihood: number;
  severity: number;
  score: number;
  level: string;
};

export type RiskMeasureDraft = {
  measureId: string;
  text: string;
  type: string;
  owner: string;
  dueDate: string;
  status: string;
};

export type RiskRowDraft = {
  itemId: string;
  process: string;
  hazard: string;
  hazardClass: string;
  currentControl: string;
  risk: RiskScoreDraft;
  measures: RiskMeasureDraft[];
  residualRisk: RiskScoreDraft;
  legalReferences: Array<{ ref: string; citable: boolean; note: string }>;
  derivedFrom: { evidenceIds: string[]; contextDocRefs: string[] };
};

export type Draft =
  | { form: "회의록"; 제목: string; supersedes: string | null; rows: RiskRowDraft[] }
  | { form: "공문"; 수신: string; 제목: string; 본문: string; 첨부: string[] }
  | { form: "회의자료"; 제목: string; 안건: Array<{ 번호: number; 제목: string; 문항: string[] }> }
  | { form: "TBM자료"; 팀: string; 항목: string[]; 통역필요인원: number }
  | { form: "점검표"; 제목: string; 항목: Array<{ 확인: string; done: boolean }> }
  | { form: "기록"; 제목: string; 본문: string };

export type WorkItem = {
  itemId: string;
  siteId: string;
  timing: WorkItemTiming;
  status: WorkItemStatus;
  origin: WorkItemOrigin;
  title: string;
  summary: string | null;
  trigger: WorkItemTrigger | null;
  invalidates: Invalidation[];
  produces: Produces[];
  draft: Draft | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  dueBy: string | null;
  estimatedMinutes: number | null;
  assignee: string | null;
  delegable: boolean;
  blockedBy: string[];
  laneOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemEventType = "created" | "moved" | "approved" | "rejected" | "edited";

/**
 * 승인 직전에 사람이 초안에서 고친 자리.
 *
 * 화면의 DraftEdit 와 같은 모양이고, WorkItemEvent.diff 로 옮길 때 이름만 바뀐다
 * (path → field · before → from · after → to). 위험도 점수는 제품이 확정하지 않고 사람이
 * 고친 차이가 이력으로 남아야 한다는 계약이 이 타입이 있는 이유다. 받을 자리가 없으면
 * 라우트가 알 수 없는 키를 조용히 버리고, 그 순간 카드에 적힌 "숫자를 고쳐 승인하면 그
 * 차이가 이력으로 남습니다" 가 거짓말이 된다.
 */
export type DraftEdit = {
  /** 고친 칸을 가리키는 경로. "rows[2].value" · "body" */
  path: string;
  before: string;
  after: string;
};

export type WorkItemEvent = {
  eventId: string;
  itemId: string;
  type: WorkItemEventType;
  actor: string;
  reason: string | null;
  diff: Array<{ field: string; from: unknown; to: unknown }>;
  createdAt: string;
};

export type SnapshotFact = {
  siteId: string;
  factType: FactType;
  key: string;
  value: unknown;
  observedAt: string;
  sourceDocId: string | null;
  confidence: number;
};

export type FactDelta = {
  factType: FactType;
  key: string;
  before: unknown;
  after: unknown;
  observedAt: string;
  sourceDocId: string | null;
};

export type Evidence = {
  factType: FactType;
  key: string;
  observedAt: string;
  sourceDocId: string | null;
  excerpt: string;
};

export type Detection = {
  ruleId: RuleId;
  siteId: string;
  detectedAt: string;
  confidence: number;
  evidence: Evidence[];
  invalidates: Invalidation[];
  produces: Produces[];
  summary: string;
};

export type DetectLookup = {
  fact(factType: FactType, key: string): SnapshotFact | null;
  factsOf(factType: FactType): SnapshotFact[];
  deltasOf(factType: FactType): FactDelta[];
  lastDetection(ruleId: RuleId): Detection | null;
  daysBetween(from: string, to: string): number;
};

export type DetectInput = {
  siteId: string;
  now: string;
  deltas: FactDelta[];
  facts: SnapshotFact[];
  lookup: DetectLookup;
};

// detect 는 동기 함수다. 감지 루프 안에서 네트워크나 DB 를 부르면 규칙 여덟 개가
// 서로의 지연에 묶이고 같은 시각에 대해 다른 답이 나온다. 필요한 값은 호출자가
// facts · deltas 로 먼저 채워 넣고, 규칙은 lookup 으로만 되짚는다.
export type TriggerRule = {
  id: RuleId;
  label: string;
  watches: FactType[];
  detect(input: DetectInput): Detection[];
};

export type DetectionRun = {
  runId: string;
  siteId: string;
  startedAt: string;
  detections: Detection[];
  created: WorkItem[];
};

export type BoardQuery = {
  siteId: string;
  status?: WorkItemStatus;
  date?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export type BoardPage = {
  total: number;
  siteId: string;
  date: string | null;
  items: WorkItem[];
};

// 여섯 칸은 비어도 필드를 지우지 않는다. 자리가 옮겨 다니면 읽는 사람이 순서를
// 매번 다시 배워야 하므로, 빈 배열은 화면에서 "없습니다"로 자리를 지킨다.
export type BriefingEntry = {
  ruleId: RuleId;
  label: string;
  headline: string;
  detectedAt: string;
  createdCount: number;
  itemIds: string[];
  관측: string[];
  대조: string[];
  판단: string[];
  무효화: string[];
  만든것: string[];
  불확실성: string[];
};

export type Briefing = {
  generatedAt: string;
  windowHours: number;
  conditionCount: number;
  createdCount: number;
  draftedCount: number;
  paragraphs: string[];
  entries: BriefingEntry[];
};

export type WeekDay = {
  date: string;
  itemIds: string[];
  triggerCount: number;
  dueCount: number;
  draftCount: number;
};

export type WeekPage = {
  siteId: string;
  from: string;
  to: string;
  days: WeekDay[];
  items: WorkItem[];
};

export type ItemPatch = {
  status: WorkItemStatus;
  confirmedBy?: string;
  rejectReason?: string;
  laneOrder?: number;
  assignee?: string | null;
};

export type BoardStore = {
  listItems(query: BoardQuery): Promise<BoardPage>;
  getItem(itemId: string): Promise<WorkItem | null>;
  upsertItems(items: WorkItem[]): Promise<WorkItem[]>;
  moveItem(itemId: string, patch: ItemPatch): Promise<WorkItem>;
  rejectItem(itemId: string, reason: string, actor: string): Promise<WorkItem>;
  listFacts(siteId: string, factType?: FactType): Promise<SnapshotFact[]>;
  appendFacts(facts: SnapshotFact[]): Promise<FactDelta[]>;
  latestSnapshotAt(siteId: string): Promise<string | null>;
  appendDetections(run: DetectionRun): Promise<void>;
  listDetections(siteId: string, since?: string): Promise<Detection[]>;
  /**
   * 초안 대비 수정분을 'edited' 이력 한 줄로 남긴다. 확정 직전에만 불린다.
   * docs/migration-board.sql 이 work_item_events 의 type 체크에 'edited' 를 미리 넣어 둔
   * 자리가 여기다.
   */
  recordDraftEdits(itemId: string, actor: string, edits: DraftEdit[]): Promise<void>;
};
