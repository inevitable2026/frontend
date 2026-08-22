// 화면이 스스로 들고 있어야 하는 값만 모았다.
//
// 이 파일은 components/task-board/fixtures.ts 에서 살아남은 부분이다. 그 파일은 2026-08-19
// 김포 고촌 물류센터의 한 장면을 통째로 적어 둔 목업이었고, 이제 카드·브리핑·캘린더·참조는
// 전부 Postgres 에서 온다. 그래서 데이터에 해당하는 1000줄 남짓은 지웠고, **서버에 대응값이
// 없고 있어서도 안 되는 표현 상수**만 여기로 옮겼다.
//
// 남긴 기준은 하나다. "이 값이 현장마다 달라질 수 있는가" 를 물어 아니라고 답하면 남겼다.
// 열 이름과 캘린더 범례와 제품이 스스로 하는 약속("확정은 담당자가 합니다")은 데이터가
// 아니라 이 화면의 문구다. 그것을 DB 에 두면 현장마다 다른 약속을 하게 되고, 반대로 카드나
// 브리핑을 여기에 두면 화면이 오늘의 안전 상황을 지어내게 된다.
//
// 여기 있는 값은 어느 것도 서버 응답을 대신하지 않는다. 요청이 실패하면 board-data.ts 가
// 오류를 던지고 화면은 그 사유를 적는다. 실패를 이 파일의 값으로 메우지 않는다.

import type {
  BadgeTone,
  BoardColumnMeta,
  CalendarLegendItem,
  CardTone,
  ConditionSlug,
  ContextSource,
  MarkerTone,
} from "./types";
import type { DraftForm as ServerDraftForm } from "@/lib/board/types";

/* ------------------------------------------------------------------ *
 * 칸반 열
 *
 * 세 열은 진행 단계가 아니라 "지금 이 카드를 움직일 수 있는 주체" 로 나뉜다.
 * 서버에는 이 이름표에 대응하는 값이 없고, 있으면 현장마다 열 이름이 갈라져
 * 같은 제품을 쓰는 두 현장이 서로 다른 화면을 보게 된다.
 * ------------------------------------------------------------------ */

export const BOARD_COLUMNS: BoardColumnMeta[] = [
  { id: "todo", label: "Todo", role: "사람이 해야 하는 일", tone: "due", emptyMessage: "여기로 끌어다 놓기" },
  { id: "approval", label: "승인", role: "AI가 쓴 초안", tone: "ai", emptyMessage: "여기로 끌어다 놓기" },
  { id: "done", label: "완료", role: "산출물과 이행확인이 붙은 것", tone: "ok", emptyMessage: "여기로 끌어다 놓기" },
];

/* ------------------------------------------------------------------ *
 * 캘린더 범례와 요일
 * ------------------------------------------------------------------ */

export const CALENDAR_LEGEND: CalendarLegendItem[] = [
  { tone: "alert", label: "조건 발생" },
  { tone: "due", label: "기한" },
  { tone: "ai", label: "AI 초안" },
  { tone: "daily", label: "매일" },
];

/** 캘린더 칩에 여러 건을 묶어 적을 때 쓰는 무리 이름. 범례와 같은 낱말을 쓴다. */
export const MARKER_GROUP_LABEL: Record<MarkerTone, string> = {
  alert: "조건 발생",
  due: "기한",
  ai: "AI 초안",
  daily: "매일",
};

/** 주간 보드는 월요일에서 시작한다. week 라우트가 from 을 그 주 월요일로 당겨 준다. */
export const WEEK_DOW: string[] = ["월", "화", "수", "목", "금", "토", "일"];

/** 'YYYY-MM-DD' 를 Date 로 왕복시키지 않으려고 요일 이름을 따로 둔다. 0 이 일요일이다. */
export const DOW_NAMES: string[] = ["일", "월", "화", "수", "목", "금", "토"];

/* ------------------------------------------------------------------ *
 * 헤더의 "연결된 맥락" 네 줄
 *
 * 커넥터가 실제로 붙어 있는 것은 문서함 하나뿐이다. 메일함·전자결재·공정표·기상 관측은
 * 아직 연동이 없고 동기화 시각을 적어 두는 테이블도 없다. 그래서 네 줄의 이름표는 상수로
 * 두고, 마지막 동기화 문구는 문서 줄만 public.documents 의 최신 created_at 에서 만든다.
 * ------------------------------------------------------------------ */

export const WATCH_TITLE = "연결된 맥락을 보고 있습니다";
export const WATCH_FOOTNOTE =
  "변경이 감지되면 초안을 만들어 승인 열에 올립니다. 확정은 담당자가 합니다.";

/** 문서함에서 온 줄. 이 줄만 마지막 동기화 문구가 실제 값으로 바뀐다. */
export const DOCUMENT_SOURCE_ID = "src_approval";

/** 문서가 한 건도 없을 때 문서 줄에 적는 문구. 없는 시각을 지어내지 않는다. */
export const DOCUMENT_SOURCE_EMPTY = "등록된 문서가 없습니다";

