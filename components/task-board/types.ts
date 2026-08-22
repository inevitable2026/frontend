// 화면이 소비하는 뷰 모델이다. 서버가 붙으면 lib/board/types.ts 의 서버 타입을 질의 계층에서
// 이 모양으로 옮겨 담는다 — 접점은 `GET /api/board` 응답을 BoardSnapshot 하나로 좁힌 지점뿐이고,
// 화면은 스네이크 케이스도 DB 컬럼도 보지 않는다.

/* ------------------------------------------------------------------ *
 * 공통 어휘
 * ------------------------------------------------------------------ */

/** 칸반 열. 진행 단계가 아니라 "지금 이 카드를 움직일 수 있는 주체"로 나뉜다. */
export type BoardColumnId = "todo" | "approval" | "done";

/** 카드가 올라온 방식. 아티팩트 06장 `timing`. */
export type CardTiming = "daily" | "schedule" | "trigger";

/** 누가 만들었는가. 아티팩트 06장 `origin`. */
export type CardOrigin = "machine" | "human";

/** 카드 왼쪽 3px 색띠. `.board-card.is-*` 로 나간다. */
export type CardTone = "alert" | "due" | "review" | "routine" | "ok";

/** 배지·태그 색. `.board-tag.is-*` · `.board-card-kind.is-*` 로 나간다. */
export type BadgeTone = "neutral" | "alert" | "due" | "routine" | "ok" | "doc";

/** 캘린더 칩과 열 머리 점의 색. 아티팩트 캘린더 범례 네 가지. */
export type MarkerTone = "alert" | "due" | "ai" | "daily";

/** 아티팩트 03장 조건 8종 + 주기 도래. 코드(T-03 · S-02)는 별도 필드로 둔다. */
export type ConditionSlug =
  | "weatherChange"
  | "feedbackPending"
  | "materialSubstitution"
  | "supervisorFeedback"
  | "nearMiss"
  | "inspectionNotice"
  | "recommendationGap"
  | "newWorker"
  | "periodicDue";

/* ------------------------------------------------------------------ *
 * 서식 있는 짧은 글
 *
 * 브리핑 dd 안에는 굵은 글씨와 식별자(mono)가 섞여 있다. HTML 문자열을 그대로
 * 밀어 넣지 않으려고 조각 배열로 받는다. 픽스처가 조각을 만들고 화면은 그리기만 한다.
 * ------------------------------------------------------------------ */

export type RichRun =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  /** 규격이나 수치처럼 그 자체로 읽히는 짧은 값. 내부 식별자는 여기 넣지 않는다. */
  | { kind: "mono"; text: string }
  /**
   * 근거 표시. 화면에는 `[1]` 같은 번호로만 나가고 내부 식별자는 드러내지 않는다.
   * 번호는 조건마다 나온 차례대로 화면이 매기므로 픽스처가 적지 않는다.
   */
  | { kind: "ref"; refId: string };

export type RichText = RichRun[];

/* ------------------------------------------------------------------ *
 * 참조 사전
 *
 * `doc_2_k3f9x1qm` 처럼 식별자만 적혀 있으면 읽는 사람은 그것이 무엇인지 모른다.
 * 근거를 따로 열어 보지 않고도 판단할 수 있어야 담당자가 보드를 신뢰하므로,
 * 식별자에 마우스를 올리면 실제 내용이 그 자리에서 뜬다.
 * ------------------------------------------------------------------ */

export type ReferenceDetail = {
  /** 사전의 열쇠. `ref` 조각의 `refId` 와 같고 화면에는 나가지 않는다. */
  refId: string;
  /** 팝오버 머리의 종류 배지. "메일" · "현장 스냅샷" · "위험성평가표" 처럼 적는다. */
  kindLabel: string;
  title: string;
  /** 발신·수신·첨부처럼 짧은 항목들. 팝오버에서 정의 목록으로 그린다. */
  meta: { term: string; value: string }[];
  /** 본문 발췌. 문단 배열이며 여기에는 다시 식별자를 넣지 않는다. */
  excerpt: string[];
  /** 출처 등급 배지. 시드 문서는 우리가 만든 것이라 "합성" 이다. */
  origin: string | null;
};

/* ------------------------------------------------------------------ *
 * 현장 헤더와 연결된 맥락 소스
 * ------------------------------------------------------------------ */

export type ContextSourceIcon = "mail" | "document" | "schedule" | "observation";

/** "연결된 맥락을 보고 있습니다" 한 줄. */
export type ContextSource = {
  id: string;
  /** "회사 메일함" */
  label: string;
  icon: ContextSourceIcon;
  /** "4분 전" · "오늘 06:00" — 지금은 저장된 문자열이다. */
  lastSyncedLabel: string;
};

