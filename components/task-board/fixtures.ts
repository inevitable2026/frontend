// 2026-08-19 (수) 김포 고촌 물류센터의 한 장면이다. 값은 기획안 아티팩트의 목업에서 그대로
// 옮겼다 — 브리핑의 설명과 칸반의 카드가 서로를 가리키므로 숫자 하나도 임의로 바꾸지 않는다.
//
// 서버가 붙으면 이 파일은 사라지고 `GET /api/board` 의 응답이 같은 자리를 채운다.
// 화면은 이 파일을 직접 읽지 않고 `./board-data` 의 loadBoard 만 부른다.

import type {
  Assignee,
  BoardCalendar,
  BoardColumnMeta,
  BoardSiteHeader,
  BoardSnapshot,
  BriefingCondition,
  BriefingSlot,
  CardTrigger,
  DailyBriefing,
  RichRun,
  RichText,
  TaskCard,
} from "./types";

/* ------------------------------------------------------------------ *
 * 서식 있는 짧은 글 — 조각을 짜는 손잡이
 * ------------------------------------------------------------------ */

const plain = (text: string): RichRun => ({ kind: "text", text });
const strong = (text: string): RichRun => ({ kind: "strong", text });
const mono = (text: string): RichRun => ({ kind: "mono", text });

/** 문단 하나짜리 칸. 아티팩트의 dd 는 모두 한 문단이다. */
const oneParagraph = (...runs: RichText): BriefingSlot => ({ paragraphs: [runs] });

/* ------------------------------------------------------------------ *
 * 되풀이되는 값
 * ------------------------------------------------------------------ */

const SITE_ID = "site_gimpo_gochon_01";

const CONDITION_T03 = "cond_t03_20260818_1422";
const CONDITION_T02 = "cond_t02_20260819_0645";
const CONDITION_S02 = "cond_s02_20260819_0600";

/** 승인 열 1번. TBM 자료가 이 카드를 기다린다. */
const CARD_MINUTES = "wi_20260818_1422";
const CARD_LETTER = "wi_20260818_1423";
const CARD_AGENDA = "wi_20260818_1424";
const CARD_TBM = "wi_20260818_1425";
const CARD_PHOTO = "wi_20260818_1426";
const CARD_LIGHTING = "wi_20260819_0645";
const CARD_CHECKMARKS = "wi_20260819_0600";
const CARD_COUNCIL = "wi_20260819_1400";
const CARD_TBM_HELD = "wi_20260819_0640";
const CARD_PERMITS = "wi_20260819_0830";
const CARD_PARSED = "wi_20260819_0652";

/** 위험도 판정이 붙어 있는 카드에 적는 이유. 아티팩트 06장의 주석 그대로. */
const NOT_DELEGABLE = "위험도 판정이 포함되어 이관할 수 없습니다";

const park = (): Assignee => ({
  id: "user_park",
  name: "박정우",
  initial: "박",
  external: false,
});

/** 아티팩트 06장 `trigger`. T-03 에서 나온 카드가 모두 같은 값을 든다. */
const materialSubstitutionTrigger = (): CardTrigger => ({
  condition: "materialSubstitution",
  sourceDocRefs: ["doc_2_k3f9x1qm"],
  extracted: {
    from: "MAT_SYS_SHORE",
    to: "MAT_PIPE_SHORE",
    scope: "4F A~C 1850sqm",
    maxHeightM: 8.2,
  },
  confidence: 0.91,
  requiresHumanConfirmation: true,
});

/* ------------------------------------------------------------------ *
 * 현장 헤더
 * ------------------------------------------------------------------ */

const site: BoardSiteHeader = {
  siteId: SITE_ID,
  name: "김포 고촌 물류센터",
  phase: "골조 · 4층 슬래브 선행",
  counters: [
    { key: "condition", value: 2, label: "조건 발생", tone: "alert" },
    { key: "due", value: 2, label: "오늘 기한", tone: "due" },
    { key: "approval", value: 4, label: "승인 대기", tone: "ai" },
  ],
  watch: {
    title: "연결된 맥락을 보고 있습니다",
    sources: [
      { id: "src_mail", label: "회사 메일함", icon: "mail", lastSyncedLabel: "4분 전" },
      { id: "src_approval", label: "전자결재 · 공무 문서", icon: "document", lastSyncedLabel: "1시간 전" },
      { id: "src_schedule", label: "공정표 · 출역 명부", icon: "schedule", lastSyncedLabel: "오늘 06:00" },
      { id: "src_observation", label: "기상 관측 · 아차사고 대장", icon: "observation", lastSyncedLabel: "오늘 06:00" },
    ],
    footnote: "변경이 감지되면 초안을 만들어 승인 열에 올립니다. 확정은 담당자가 합니다.",
  },
};