/**
 * 문서함을 아예 읽지 못했을 때 문서 줄에 적는 문구.
 *
 * "등록된 문서가 없습니다" 와 반드시 갈라 두어야 한다. 질의가 실패한 것과 한 건도 없는 것은
 * 전혀 다른 사실인데, 둘을 같은 문구로 적으면 화면이 확인하지 않은 것을 확인했다고 말한다.
 */
export const DOCUMENT_SOURCE_UNREAD = "문서함을 읽지 못했습니다";

export const WATCH_SOURCES: ContextSource[] = [
  { id: "src_mail", label: "회사 메일함", icon: "mail", lastSyncedLabel: "연동 준비 중" },
  { id: DOCUMENT_SOURCE_ID, label: "전자결재 · 공무 문서", icon: "document", lastSyncedLabel: DOCUMENT_SOURCE_EMPTY },
  { id: "src_schedule", label: "공정표 · 출역 명부", icon: "schedule", lastSyncedLabel: "연동 준비 중" },
  { id: "src_observation", label: "기상 관측 · 아차사고 대장", icon: "observation", lastSyncedLabel: "연동 준비 중" },
];

/* ------------------------------------------------------------------ *
 * 브리핑 머리의 고정 문구
 * ------------------------------------------------------------------ */

export const BRIEFING_LIVE_LABEL = "감지 켜짐";

/* ------------------------------------------------------------------ *
 * 헤더 카운터
 *
 * 값은 카드 목록에서 센다. 이름표와 색만 여기 있다. BoardHeader 가 같은 규칙으로 다시 세므로
 * 뷰모델의 counters 는 사실상 타입을 채우는 자리이고, 그래서 두 곳의 규칙이 어긋나면 안 된다.
 * ------------------------------------------------------------------ */

export const COUNTER_LABEL = {
  condition: "조건 발생",
  due: "오늘 기한",
  approval: "승인 대기",
} as const;

/* ------------------------------------------------------------------ *
 * 규칙 번호 → 화면 조건 이름
 *
 * lib/detect/rules/*.ts 의 여덟 규칙 주석과 한 줄씩 맞춘 표다.
 * 'S-' 로 시작하는 주기 규칙은 번호가 늘어날 수 있어 접두어로만 가른다.
 * ------------------------------------------------------------------ */

export const CONDITION_BY_RULE: Record<string, ConditionSlug> = {
  "T-01": "weatherChange",
  "T-02": "feedbackPending",
  "T-03": "materialSubstitution",
  "T-04": "supervisorFeedback",
  "T-05": "nearMiss",
  "T-06": "inspectionNotice",
  "T-07": "recommendationGap",
  "T-08": "newWorker",
};

/* ------------------------------------------------------------------ *
 * 서버 초안 서식(한국어 6종)에 딸린 화면 값
 *
 * 화면 TaskDraft 는 네 서식뿐이다. 점검표와 기록은 미리보기 모양이 정의되어 있지 않아
 * view-model.ts 가 draft 를 통째로 null 로 두고 존재는 아래 배지와 태그로만 남긴다.
 * 억지로 다른 서식에 옮겨 담으면 라벨과 내용이 어긋난 초안이 승인 열에 뜬다.
 * ------------------------------------------------------------------ */

/** 승인 열 카드의 색띠. 서식이 무엇을 요구하는 판단인지에 따라 다르다. */
export const DRAFT_CARD_TONE: Record<ServerDraftForm, CardTone> = {
  회의록: "review",
  공문: "alert",
  회의자료: "due",
  TBM자료: "routine",
  점검표: "due",
  기록: "routine",
};

/** 승인 열 카드의 유형 배지. */
export const DRAFT_KIND_BADGE: Record<ServerDraftForm, { label: string; tone: BadgeTone }> = {
  회의록: { label: "회의록", tone: "neutral" },
  공문: { label: "공문", tone: "alert" },
  회의자료: { label: "회의 자료", tone: "due" },
  TBM자료: { label: "TBM", tone: "routine" },
  점검표: { label: "점검표", tone: "due" },
  기록: { label: "기록", tone: "neutral" },
};

/** 초안이 없는 승인 카드의 배지. 서식을 모르면 무엇이 올라왔는지만 적는다. */
export const APPROVAL_KIND_BADGE = { label: "승인 대기", tone: "neutral" as BadgeTone };

/* ------------------------------------------------------------------ *
 * 사실 종류 이름표
 *
 * 브리핑 근거줄의 꼬리에 `${factType} · ${key}` 가 붙는다. 담당자에게 필요한 것은 그 근거가
 * 무엇이었는지이지 기계가 붙인 종류 이름이 아니므로, 팝오버 머리에는 한국어 이름표를 적는다.
 * ------------------------------------------------------------------ */