export type BoardCounterKey = "condition" | "due" | "approval";

/** 헤더 카운터 한 칸. 값은 카드 목록에서 파생하므로 픽스처도 카드와 어긋나면 안 된다. */
export type BoardCounter = {
  key: BoardCounterKey;
  value: number;
  /** "조건 발생" · "오늘 기한" · "승인 대기" */
  label: string;
  tone: Extract<MarkerTone, "alert" | "due" | "ai">;
};

export type BoardWatch = {
  /** "연결된 맥락을 보고 있습니다" */
  title: string;
  sources: ContextSource[];
  /** "변경이 감지되면 초안을 만들어 승인 열에 올립니다. 확정은 담당자가 합니다." */
  footnote: string;
};

export type BoardSiteHeader = {
  siteId: string;
  /** "김포 고촌 물류센터" */
  name: string;
  /** "골조 · 4층 슬래브 선행" */
  phase: string;
  counters: BoardCounter[];
  watch: BoardWatch;
};

/* ------------------------------------------------------------------ *
 * 카드
 * ------------------------------------------------------------------ */

export type Assignee = {
  id: string;
  /** "박정우" */
  name: string;
  /** 동그란 표식에 넣는 한 글자. "박" */
  initial: string;
  /** 하도급사·타사 인원이면 참. `.board-card-who.is-sub` 로 색이 달라진다. */
  external: boolean;
};

export type TaskTag = {
  label: string;
  tone: BadgeTone;
};

/** 카드 상단 유형 배지. "조건 발생" · "기한" · "회의록" · "공문" … */
export type TaskKindBadge = {
  label: string;
  tone: BadgeTone;
};

/** "왜 올렸나" · "승인이 필요한 이유" · "왜 여기 있나" — 굵은 머리말이 카드마다 다르다. */
export type TaskRationale = {
  label: string;
  text: string;
};

/** 아티팩트 06장 `trigger`. 브리핑의 관측·대조·불확실성 칸이 여기서 나온다. */
export type CardTrigger = {
  condition: ConditionSlug;
  sourceDocRefs: string[];
  /** 추출된 값. 표시용이라 원시 타입만 담는다. */
  extracted: Record<string, string | number | boolean>;
  /** 0 ~ 1 */
  confidence: number;
  requiresHumanConfirmation: boolean;
};

/** 아티팩트 06장 `invalidates[]`. 브리핑의 무효화 칸. */
export type InvalidatedDoc = {
  docId: string;
  /** 문서 안에서 무효가 된 범위. 전체면 null. */
  scope: string | null;
  reason: string;
};

/** 아티팩트 06장 `produces[]`. 브리핑의 "만든 것" 칸 한 줄이자 칸반 카드로 가는 다리. */
export type ProducedItem = {
  form: DraftForm | "fieldCheck";
  /** 앞에 붙는 레인 칩. "승인" 또는 "Todo". */
  lane: Extract<BoardColumnId, "approval" | "todo">;
  /** 칩 오른쪽 한 줄 설명. */
  text: string;
  /** 이 산출이 실제로 올라간 카드. 브리핑에서 칸반으로 옮겨 가는 데 쓴다. */
  cardId: string | null;
};

/** 선행 카드가 승인되기 전까지 대기하는 카드. 아티팩트 06장 `blockedBy`. */
export type BlockedByRef = {
  itemId: string;
  /** 화면에 적을 선행 카드 제목. */
  title: string;
};

/* ---------------- 초안 — 서식마다 모양이 다른 판별 유니온 ---------------- */

/** 라벨과 값이 짝을 이루는 초안 한 줄. `.board-draft-row` 로 나간다. */
export type DraftRow = {
  /** "④ 위험요인" · "안건 3" · "골조" */
  label: string;
  value: string;
  /** 승인 전에 사람이 고칠 수 있는 칸인지. 고치면 초안 대비 수정분이 남는다. */
  editable: boolean;
};

type DraftBase = {
  /** 초안이 다 써졌는지. 거짓이면 미리보기 대신 사유를 적는다. */
  ready: boolean;
  /** ISO 8601. "2026-08-19T06:58:11+09:00" */
  generatedAt: string;
};

/** 회의록 행 — 위험성평가 회의록에 새로 넣을 행. */
export type RiskAssessmentRowDraft = DraftBase & {
  form: "riskAssessmentRow";
  /** 들어갈 회의록. "ra_2026_08_monthly" */
  into: string;
  /** 신규 몇 행인지. */
  rowCount: number;
  rows: DraftRow[];
};