/* ------------------------------------------------------------------ *
 * 브리핑 — 조건 3건
 * ------------------------------------------------------------------ */

const conditionT03: BriefingCondition = {
  conditionId: CONDITION_T03,
  code: "T-03",
  kindLabel: "자재 변경",
  condition: "materialSubstitution",
  tone: "alert",
  headline: "4층 슬래브 동바리가 강관동바리 혼용으로 바뀔 예정입니다",
  detectedAt: "2026-08-18T14:22:00+09:00",
  detectedAtLabel: "08.18 14:22",
  producedCount: 5,
  defaultOpen: true,
  slots: {
    observation: oneParagraph(
      plain("회사 메일함에 서진건설 공무 담당자가 보낸 메일 "),
      mono("doc_2_k3f9x1qm"),
      plain(
        " 1통이 도착했습니다. 수신은 원청 공무팀이고 담당자는 참조에만 들어 있습니다. 첨부 2건, 모두 11쪽을 Document Parse로 구조 복원해 표에서 다음 값을 뽑았습니다. ",
      ),
      strong("자재 "),
      mono("MAT_PIPE_SHORE"),
      strong(", 규격 φ48.6×3.2t 4단 조립, 범위 4F A~C열 1,850㎡, 최대 층고 8.2m, 반입 목표 2026-08-24."),
    ),
    comparison: oneParagraph(
      plain("현장 스냅샷 "),
      mono("snap_gimpo_20260818"),
      plain("에는 같은 작업 "),
      mono("task_4f_slab"),
      plain("에 시스템동바리가 걸려 있습니다. 두 값이 달라 "),
      strong("자재 대체"),
      plain("로 판정했습니다."),
    ),
    judgement: oneParagraph(
      plain(
        "메일의 제목은 협의이고 본문의 근거는 임대 물량 부족과 단가 12% 인상입니다. 구매 결정처럼 보이지만 ",
      ),
      strong(
        "층고 8m를 넘는 구간에서 지지 방식이 바뀌면 수직도 관리, 수평 연결재 설치 간격, 이음부 처리, 타설 순서가 모두 달라집니다.",
      ),
      plain(" 두 방식이 만나는 경계에서는 하중 전달 경로가 불연속적으로 바뀌므로 별도 검토가 필요합니다."),
    ),
    invalidation: oneParagraph(
      plain("7월 정기 위험성평가 "),
      mono("ra_2026_07_regular"),
      plain(". 이 평가표의 "),
      mono("shoringAssumption"),
      plain("이 시스템동바리이므로, 4층 슬래브를 다루는 행 전체가 전제를 잃습니다."),
    ),
    legalBasis: oneParagraph(
      mono("search_official_law"),
      plain("로 후보 2건을 찾고 "),
      mono("read_official_law"),
      plain("로 「사업장 위험성평가에 관한 지침」 원문 조회에 성공했습니다. "),
      strong("수시평가 실시 사유에 해당할 가능성"),
      plain("이 있습니다. 조회에 실패했다면 판단을 유보하고 공식 원문 확인을 안내했을 것입니다."),
    ),
    produced: [
      {
        form: "riskAssessmentRow",
        lane: "approval",
        text: "수시 위험성평가 회의록 신규 3행 — 개선 전후 위험도와 법적 근거까지 채움",
        cardId: CARD_MINUTES,
      },
      {
        form: "officialLetter",
        lane: "approval",
        text: "구조 검토서 요청 공문 — 수신 서진건설, 반입 보류 문구 포함",
        cardId: CARD_LETTER,
      },
      {
        form: "meetingAgenda",
        lane: "approval",
        text: "오늘 14시 협의체 안건 자료 — 동바리 변경 건을 안건 3번으로",
        cardId: CARD_AGENDA,
      },
      {
        form: "tbmMinutes",
        lane: "approval",
        text: "내일 TBM 자료 3건 — 팀별 중점위험요인 선정 포함",
        cardId: CARD_TBM,
      },
      {
        form: "fieldCheck",
        lane: "todo",
        text: "3층 동일 구간 사진 촬영 — 위험도 산정의 근거가 필요함",
        cardId: CARD_PHOTO,
      },
    ],
    uncertainty: oneParagraph(
      plain("확신도 "),
      strong("0.91"),
      plain(", "),
      mono("requiresHumanConfirmation: true"),
      plain(
        ". 메일은 아직 협의 단계이고 최종 승인이 나지 않았습니다. 변경이 무산되면 초안 4건은 보류로 내려가고 사유가 기록됩니다.",
      ),
    ),
    suggestion: null,
  },
  note: {
    label: "왜 이 순서로 붙였나",
    text: "회의록 3행이 먼저 승인되어야 TBM 자료의 내용이 확정됩니다. 공문은 반입일이 24일이므로 오늘 안에 나가야 하며, 셋 가운데 가장 급합니다.",
  },
};