export const FACT_TYPE_LABEL: Record<string, string> = {
  weatherObservation: "기상 관측",
  scheduleActiveTasks: "공정표",
  riskAssessmentRow: "위험성평가표",
  tbmMinutesFeedback: "TBM 회의록",
  tbmMinutesPreWorkCheck: "TBM 작업 전 점검",
  tbmMinutesAttendees: "TBM 출석",
  documentExtraction: "문서",
  documentApprovalState: "결재 상태",
  snapshotMaterials: "현장 스냅샷",
  externalReviewComment: "검토 의견",
  nearMissReport: "아차사고",
  officialNotice: "공문",
  riskRecommendation: "추천값",
  attendanceRoster: "출역 명부",
};

/** 종류를 알 수 없는 참조에 적는 이름표. */
export const REFERENCE_FALLBACK_KIND = "문서";

/* ------------------------------------------------------------------ *
 * 담당자 사전
 *
 * 서버 WorkItem.assignee 는 'user_park' 같은 문자열 하나이고 DB 에 사용자 표가 없다.
 * 사전에 없는 식별자는 접두어만 떼어 그대로 적는다 — 없는 이름을 지어내지 않는다.
 * ------------------------------------------------------------------ */

export const USERS: Record<string, { name: string }> = {
  user_park: { name: "박정우" },
  user_choi: { name: "최현우" },
};

/** 하도급사·타사 인원의 식별자 접두어. 카드의 동그란 표식 색이 달라진다. */
export const EXTERNAL_PREFIXES = ["sub_", "co_"];

/* ------------------------------------------------------------------ *
 * 되풀이되는 문구
 * ------------------------------------------------------------------ */

/**
 * 이관할 수 없는 카드에 적는 이유.
 * lib/detect/engine.ts 의 involvesRiskJudgement() 가 카드를 잠그는 유일한 사유라
 * 이 한 문장이 실제 사유와 어긋나지 않는다.
 */
export const NOT_DELEGABLE_REASON = "위험도 판정이 포함되어 이관할 수 없습니다";

/** 위험성평가 회의록 초안의 마지막 줄. 이행확인은 승인 시점에 사람이 채운다. */
export const IMPLEMENTATION_PENDING = "비어 있습니다 — 승인 시점에 사람이 채웁니다";

/** 인용할 수 있는 법령 원문을 하나도 확인하지 못했을 때 근거 칸에 적는 문구. */
export const NO_LEGAL_REFERENCE = "원문을 확인한 조문이 없습니다";

// TBM 구호와 회의 시각은 여기 있었다. 각각 "멈춘다 → 확인한다 → 평가한다 → 관리한다" 와
// "T14:00:00+09:00" · "T06:40:00+09:00" 이었고, 초안에 시각이 없으면 화면이 그것을 붙였다.
// 회의를 오전에 하는 현장에서도 화면은 오후 두 시라고 적었다.
//
// 지금은 초안 자신이 들고 온다 (lib/board/types.ts 의 Draft). 시각과 구호는 그 회의의
// 사실이지 화면의 문구가 아니고, 화면이 모르는 것을 지어내면 담당자가 어긋난 시각을 그대로
// 결재에 올린다. 위의 "이 값이 현장마다 달라질 수 있는가" 를 물었을 때 그렇다고 답하는 값은
// 이 파일에 있으면 안 된다.

/** 현장 이름을 얻지 못했을 때 헤더에 적는 말. */
export const SITE_NAME_FALLBACK = "현장";

/**
 * 무효화된 문서의 근거 팝오버 제목.
 *
 * 무효화 줄이 들고 있는 것은 내부 문서 식별자뿐이고 그것은 화면에 내보내지 않는다
 * (types.ts 의 ReferenceDetail 주석). 같은 문서를 여러 조건이 함께 무효화하므로 어느 한
 * 조건의 판단 문장을 제목으로 굳혀도 안 된다 — 다른 조건 아래에서 그 근거를 열면 남의
 * 판단이 제목으로 뜨기 때문이다. 그래서 제목은 무엇인지만 말하고 내용은 발췌에 맡긴다.
 */
export const INVALIDATED_DOC_TITLE = "전제가 무너진 문서";

/* ------------------------------------------------------------------ *
 * 확정자
 *
 * 이 화면에는 로그인이 없다. 그래서 승인 단추를 누른 사람이 누구인지 확인할 방법이 전혀
 * 없는데, 그 자리에 카드의 담당자 식별자를 실어 보내면 board.work_item_events.actor 와
 * work_items.confirmed_by 에 실제로 누르지 않은 사람의 이름이 남는다. 이행확인 기록에
 * 남의 이름을 적는 것은 위조와 같은 자리에 서므로, 확인되지 않은 확정자는 확인되지 않은
 * 채로 적는다.
 * ------------------------------------------------------------------ */

/** 이력에 남기는 행위자 식별자. 사람 식별자(user_*)와 겹치지 않는 값이어야 한다. */
export const CONSOLE_ACTOR = "console";

/** 그 식별자를 화면에 적을 때의 이름. 사람 이름 자리에 사람 이름을 지어 넣지 않는다. */
export const CONSOLE_ACTOR_NAME = "이 콘솔";