/** 공문 — 제목과 본문 두 문단. */
export type OfficialLetterDraft = DraftBase & {
  form: "officialLetter";
  /** 수신처 표시명. "서진건설" */
  to: string;
  subject: string;
  body: string;
};

/** 회의 안건 — 안건 줄과 "물을 것" 줄. */
export type MeetingAgendaDraft = DraftBase & {
  form: "meetingAgenda";
  /** ISO 8601. "2026-08-19T14:00:00+09:00" */
  meetingAt: string;
  items: DraftRow[];
};

export type TbmTeamDraft = {
  /** "골조" · "가설" · "양중" */
  team: string;
  /** 중점위험요인 */
  focus: string;
  /** 통제 방안 */
  control: string;
};

/** TBM 자료 — 팀별 중점·통제와 구호. */
export type TbmMinutesDraft = DraftBase & {
  form: "tbmMinutes";
  /** 언제 쓰는 자료인지. "내일 06:40 사용" 같은 표시 문구가 아니라 ISO 8601. */
  useAt: string;
  teams: TbmTeamDraft[];
  /** "멈춘다 → 확인한다 → 평가한다 → 관리한다" */
  slogan: string;
};

export type TaskDraft =
  | RiskAssessmentRowDraft
  | OfficialLetterDraft
  | MeetingAgendaDraft
  | TbmMinutesDraft;

export type DraftForm = TaskDraft["form"];

/* ---------------- 카드 본체 ---------------- */

export type TaskCard = {
  /** 아티팩트 06장 `itemId`. "wi_20260818_1422" */
  itemId: string;
  siteId: string;
  /** 이 카드를 낳은 조건. 일상 업무면 null. */
  conditionId: string | null;

  timing: CardTiming;
  status: BoardColumnId;
  origin: CardOrigin;

  /** 열 안의 순서. 두 카드 사이에 끼울 때 중간값을 넣는다. */
  laneOrder: number;

  tone: CardTone;
  kind: TaskKindBadge;
  title: string;
  /** 제목 아래 설명 한두 줄. 없으면 null. */
  note: string | null;
  tags: TaskTag[];
  rationale: TaskRationale | null;

  trigger: CardTrigger | null;
  invalidates: InvalidatedDoc[];
  produces: ProducedItem[];
  draft: TaskDraft | null;

  blockedBy: BlockedByRef[];
  /** 승인 전까지 null. */
  confirmedBy: string | null;
  /** ISO 8601. 승인 전까지 null. */
  confirmedAt: string | null;

  /** ISO 8601. 캘린더 배치를 정한다. 기한이 없으면 null. */
  dueBy: string | null;
  /** 카드 오른쪽 아래 문구. "16:30" · "익일 작업 전" · "오전 중" */
  dueLabel: string | null;
  /** 참이면 기한 문구를 경고색으로 적는다. */
  dueIsHot: boolean;

  estimatedMinutes: number | null;
  assignee: Assignee | null;

  delegable: boolean;
  /** `delegable: false` 일 때 툴팁에 적을 이유. */
  delegableReason: string | null;
};

/* ------------------------------------------------------------------ *
 * 브리핑
 * ------------------------------------------------------------------ */

export type BriefingMetric = {
  key: string;
  value: number;
  /** "읽은 소스" · "새 문서" · "감지한 조건" · "만든 태스크" · "쓴 초안" · "사람 확인 필요" */
  label: string;
  tone: "neutral" | "ai";
};

/** 여섯 칸 가운데 글로 채워지는 칸의 내용. 비면 null 이고 화면은 "없습니다"를 적는다. */
export type BriefingSlot = {
  paragraphs: RichText[];
};

/**
 * 칸은 **언제나 같은 순서로** 그린다.
 * 관측 → 대조 → 판단 → 무효화 → (법적 근거) → 만든 것 → 불확실성 → (제안)
 * 여섯 칸(observation · comparison · judgement · invalidation · produced · uncertainty)은
 * 값이 없어도 자리를 지우지 않는다. legalBasis 와 suggestion 은 있을 때만 끼워 넣는다.
 */
export type BriefingSlots = {
  observation: BriefingSlot | null;
  comparison: BriefingSlot | null;
  judgement: BriefingSlot | null;
  invalidation: BriefingSlot | null;
  legalBasis: BriefingSlot | null;
  produced: ProducedItem[];
  uncertainty: BriefingSlot | null;
  suggestion: BriefingSlot | null;
};