const conditionT02: BriefingCondition = {
  conditionId: CONDITION_T02,
  code: "T-02",
  kindLabel: "환류 미완",
  condition: "feedbackPending",
  tone: "alert",
  headline: "전일 TBM에서 나온 조도 부족 건이 아직 조치되지 않았습니다",
  detectedAt: "2026-08-19T06:45:00+09:00",
  detectedAtLabel: "08.19 06:45",
  producedCount: 1,
  defaultOpen: false,
  slots: {
    observation: oneParagraph(
      plain("8월 18일 타설 팀 TBM 회의록의 "),
      strong("불만·질문·제안"),
      plain(
        " 항목에 야간 타설 구간의 조도가 부족하다는 발언이 기록되었습니다. 오늘 06시 45분에 열린 같은 팀 회의록에서 그 항목의 상태가 ",
      ),
      strong("여전히 미조치"),
      plain("입니다."),
    ),
    // 대조할 스냅샷이 없다. 화면은 이 칸에 "없습니다"를 적는다.
    comparison: null,
    judgement: oneParagraph(
      plain("가이드가 정한 환류 조치 세 항목 가운데 "),
      strong("세 번째인 조치 결과 피드백이 끊긴 상태"),
      plain(
        "입니다. 되돌려주지 않으면 다음 회의에서 발언이 줄어들고, 발언이 줄면 이 경로로 들어오던 위험 정보 자체가 사라집니다.",
      ),
    ),
    invalidation: oneParagraph(
      plain("전일 TBM 회의록의 작업 전 안전조치 확인란. 조도 항목에 확인 표시를 붙일 수 없습니다."),
    ),
    legalBasis: null,
    produced: [
      {
        form: "fieldCheck",
        lane: "todo",
        text: "조도 조치 확인과 작업자 피드백 — 기한은 익일 작업 전",
        cardId: CARD_LIGHTING,
      },
    ],
    uncertainty: oneParagraph(
      strong("초안을 만들지 않았습니다."),
      plain(
        " 조도가 실제로 확보되었는지는 현장에서 눈으로 봐야 하고, 측정값이 없어 부족한 정도를 수치로 판단할 수 없습니다. 조도계 측정값을 함께 올려 주시면 다음부터는 임계치로 감지할 수 있습니다.",
      ),
    ),
    suggestion: null,
  },
  note: null,
};

const conditionS02: BriefingCondition = {
  conditionId: CONDITION_S02,
  code: "S-02",
  kindLabel: "주기 도래",
  condition: "periodicDue",
  tone: "due",
  headline: "8월 회의록 이행확인란에 표시가 없는 행이 9건 남아 있습니다",
  detectedAt: "2026-08-19T06:00:00+09:00",
  detectedAtLabel: "08.19 06:00",
  producedCount: 1,
  defaultOpen: false,
  slots: {
    observation: oneParagraph(
      plain("관리기간 8월 1일부터 31일까지를 대상으로 하는 회의록 "),
      mono("ra_2026_08_monthly"),
      plain("의 이행확인란을 훑었습니다. "),
      strong("등재 21행 가운데 9행이 미표시"),
      plain("이고, 이 중 4행은 개선조치 담당자가 하도급사이며 기한이 이미 지났습니다. 서진건설 2행, 한빛가설 2행입니다."),
    ),
    comparison: oneParagraph(
      plain("중간 점검 주기가 오늘 도래했습니다. "),
      mono("recurrence: { monthOf: \"2026-08\" }"),
    ),
    judgement: oneParagraph(
      plain("미표시는 두 가지 가운데 하나입니다. "),
      strong("실제로 실행되지 않았거나, 실행되었지만 기록되지 않았거나."),
      plain(
        " 둘은 완전히 다른 문제이고 구분은 사람만 할 수 있습니다. 8월 20일 아차사고 사례가 보여주듯 표시가 붙어 있어도 실제로는 실행되지 않았을 수 있으므로, 기계가 표시를 대신 채우면 안 됩니다.",
      ),
    ),
    invalidation: oneParagraph(
      plain(
        "없습니다. 다만 이 9행이 남은 채로 8월 회의록을 결재 상신하면 감사에서 지적을 받습니다. 결재 상신 예정일은 9월 2일입니다.",
      ),
    ),
    legalBasis: null,
    produced: [
      {
        form: "fieldCheck",
        lane: "todo",
        text: "이행확인 미표시 9행 판정 — 오늘 16시 30분, 90분 예상",
        cardId: CARD_CHECKMARKS,
      },
    ],
    // 아티팩트에는 불확실성 칸이 없다. 여섯 칸은 자리를 지키므로 null 로 두어 "없습니다"가 나온다.
    uncertainty: null,
    suggestion: oneParagraph(
      plain("하도급사 담당 4행은 협력사에 물어야 하므로, "),
      strong("오늘 14시 협의체 회의에서 함께 확인하면 왕복이 한 번 줄어듭니다."),
      plain(" 그래서 승인 열의 협의체 안건 자료 초안에 안건 4번으로 넣어 두었습니다."),
    ),
  },
  note: null,
};

const briefing: DailyBriefing = {
  stampLabel: "2026-08-19 (수) 07:10 · 직전 브리핑 이후 21시간 20분",
  liveLabel: "감지 켜짐",
  lede: [
    plain("어제 오전 9시 50분 이후 들어온 문서 "),
    strong("63건"),
    plain("을 읽어 "),
    strong("조건 3건"),
    plain("을 찾았고, 오늘 처리해야 할 태스크 "),
    strong("7건"),
    plain("을 올렸습니다. 이 가운데 "),
    strong("4건"),
    plain("은 문서 초안까지 써 두었으니 검토하고 승인해 주십시오."),
  ],
  metrics: [
    { key: "sources", value: 4, label: "읽은 소스", tone: "neutral" },
    { key: "documents", value: 63, label: "새 문서", tone: "neutral" },
    { key: "conditions", value: 3, label: "감지한 조건", tone: "neutral" },
    { key: "tasks", value: 7, label: "만든 태스크", tone: "neutral" },
    { key: "drafts", value: 4, label: "쓴 초안", tone: "ai" },
    { key: "confirmations", value: 2, label: "사람 확인 필요", tone: "neutral" },
  ],
  conditions: [conditionT03, conditionT02, conditionS02],
};

/* ------------------------------------------------------------------ *
 * 캘린더 — 8월 17일부터 23일까지
 * ------------------------------------------------------------------ */

const calendar: BoardCalendar = {
  rangeLabel: "8월 17일 – 23일",
  totalCount: 26,
  days: [
    {
      date: "2026-08-17",
      dow: "월",
      dayNumber: 17,
      count: 4,
      chips: [
        { tone: "alert", text: "강우 41mm · 법면 확인" },
        { tone: "daily", text: "순회점검 1회차" },
      ],
      moreCount: 2,
      isToday: false,
      isWeekend: false,
      isAway: false,
    },
    {
      date: "2026-08-18",
      dow: "화",
      dayNumber: 18,
      count: 3,
      chips: [
        { tone: "alert", text: "동바리 자재 변경" },
        { tone: "daily", text: "메일 파싱 · 근거 등록" },
      ],
      moreCount: 1,
      isToday: false,
      isWeekend: false,
      isAway: true,
    },
    {
      // 칩 2건 + 더보기 9건. 칸반의 11장과 어긋나지 않는다.
      date: "2026-08-19",
      dow: "수",
      dayNumber: 19,
      count: 11,
      chips: [
        { tone: "ai", text: "초안 4건 승인 대기" },
        { tone: "due", text: "이행확인 9행 판정" },
      ],
      moreCount: 9,
      isToday: true,
      isWeekend: false,
      isAway: false,
    },
    {
      date: "2026-08-20",
      dow: "목",
      dayNumber: 20,
      count: 5,
      chips: [
        { tone: "alert", text: "감리 보완 요구 수신" },
        { tone: "ai", text: "TBM 자료 3건" },
      ],
      moreCount: 3,
      isToday: false,
      isWeekend: false,
      isAway: true,
    },
    {
      date: "2026-08-21",
      dow: "금",
      dayNumber: 21,
      count: 6,
      chips: [
        { tone: "due", text: "월간 회의록 착수" },
        { tone: "daily", text: "합동 안전점검" },
      ],
      moreCount: 4,
      isToday: false,
      isWeekend: false,
      isAway: false,
    },
    {
      date: "2026-08-22",
      dow: "토",
      dayNumber: 22,
      count: 2,
      chips: [
        { tone: "alert", text: "위험도 판정 21건" },
        { tone: "daily", text: "순회점검 3회차" },
      ],
      moreCount: 0,
      isToday: false,
      isWeekend: true,
      isAway: false,
    },
    {
      date: "2026-08-23",
      dow: "일",
      dayNumber: 23,
      count: 0,
      chips: [{ tone: "daily", text: "작업 없음" }],
      moreCount: 0,
      isToday: false,
      isWeekend: true,
      isAway: false,
    },
  ],
  legend: [
    { tone: "alert", label: "조건 발생" },
    { tone: "due", label: "기한" },
    { tone: "ai", label: "AI 초안" },
    { tone: "daily", label: "매일" },
  ],
};