export type BriefingCondition = {
  conditionId: string;
  /** "T-03" · "T-02" · "S-02" */
  code: string;
  /** "자재 변경" · "환류 미완" · "주기 도래" */
  kindLabel: string;
  condition: ConditionSlug;
  /** 코드 배지 색. `.board-rsn.is-alert` · `.board-rsn.is-due` */
  tone: Extract<MarkerTone, "alert" | "due">;
  /** 접힌 줄의 한 줄 요약. */
  headline: string;
  /** ISO 8601. */
  detectedAt: string;
  /** "08.18 14:22" */
  detectedAtLabel: string;
  /** "태스크 5" 의 숫자. */
  producedCount: number;
  /** 첫 진입에 펼쳐 둘지. */
  defaultOpen: boolean;
  slots: BriefingSlots;
  /** 본문 아래 회색 상자. "왜 이 순서로 붙였나" 같은 덧말. 없으면 null. */
  note: TaskRationale | null;
};

export type DailyBriefing = {
  /** "2026-08-19 (수) 07:10 · 직전 브리핑 이후 21시간 20분" */
  stampLabel: string;
  /** "감지 켜짐" */
  liveLabel: string;
  lede: RichText;
  /** 여섯 개. */
  metrics: BriefingMetric[];
  conditions: BriefingCondition[];
};

/* ------------------------------------------------------------------ *
 * 캘린더
 * ------------------------------------------------------------------ */

export type CalendarChip = {
  tone: MarkerTone;
  text: string;
};

export type CalendarDay = {
  /** "2026-08-17" */
  date: string;
  /** "월" */
  dow: string;
  dayNumber: number;
  /** 그날 전체 건수. */
  count: number;
  /** 상위 두 건. */
  chips: CalendarChip[];
  /** "+2건" 의 숫자. 0 이면 줄을 그리지 않는다. */
  moreCount: number;
  isToday: boolean;
  isWeekend: boolean;
  /** 담당자가 다른 현장에 가 있는 날. 요일 뒤에 "부재"가 붙는다. */
  isAway: boolean;
};

export type CalendarLegendItem = {
  tone: MarkerTone;
  /** "조건 발생" · "기한" · "AI 초안" · "매일" */
  label: string;
};

export type CalendarViewMode = "week" | "month";

export type BoardCalendar = {
  /** "8월 17일 – 23일" */
  rangeLabel: string;
  /** 26 */
  totalCount: number;
  /** 주간 7일. 월간은 같은 배열을 5주로 다시 그린다. */
  days: CalendarDay[];
  legend: CalendarLegendItem[];
};

/* ------------------------------------------------------------------ *
 * 칸반 열
 * ------------------------------------------------------------------ */

export type BoardColumnMeta = {
  id: BoardColumnId;
  /** "Todo" · "승인" · "완료" */
  label: string;
  /** "사람이 해야 하는 일" · "AI가 쓴 초안" · "산출물과 이행확인이 붙은 것" */
  role: string;
  tone: Extract<MarkerTone, "due" | "ai"> | "ok";
  /** 열이 비었을 때 적는 문구. "여기로 끌어다 놓기" */
  emptyMessage: string;
};

/* ------------------------------------------------------------------ *
 * 화면 한 장
 * ------------------------------------------------------------------ */

export type BoardSnapshot = {
  site: BoardSiteHeader;
  briefing: DailyBriefing;
  calendar: BoardCalendar;
  columns: BoardColumnMeta[];
  cards: TaskCard[];
  /** 식별자를 눌렀을 때 뜨는 실제 내용. 열쇠는 mono 조각의 `refId` 또는 `text`. */
  references: Record<string, ReferenceDetail>;
  /** 처음 선택된 날짜. "2026-08-19" */
  selectedDate: string;
  /** 칸반 머리의 날짜 제목. "8월 19일 수요일" */
  kanbanTitle: string;
};

/* ------------------------------------------------------------------ *
 * 상호작용 — 이번 회차는 컨테이너의 클라이언트 상태로만 처리한다.
 * 아래 세 타입이 나중에 서버 호출의 요청 본문이 된다.
 * ------------------------------------------------------------------ */

/** 카드 이동. 드래그와 키보드가 같은 모양을 만든다. */
export type CardMoveIntent = {
  itemId: string;
  from: BoardColumnId;
  to: BoardColumnId;
  /** 옮겨 놓을 자리. 열 안 0-based 순번. */
  toIndex: number;
};

/** 초안 대비 무엇이 달라졌는지. 승인 이벤트에 함께 실린다. */
export type DraftEdit = {
  /** 고친 칸을 가리키는 경로. "rows[2].value" · "body" */
  path: string;
  before: string;
  after: string;
};

export type ApproveIntent = {
  itemId: string;
  edits: DraftEdit[];
};

export type RejectIntent = {
  itemId: string;
  /** 빈 문자열이면 대화 상자가 닫히지 않는다. */
  reason: string;
};