/* ------------------------------------------------------------------ *
 * 칸반 열
 * ------------------------------------------------------------------ */

const columns: BoardColumnMeta[] = [
  { id: "todo", label: "Todo", role: "사람이 해야 하는 일", tone: "due", emptyMessage: "여기로 끌어다 놓기" },
  { id: "approval", label: "승인", role: "AI가 쓴 초안", tone: "ai", emptyMessage: "여기로 끌어다 놓기" },
  { id: "done", label: "완료", role: "산출물과 이행확인이 붙은 것", tone: "ok", emptyMessage: "여기로 끌어다 놓기" },
];

/* ------------------------------------------------------------------ *
 * 카드 11장 — Todo 4 · 승인 4 · 완료 3
 *
 * `produces` 는 비워 둔다. "만든 것" 줄은 조건이 소유하고 카드는 그 줄이 가리키는 끝점이다.
 * ------------------------------------------------------------------ */

const todoCards: TaskCard[] = [
  {
    itemId: CARD_PHOTO,
    siteId: SITE_ID,
    conditionId: CONDITION_T03,
    timing: "trigger",
    status: "todo",
    origin: "machine",
    laneOrder: 10,
    tone: "alert",
    kind: { label: "조건 발생", tone: "alert" },
    title: "3층 동일 구간 동바리 사진 촬영과 근거 등록",
    note: "4층은 아직 착수 전이므로 같은 방식으로 시공된 3F B열 12~14 구간이 판단 근거가 됩니다.",
    tags: [
      { label: "T-03", tone: "alert" },
      { label: "사진 3건 예정", tone: "neutral" },
    ],
    rationale: {
      label: "왜 올렸나",
      text: "회의록 초안의 위험도를 매기려면 현재 조립 상태를 찍은 사진이 필요합니다.",
    },
    trigger: materialSubstitutionTrigger(),
    invalidates: [],
    produces: [],
    draft: null,
    blockedBy: [],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-19T12:00:00+09:00",
    dueLabel: "오전 중",
    dueIsHot: false,
    estimatedMinutes: null,
    assignee: park(),
    delegable: false,
    delegableReason: NOT_DELEGABLE,
  },
  {
    itemId: CARD_LIGHTING,
    siteId: SITE_ID,
    conditionId: CONDITION_T02,
    timing: "trigger",
    status: "todo",
    origin: "machine",
    laneOrder: 20,
    tone: "alert",
    kind: { label: "조건 발생", tone: "alert" },
    title: "야간 타설 구간 조도 조치 확인과 작업자 피드백",
    note: "이동식 후광등 추가 설치 여부를 확인하고 결과를 제기한 작업자에게 되돌려 줍니다.",
    tags: [
      { label: "T-02", tone: "alert" },
      { label: "40분", tone: "neutral" },
    ],
    rationale: {
      label: "왜 올렸나",
      text: "전일 회의록의 제기 사항이 오늘 회의까지도 조치완료로 바뀌지 않았습니다.",
    },
    // 조도는 눈으로 봐야 하는 값이라 추출된 값이 없다.
    trigger: null,
    invalidates: [],
    produces: [],
    draft: null,
    blockedBy: [],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-20T06:40:00+09:00",
    dueLabel: "익일 작업 전",
    dueIsHot: true,
    estimatedMinutes: 40,
    assignee: park(),
    delegable: true,
    delegableReason: null,
  },
  {
    itemId: CARD_CHECKMARKS,
    siteId: SITE_ID,
    conditionId: CONDITION_S02,
    timing: "schedule",
    status: "todo",
    origin: "machine",
    laneOrder: 30,
    tone: "due",
    kind: { label: "기한", tone: "due" },
    title: "8월 회의록 이행확인 미표시 9행 판정",
    note: "표시만 채우지 않고 실제 실행 여부를 확인합니다. 하도급사 담당 4행은 협의체에서 함께 묻습니다.",
    tags: [
      { label: "S-02", tone: "due" },
      { label: "90분", tone: "neutral" },
    ],
    rationale: {
      label: "왜 올렸나",
      text: "관리기간 중간 점검 주기가 오늘 도래했고, 9월 2일 결재 상신 전에 비워 둘 수 없습니다.",
    },
    trigger: null,
    invalidates: [],
    produces: [],
    draft: null,
    blockedBy: [],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-19T16:30:00+09:00",
    dueLabel: "16:30",
    dueIsHot: false,
    estimatedMinutes: 90,
    assignee: park(),
    delegable: false,
    delegableReason: NOT_DELEGABLE,
  },
  {
    itemId: CARD_COUNCIL,
    siteId: SITE_ID,
    conditionId: null,
    timing: "schedule",
    status: "todo",
    origin: "machine",
    laneOrder: 40,
    tone: "routine",
    kind: { label: "일정", tone: "routine" },
    title: "협력사 안전보건협의체 회의 진행",
    note: "협력 6사 소장이 참석합니다. 동바리 변경 건과 미표시 4행을 안건에 올립니다.",
    tags: [
      { label: "준비 40분", tone: "neutral" },
      { label: "안건 자료 승인 대기", tone: "doc" },
    ],
    rationale: null,
    trigger: null,
    invalidates: [],
    produces: [],
    draft: null,
    blockedBy: [],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-19T14:00:00+09:00",
    dueLabel: "14:00",
    dueIsHot: false,
    estimatedMinutes: 40,
    assignee: park(),
    delegable: true,
    delegableReason: null,
  },
];

const approvalCards: TaskCard[] = [
  {
    itemId: CARD_MINUTES,
    siteId: SITE_ID,
    conditionId: CONDITION_T03,
    timing: "trigger",
    status: "approval",
    origin: "machine",
    laneOrder: 10,
    tone: "review",
    kind: { label: "회의록", tone: "neutral" },
    title: "수시 위험성평가 회의록 신규 3행",
    note: null,
    tags: [
      { label: "T-03", tone: "alert" },
      { label: "회의록 3행", tone: "doc" },
      { label: "근거 3건", tone: "ok" },
    ],
    rationale: {
      label: "승인이 필요한 이유",
      text: "위험도 점수는 제품이 확정하지 않습니다. 숫자를 고쳐 승인하면 그 차이가 이력으로 남습니다.",
    },
    trigger: materialSubstitutionTrigger(),
    invalidates: [
      {
        docId: "ra_2026_07_regular",
        scope: "task_4f_slab",
        reason: "시스템동바리 전제가 성립하지 않습니다",
      },
    ],
    produces: [],
    draft: {
      form: "riskAssessmentRow",
      ready: true,
      generatedAt: "2026-08-19T06:58:11+09:00",
      into: "ra_2026_08_monthly",
      rowCount: 3,
      rows: [
        {
          label: "④ 위험요인",
          value: "층고 8.2m 구간 강관동바리 4단 조립 시 좌굴에 의한 붕괴",
          editable: false,
        },
        { label: "⑤ 개선 전", value: "빈도 3 × 강도 4 = 12 (높음)", editable: true },
        {
          label: "⑥ 대책",
          value: "혼용 구간 전용 구조 검토서 수령 후 반입 / 수평연결재를 2단마다 설치하고 사진으로 기록",
          editable: false,
        },
        { label: "⑦ 개선 후", value: "빈도 2 × 강도 4 = 8 (보통)", editable: true },
        { label: "⑧ 근거", value: "원문 조회에 성공한 조문만 인용했습니다", editable: false },
        { label: "⑩ 이행확인", value: "비어 있습니다 — 승인 시점에 사람이 채웁니다", editable: false },
      ],
    },
    blockedBy: [],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-23T18:00:00+09:00",
    dueLabel: null,
    dueIsHot: false,
    estimatedMinutes: 240,
    assignee: park(),
    delegable: false,
    delegableReason: NOT_DELEGABLE,
  },
  {
    itemId: CARD_LETTER,
    siteId: SITE_ID,
    conditionId: CONDITION_T03,
    timing: "trigger",
    status: "approval",
    origin: "machine",
    laneOrder: 20,
    tone: "alert",
    kind: { label: "공문", tone: "alert" },
    title: "구조 검토서 요청 공문",
    note: null,
    tags: [
      { label: "반입까지 5일", tone: "alert" },
      { label: "수신 서진건설", tone: "neutral" },
    ],
    rationale: {
      label: "승인이 필요한 이유",
      text: "하도급사로 나가는 공문이며 반입 보류라는 계약상 효력이 따라옵니다.",
    },
    trigger: materialSubstitutionTrigger(),
    invalidates: [],
    produces: [],
    draft: {
      form: "officialLetter",
      ready: true,
      generatedAt: "2026-08-19T06:58:24+09:00",
      to: "서진건설",
      subject: "4층 슬래브 동바리 혼용 시공에 따른 구조 검토서 제출 요청",
      body: "귀사가 8월 18일 협의 요청한 강관동바리 혼용 구간(4F A~C열, 1,850㎡, 최대 층고 8.2m)에 대하여, 자재 반입 예정일인 8월 24일 이전까지 구조 검토서를 제출하여 주시기 바랍니다. 검토서 수령 전까지 해당 구간의 자재 반입과 설치를 보류합니다.",
    },
    blockedBy: [],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-19T18:00:00+09:00",
    dueLabel: null,
    dueIsHot: false,
    estimatedMinutes: null,
    assignee: park(),
    delegable: true,
    delegableReason: null,
  },
  {
    itemId: CARD_AGENDA,
    siteId: SITE_ID,
    conditionId: CONDITION_T03,
    timing: "trigger",
    status: "approval",
    origin: "machine",
    laneOrder: 30,
    tone: "due",
    kind: { label: "회의 자료", tone: "due" },
    title: "오늘 14시 협의체 안건 자료",
    note: null,
    tags: [
      { label: "6시간 남음", tone: "due" },
      { label: "안건 4건", tone: "doc" },
    ],
    rationale: {
      label: "승인이 필요한 이유",
      text: "회의 자리에서 협력사에 직접 묻는 문항입니다. 표현이 관계에 영향을 줍니다.",
    },
    trigger: materialSubstitutionTrigger(),
    invalidates: [],
    produces: [],
    draft: {
      form: "meetingAgenda",
      ready: true,
      generatedAt: "2026-08-19T06:58:39+09:00",
      meetingAt: "2026-08-19T14:00:00+09:00",
      items: [
        {
          label: "안건 3",
          value: "4층 슬래브 동바리 혼용 시공 — 근로자 대표 의견 청취",
          editable: true,
        },
        {
          label: "안건 4",
          value: "8월 회의록 이행확인 미표시 4행 — 서진건설 2행, 한빛가설 2행 실행 여부 확인",
          editable: true,
        },
        {
          label: "물을 것",
          value: "혼용 경계 구간에 별도 관리자를 지정할 계획이 있는지 / 수평연결재 설치 사진이 남아 있는지",
          editable: true,
        },
      ],
    },
    blockedBy: [],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-19T14:00:00+09:00",
    dueLabel: null,
    dueIsHot: false,
    estimatedMinutes: null,
    assignee: park(),
    delegable: true,
    delegableReason: null,
  },
  {
    itemId: CARD_TBM,
    siteId: SITE_ID,
    conditionId: CONDITION_T03,
    timing: "trigger",
    status: "approval",
    origin: "machine",
    laneOrder: 40,
    tone: "routine",
    kind: { label: "TBM", tone: "routine" },
    title: "내일 TBM 자료 3건 · 골조 · 가설 · 양중",
    note: null,
    tags: [
      { label: "내일 06:40 사용", tone: "neutral" },
      { label: "통역 4명", tone: "alert" },
    ],
    rationale: {
      label: "승인이 필요한 이유",
      text: "위 회의록 3행이 먼저 승인되어야 내용이 확정됩니다. 순서가 걸려 있습니다.",
    },
    trigger: materialSubstitutionTrigger(),
    invalidates: [],
    produces: [],
    draft: {
      form: "tbmMinutes",
      ready: true,
      generatedAt: "2026-08-19T06:58:52+09:00",
      useAt: "2026-08-20T06:40:00+09:00",
      teams: [
        {
          team: "골조",
          focus: "좌굴에 의한 동바리 붕괴",
          control: "구조 검토서 수령 전 반입 보류",
        },
        {
          team: "가설",
          focus: "경계 구간 국부 침하",
          control: "경계 1.5m를 시스템동바리로 통일",
        },
        {
          team: "양중",
          focus: "자재 양중 시 하부 통행",
          control: "신호수 배치와 우회 통로 지정",
        },
      ],
      slogan: "멈춘다 → 확인한다 → 평가한다 → 관리한다",
    },
    blockedBy: [{ itemId: CARD_MINUTES, title: "수시 위험성평가 회의록 신규 3행" }],
    confirmedBy: null,
    confirmedAt: null,
    dueBy: "2026-08-20T06:40:00+09:00",
    dueLabel: null,
    dueIsHot: false,
    estimatedMinutes: null,
    assignee: park(),
    delegable: true,
    delegableReason: null,
  },
];

const doneCards: TaskCard[] = [
  {
    itemId: CARD_TBM_HELD,
    siteId: SITE_ID,
    conditionId: null,
    timing: "daily",
    status: "done",
    origin: "machine",
    laneOrder: 10,
    tone: "ok",
    kind: { label: "매일", tone: "ok" },
    title: "오늘 TBM 3개 팀 실시",
    note: null,
    tags: [
      { label: "참석 24 / 미참 2", tone: "ok" },
      { label: "미참자 개별 전달 완료", tone: "neutral" },
    ],
    rationale: null,
    trigger: null,
    invalidates: [],
    produces: [],
    draft: null,
    blockedBy: [],
    confirmedBy: "각 팀 반장",
    confirmedAt: "2026-08-19T07:10:00+09:00",
    dueBy: null,
    dueLabel: "07:10 종료",
    dueIsHot: false,
    estimatedMinutes: null,
    assignee: { id: "user_team_leads", name: "각 팀 반장", initial: "이", external: true },
    delegable: true,
    delegableReason: null,
  },
  {
    itemId: CARD_PERMITS,
    siteId: SITE_ID,
    conditionId: null,
    timing: "daily",
    status: "done",
    origin: "machine",
    laneOrder: 20,
    tone: "ok",
    kind: { label: "매일", tone: "ok" },
    title: "작업허가서 5건 검토와 발급",
    note: null,
    tags: [{ label: "고소 3 · 화기 1 · 중량물 1", tone: "neutral" }],
    rationale: null,
    trigger: null,
    invalidates: [],
    produces: [],
    draft: null,
    blockedBy: [],
    confirmedBy: "박정우",
    confirmedAt: "2026-08-19T08:30:00+09:00",
    dueBy: null,
    dueLabel: "08:30",
    dueIsHot: false,
    estimatedMinutes: null,
    assignee: park(),
    delegable: true,
    delegableReason: null,
  },
  {
    itemId: CARD_PARSED,
    siteId: SITE_ID,
    conditionId: CONDITION_T03,
    timing: "trigger",
    status: "done",
    origin: "machine",
    laneOrder: 30,
    tone: "ok",
    kind: { label: "자동", tone: "ok" },
    title: "동바리 변경 메일 파싱과 근거 등록",
    note: "첨부 11쪽에서 규격과 수량을 표까지 복원했습니다. 원문 조회에 성공해 인용 가능한 상태입니다.",
    tags: [
      { label: "doc_2_k3f9x1qm", tone: "doc" },
      { label: "citable", tone: "ok" },
    ],
    rationale: {
      label: "왜 여기 있나",
      text: "사람의 판단이 필요 없는 단계입니다. 승인을 거치지 않고 바로 완료로 들어옵니다.",
    },
    trigger: materialSubstitutionTrigger(),
    invalidates: [],
    produces: [],
    draft: null,
    blockedBy: [],
    // 담당자가 없다. 카드 발치에는 confirmedBy 의 "시스템"이 나간다.
    confirmedBy: "시스템",
    confirmedAt: "2026-08-19T06:52:00+09:00",
    dueBy: null,
    dueLabel: "06:52",
    dueIsHot: false,
    estimatedMinutes: null,
    assignee: null,
    delegable: true,
    delegableReason: null,
  },
];

/* ------------------------------------------------------------------ *
 * 화면 한 장
 * ------------------------------------------------------------------ */

export const BOARD_SNAPSHOT: BoardSnapshot = {
  site,
  briefing,
  calendar,
  columns,
  cards: [...todoCards, ...approvalCards, ...doneCards],
  selectedDate: "2026-08-19",
  kanbanTitle: "8월 19일 수요일",
};
