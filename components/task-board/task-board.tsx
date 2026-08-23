"use client";

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";

import { BOARD_AT } from "@/lib/board/scene";
import type { WorkItem } from "@/lib/board/types";
import type { BoardView, ConsoleUrlState } from "@/lib/console-url";

import { AssistantFab, AssistantPanel, type BoardBridge } from "./assistant-panel";
import { BoardHeader } from "./board-header";
import {
  approveCard,
  boardSnapshotOf,
  BoardRequestError,
  loadBoard,
  moveCard,
  rejectCard,
  type BoardSources,
} from "./board-data";
import { BoardSkeleton } from "./board-skeleton";
import { 종료요약, 큐다음, 큐줄, type 처리자취 } from "./card-queue";
import { DailyBriefingPanel } from "./daily-briefing";
import { EvidenceDrawer, type 서랍큐 } from "./evidence-drawer";
import { KanbanBoard } from "./kanban-board";
import { CONSOLE_ACTOR } from "./presentation";
import { ReferenceProvider } from "./reference-chip";
import { RejectDialog } from "./reject-dialog";
import { RiskIssueSection } from "./risk-issue-section";
import { 확정자이름 } from "./view-model";
import { WeekCalendar } from "./week-calendar";
import type {
  BoardColumnId,
  BoardSnapshot,
  CalendarViewMode,
  CardMoveIntent,
  DraftEdit,
  RejectIntent,
  TaskCard,
} from "./types";

/**
 * 보드가 그리는 현장. public.sites 의 김포 고촌 물류센터 행을 가리키는 uuid 이고, 적재
 * 스크립트와 board.* 세 테이블의 site_id 가 같은 상수를 읽는다. 여기서 값을 다시 적지 않고
 * lib/board/site.ts 를 불러 쓰는 이유는 세 곳이 갈라지는 것을 막기 위해서다.
 */

/**
 * 두 카드 사이에 끼울 자리를 만드는 간격.
 *
 * 열 전체를 다시 매기지 않고 앞뒤 카드의 중간값만 보낸다. PATCH 는 카드 한 장만 고치므로
 * 열 전체를 다시 매기면 서버의 나머지 행이 옛 값을 들고 있어 다시 읽는 순간 순서가 어긋난다.
 */
const LANE_GAP = 1000;

/** aria-live 문장에 넣는 제목의 최대 길이. 넘으면 잘라 `…` 를 붙인다 (아티팩트 1658줄). */
const TITLE_LIMIT = 26;

const LOADING_MESSAGE = "보드를 불러오는 중입니다.";
const ROLLBACK_MESSAGE = "저장하지 못해 화면을 원래대로 되돌렸습니다.";

/* ------------------------------------------------------------------ *
 * 순수 함수 — 카드 목록을 다시 쓴다
 * ------------------------------------------------------------------ */

function shorten(title: string): string {
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT)}…` : title;
}

const COLUMN_WORD: Record<BoardColumnId, string> = {
  todo: "Todo",
  approval: "승인",
  done: "완료",
};

/** 이동 결과를 말로 적는다. 문장은 아티팩트 1657~1666 줄 그대로다. */
function moveMessage(card: TaskCard, intent: CardMoveIntent): string {
  const title = shorten(card.title);
  if (intent.from === intent.to) return `「${title}」 카드의 순서를 바꿨습니다.`;
  if (intent.from === "approval" && intent.to === "done") {
    return `「${title}」 초안을 승인했습니다. 결재와 서명 절차가 시작됩니다.`;
  }
  if (intent.from === "approval" && intent.to === "todo") {
    return `「${title}」 초안을 직접 손보려고 ${COLUMN_WORD.todo}로 가져왔습니다.`;
  }
  if (intent.to === "done") return `「${title}」 카드를 완료로 옮겼습니다. 이행확인 표시가 붙습니다.`;
  if (intent.to === "approval") return `「${title}」 카드를 승인 대기로 옮겼습니다.`;
  return `「${title}」 카드를 ${COLUMN_WORD.todo}로 옮겼습니다.`;
}

function columnOf(cards: TaskCard[], columnId: BoardColumnId): TaskCard[] {
  return cards
    .filter((card) => card.status === columnId)
    .sort((left, right) => left.laneOrder - right.laneOrder);
}

/**
 * 놓일 자리의 laneOrder 를 앞뒤 카드 사이의 중간값으로 정한다.
 * 서버가 double precision 으로 들고 있어 몇 번을 끼워 넣어도 다시 매길 일이 없다.
 */
function laneOrderFor(cards: TaskCard[], itemId: string, to: BoardColumnId, toIndex: number): number {
  const column = columnOf(
    cards.filter((card) => card.itemId !== itemId),
    to,
  );
  const index = Math.min(Math.max(toIndex, 0), column.length);
  const 앞 = index > 0 ? column[index - 1] : null;
  const 뒤 = index < column.length ? column[index] : null;

  if (앞 === null && 뒤 === null) return LANE_GAP;
  if (앞 === null && 뒤 !== null) return 뒤.laneOrder - LANE_GAP;
  if (앞 !== null && 뒤 === null) return 앞.laneOrder + LANE_GAP;
  if (앞 !== null && 뒤 !== null) return (앞.laneOrder + 뒤.laneOrder) / 2;
  return LANE_GAP;
}

/**
 * 카드를 옮긴 목록을 새로 만든다.
 *
 * 승인 열에서 Todo 로 끌어오면 `origin` 이 `"human"` 이 된다 — 사람이 직접 다시 쓴다는 뜻이므로
 * `is-ai` 표식이 떨어진다. 초안은 버리지 않고 카드에 그대로 남긴다 (계약 4.1 절).
 *
 * 옮긴 카드의 laneOrder 만 바꾸고 나머지 카드는 건드리지 않는다. 서버에 보내는 값도 같은
 * 중간값이라 화면과 저장소의 순서가 어긋나지 않는다.
 */
function applyMove(cards: TaskCard[], intent: CardMoveIntent, laneOrder: number): TaskCard[] {
  return cards.map((card) => {
    if (card.itemId !== intent.itemId) return card;
    return {
      ...card,
      status: intent.to,
      laneOrder,
      origin:
        intent.from === "approval" && intent.to === "todo" && card.origin === "machine"
          ? "human"
          : card.origin,
    };
  });
}

/**
 * 초안을 승인한다. 카드는 완료 열 **맨 위**로 가고 `confirmedBy` · `confirmedAt` 이 채워진다.
 * 이 카드를 `blockedBy` 로 걸고 있던 카드는 대기가 풀린다 (계약 4.2 절).
 */
function applyApprove(
  cards: TaskCard[],
  card: TaskCard,
  laneOrder: number,
  confirmedBy: string,
  confirmedAt: string,
): TaskCard[] {
  const moved = applyMove(cards, { itemId: card.itemId, from: card.status, to: "done", toIndex: 0 }, laneOrder);

  return moved.map((item) => {
    if (item.itemId === card.itemId) return { ...item, confirmedBy, confirmedAt };
    if (item.blockedBy.some((ref) => ref.itemId === card.itemId)) {
      return { ...item, blockedBy: item.blockedBy.filter((ref) => ref.itemId !== card.itemId) };
    }
    return item;
  });
}

/**
 * 기각한 카드는 목록에서 사라지지 않는다.
 *
 * 서버의 rejectItem 이 status 를 todo 로, origin 을 human 으로 바꾸고 초안을 남기기 때문이다.
 * 무엇을 기각했는지가 나중에 방어 근거가 되므로 지우면 안 되고, 화면에서만 지우면 새로
 * 고친 순간 그 카드가 Todo 열에 다시 나타나 사용자가 두 번 놀란다.
 * 그 카드를 기다리던 카드의 대기도 함께 푼다.
 */
function applyReject(cards: TaskCard[], itemId: string, laneOrder: number): TaskCard[] {
  return cards.map((card) => {
    if (card.itemId === itemId) {
      return { ...card, status: "todo", origin: "human", laneOrder };
    }
    if (card.blockedBy.some((ref) => ref.itemId === itemId)) {
      return { ...card, blockedBy: card.blockedBy.filter((ref) => ref.itemId !== itemId) };
    }
    return card;
  });
}

/**
 * 날짜 필터.
 *
 * 보드 날짜를 고르면 그 현장의 카드가 전부 나오고, 다른 날을 고르면 **캘린더가 그날 칸에
 * 놓은 카드**만 남는다. 서버 items 질의에 date 를 붙이지 않는 것과 짝이 되는 규칙이다 —
 * 기한이 없는 승인 카드까지 서버에서 걸러 버리면 칸반의 승인 열이 통째로 빈다.
 *
 * 예전에는 여기서 card.dueBy 의 앞 열 글자만 견주었다. 그런데 주간 라우트는 기한이 없는
 * 카드를 생성일 칸에 놓으므로, 캘린더가 "1건" 이라고 적어 둔 날을 눌렀을 때 칸반이 통째로
 * 비었다. 같은 화면의 두 자리가 서로 다른 규칙으로 세면 어느 쪽도 믿을 수 없다.
 *
 * 캘린더에 없는 날(도우미가 이 주 밖의 날짜를 고르는 경우)은 예전 규칙으로 돌아간다.
 * 그 날의 배치는 서버에서 받아 온 것이 없어 화면이 알 방법이 없기 때문이다.
 */
function 그날카드(cards: TaskCard[], 놓인것: Set<string> | undefined, date: string): TaskCard[] {
  if (놓인것 === undefined) {
    return cards.filter((card) => card.dueBy !== null && card.dueBy.slice(0, 10) === date);
  }
  return cards.filter((card) => 놓인것.has(card.itemId));
}

/** 낙관적 갱신이 엎어졌을 때 화면에 적을 문장. 서버가 쓴 사유를 그대로 덧붙인다. */
function 실패문구(error: unknown): string {
  if (error instanceof BoardRequestError) return `${ROLLBACK_MESSAGE} ${error.message}`;
  return ROLLBACK_MESSAGE;
}

/** 처음부터 펼쳐 둘 조건. 읽는 길이 둘이라(서버가 미리 준 보드와 화면이 읽은 보드) 한곳에 적는다. */
function 처음펼칠조건(snapshot: BoardSnapshot | null): string[] {
  if (snapshot === null) return [];
  return snapshot.briefing.conditions
    .filter((condition) => condition.defaultOpen)
    .map((condition) => condition.conditionId);
}

/* ------------------------------------------------------------------ *
 * 컨테이너
 * ------------------------------------------------------------------ */

export function TaskBoard({
  initialSources = null,
  siteId,
  boardDate: requestedDate,
  selectedDate: requestedSelectedDate,
  viewMode: requestedViewMode,
  demo = false,
  onUrlStateChange,
}: {
  /**
   * 서버가 첫 그림 전에 이미 읽어 둔 보드 재료다.
   *
   * 이것이 있으면 화면은 요청을 한 번도 보내지 않고 곧바로 카드를 그린다. 없을 때만 예전처럼
   * 마운트 뒤에 읽는데, 그 길은 HTML 이 도착하고 번들을 내려받아 hydration 이 끝난 뒤에야
   * 첫 요청이 나가므로 데이터베이스 왕복 앞에 대기가 한 겹 더 붙는다.
   */
  initialSources?: BoardSources | null;
  siteId: string;
  boardDate: string;
  selectedDate: string | null;
  viewMode: BoardView;
  /** 시연 모드. 한 카드(`DEMO_ISSUE_CARD_ID`)의 위험성평가 이슈에만 쓰인다. */
  demo?: boolean;
  onUrlStateChange: (patch: Partial<ConsoleUrlState>) => void;
}): JSX.Element {
  /**
   * 서버가 미리 읽어 둔 재료 중, 주소가 가리키는 현장·날짜와 맞는 것만 쓴다.
   *
   * 주소에 다른 현장이나 다른 날이 적힌 채로 들어오면 선독해 둔 것은 다른 보드다. 그것을
   * 그대로 그리면 주소와 화면이 갈라지므로, 맞지 않으면 없는 것으로 치고 아래 효과가 읽게
   * 둔다.
   */
  const 선독재료 = useMemo(
    () => (
      initialSources === null ||
      initialSources.siteId !== siteId ||
      initialSources.date !== requestedDate
        ? null
        : initialSources
    ),
    [initialSources, requestedDate, siteId],
  );

  /**
   * 화면이 드는 것은 뷰모델이 아니라 **재료**다.
   *
   * toBoardSnapshot 은 원본 WorkItem 을 카드로 옮기면서 produces 를 비우고 trigger 를 조건
   * 이름으로 뭉갠다(view-model.ts 의 카드옮기기). 증거 서랍은 바로 그 버려지는 값들을
   * 그리므로, 스냅샷만 들고 있으면 서랍이 그릴 것이 화면 어디에도 남지 않는다. 서버 선독
   * 경로(app/page.tsx → construction-console.tsx)가 넘겨 주는 것도 같은 BoardSources 라
   * 두 길이 여기서 같은 모양으로 합쳐진다.
   */
  const [sources, setSources] = useState<BoardSources | null>(선독재료);

  // 재료를 뷰모델로 옮기는 일은 재료가 바뀔 때 한 번이면 된다.
  const snapshot = useMemo(
    () => (sources === null ? null : boardSnapshotOf(sources)),
    [sources],
  );

  /** 서랍이 itemId 로 정본을 찾는 지도. 큐의 카드 전진도 같은 지도를 쓴다. */
  const 원본 = useMemo(() => {
    const 지도 = new Map<string, WorkItem>();
    for (const item of sources?.items ?? []) 지도.set(item.itemId, item);
    return 지도;
  }, [sources]);

  const [cards, setCards] = useState<TaskCard[]>(() => snapshot?.cards ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 다시 시도 단추가 올리는 값. 바뀌면 읽기 효과가 한 번 더 돈다. */
  const [attempt, setAttempt] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(requestedSelectedDate);
  const [viewMode, setViewMode] = useState<CalendarViewMode>(requestedViewMode);
  const [openConditionIds, setOpenConditionIds] = useState<string[]>(() =>
    처음펼칠조건(snapshot),
  );
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<TaskCard | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  /**
   * 증거 서랍이 열고 있는 카드와, 그 서랍을 연 순간의 열.
   *
   * 열을 함께 붙들어 두는 이유는 큐에 있다. 승인한 카드는 완료 열로 옮겨 가는데 큐가 그것을
   * 따라가면 방금 승인한 카드의 뒤를 완료 열에서 이어 읽는다. 카드는 itemId 로만 들고 매
   * 렌더에서 cards 로 다시 집는다 — rejectTarget 처럼 객체를 들면 낙관적 갱신 뒤에 낡는다.
   */
  const [열린카드, set열린카드] = useState<{
    itemId: string;
    columnId: BoardColumnId;
    /**
     * 「다시 보기」로 잠깐 펼쳐 놓은 지나온 카드. 큐의 자리는 위 itemId 가 그대로 든다.
     *
     * 서랍이 그리는 카드를 itemId 자체로 바꾸면 큐가 자리를 잃는다. 다시 보는 카드는 이미
     * 처분되어 그 열을 떠났으므로(승인은 완료로, 기각은 Todo 로) 큐다음 이 줄에서 못 찾아
     * 첫 장으로 되감고, 「다음」한 번에 이미 지나온 카드부터 다시 선다. 그래서 겹쳐 보는
     * 값을 따로 든다 — 큐는 제자리에 서 있고 화면만 잠시 뒤를 본다.
     */
    되짚기: string | null;
  } | null>(null);
  /** 이번 큐가 지나온 카드들. 최근 것이 앞에 선다 (AC-15). */
  const [자취, set자취] = useState<처리자취[]>([]);
  /** 저장이 끝날 때까지 서랍의 승인·기각·다음을 잠근다. 이중 제출도 이 잠금이 막는다. */
  const [큐저장중, set큐저장중] = useState(false);
  /** 저장이 엎어졌을 때 서랍 안에 적을 문장. 서버가 쓴 사유를 그대로 싣는다. */
  const [큐오류, set큐오류] = useState<string | null>(null);
  /** 더 갈 카드가 없어 큐가 끝났다. 서랍은 닫지 않고 끝 화면을 켠다 (AC-16). */
  const [큐끝, set큐끝] = useState(false);
  // AI 도우미 사이드바의 열림 여부. 패널은 흐름 밖에 서지만 껍데기에도 수식을 붙여
  // 두어야 열린 동안 칸반이 패널 아래로 숨지 않게 여백을 줄 수 있다.
  const [assistantOpen, setAssistantOpen] = useState(false);

  // 서버가 못 읽어 줬을 때, 그리고 다시 시도 단추를 눌렀을 때만 화면이 직접 읽는다.
  // setState 는 await 경계 뒤에서만 부른다.
  useEffect(() => {
    // 첫 회차에 서버가 준 보드가 이미 서 있으면 같은 것을 한 번 더 받아 올 이유가 없다.
    if (선독재료 !== null && attempt === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const next = await loadBoard(siteId, requestedDate, `${requestedDate}${BOARD_AT.slice(10)}`);
        if (cancelled) return;
        // 같은 변환이 위 memo 에서 한 번 더 돌지만, 순수 함수 한 번이 재료와 뷰모델을 두 벌의
        // 상태로 갈라 두는 것보다 싸다. 두 벌이면 어느 한쪽만 갱신되는 길이 생긴다.
        const view = boardSnapshotOf(next);
        setSources(next);
        setCards(view.cards);
        setLoadError(null);
        setSelectedDate(requestedSelectedDate);
        setOpenConditionIds(처음펼칠조건(view));
      } catch (error) {
        if (cancelled) return;
        // 실패를 숨기고 지난 화면을 그대로 두지 않는다. 무엇이 잘못되었는지 적고 멈춘다.
        setSources(null);
        setCards([]);
        setLoadError(
          error instanceof BoardRequestError
            ? error.message
            : "보드를 불러오는 동안 알 수 없는 오류가 났습니다.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, 선독재료, siteId, requestedDate, requestedSelectedDate]);

  // Ctrl+K 로 열고 Esc 로 닫는다 (아티팩트 317줄). 효과는 리스너만 걸고 상태는 핸들러가 바꾼다.
  //
  // Esc 리스너를 하나로 유지하고 그 안에 우선순위 사다리를 적는다. 서랍이 자기 window
  // 리스너를 따로 달면 등록 순서가 결과를 정하게 되고, 서랍을 닫으면서 AI 도우미까지 함께
  // 닫히는 자리가 생긴다. 상태 소유자가 한 곳이므로 사다리도 한 곳에 있어야 한다.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setAssistantOpen((previous) => !previous);
        return;
      }
      if (event.key !== "Escape") return;

      // 기각 상자가 떠 있으면 Esc 는 그 상자의 것이다. 상자는 자기 onKeyDown 으로 닫히고
      // 전파를 막지 않아 이 리스너까지 올라오는데(reject-dialog.tsx), 여기서 서랍까지
      // 닫으면 사유를 쓰다 만 사람이 근거 화면마저 잃는다.
      if (rejectTarget !== null) return;
      if (열린카드 !== null) {
        set열린카드(null);
        return;
      }
      setAssistantOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rejectTarget, 열린카드]);

  const boardDate = snapshot === null ? requestedDate : snapshot.selectedDate;

  /** 캘린더가 어느 카드를 어느 날 칸에 놓았는지. 날짜 거르기가 이 배치를 그대로 따른다. */
  const 날짜별카드 = useMemo(() => {
    const out = new Map<string, Set<string>>();
    if (snapshot === null) return out;
    for (const day of snapshot.calendar.days) out.set(day.date, new Set(day.itemIds));
    return out;
  }, [snapshot]);

  const visibleCards = useMemo(() => {
    if (selectedDate === null || selectedDate === boardDate) return cards;
    return 그날카드(cards, 날짜별카드.get(selectedDate), selectedDate);
  }, [cards, boardDate, selectedDate, 날짜별카드]);

  const kanbanTitle = useMemo(() => {
    if (snapshot === null) return "";
    if (selectedDate === null) return snapshot.calendar.rangeLabel;
    if (selectedDate === snapshot.selectedDate) return snapshot.kanbanTitle;
    const day = snapshot.calendar.days.find((item) => item.date === selectedDate);
    if (day === undefined) return snapshot.calendar.rangeLabel;
    return `${Number(day.date.split("-")[1])}월 ${day.dayNumber}일 ${day.dow}요일`;
  }, [snapshot, selectedDate]);

  /**
   * 낙관적 갱신 한 자리. 화면을 먼저 바꾸고, 저장이 엎어지면 이전 목록으로 되돌린다.
   *
   * 성공이면 null, 실패면 화면에 적은 그 문장을 돌려준다. 큐가 그것을 요구한다 — 저장이
   * 확정된 뒤에만 다음 카드로 전진해야 하고, 실패했을 때는 서버가 쓴 사유를 서랍 안에도
   * 적어야 한다. 참·거짓 대신 문장을 돌려주는 것은 그 사유를 두 번 만들지 않기 위해서다.
   * 기존 호출부는 `void commit(...)` 이라 반환값이 늘어도 그대로 산다.
   */
  const commit = useCallback(
    async (next: TaskCard[], message: string, persist: () => Promise<void>): Promise<string | null> => {
      const previous = cards;
      setCards(next);
      setStatusMessage(message);
      try {
        await persist();
        return null;
      } catch (error) {
        setCards(previous);
        const 문구 = 실패문구(error);
        setStatusMessage(문구);
        return 문구;
      }
    },
    [cards],
  );

  function handleMove(intent: CardMoveIntent): void {
    const card = cards.find((item) => item.itemId === intent.itemId);
    if (card === undefined) return;

    // 확정된 카드는 서버가 어떤 전이도 409 로 막는다(transition.ts 의 confirmedAt 검사).
    // 그것을 모른 채 보내면 카드가 한 칸 움직였다가 제자리로 튀고 되돌림 문구가 뜬다.
    // 완료 열 안에서 순서를 바꾸려는 것뿐이어도 그렇다. 여기서 먼저 멈추고 이유를 적는다.
    if (card.confirmedAt !== null) {
      setStatusMessage(`「${shorten(card.title)}」 카드는 이미 확정되어 옮길 수 없습니다.`);
      return;
    }

    // 기계가 올린 초안을 승인 열에서 Todo 로 되돌리는 것은 서버에서 기각으로 읽힌다. 사유
    // 없이 보내면 400 이 돌아오므로, 이 조합만 가로채 사유를 묻는 대화 상자를 연다.
    if (intent.from === "approval" && intent.to === "todo" && card.origin === "machine") {
      setRejectTarget(card);
      return;
    }

    // 자리 번호는 **사용자가 본 목록** 안의 순번이다. 날짜 필터가 걸려 있으면 칸반에 서 있는
    // 카드가 열의 일부뿐이므로, 거르지 않은 전체 목록으로 앞뒤 카드를 찾으면 놓은 자리와
    // 다른 곳에 카드가 놓인다. 두 목록의 laneOrder 는 같은 값이라 보이는 이웃 사이의
    // 중간값이 전체 열에서도 그 두 카드 사이를 가리킨다.
    const laneOrder = laneOrderFor(visibleCards, intent.itemId, intent.to, intent.toIndex);
    void commit(applyMove(cards, intent, laneOrder), moveMessage(card, intent), async () => {
      await moveCard(intent, laneOrder);
    });
  }

  /* ---------------- 큐 모드 (AC-13 ~ AC-16) ---------------- */

  /** 서랍이 지금 이 카드를 열고 있나. 큐는 서랍이 열려 있을 때만 돈다. */
  function 큐대상(itemId: string): { itemId: string; columnId: BoardColumnId } | null {
    return 열린카드 !== null && 열린카드.itemId === itemId ? 열린카드 : null;
  }

  /**
   * 한 장을 처분한 뒤의 전진.
   *
   * 다음 카드가 없어도 **서랍을 닫지 않는다**(AC-16). 조용히 닫히면 몇 장을 처리했는지,
   * 무엇이 남았는지를 사람이 잃는다. 방금 처분한 카드를 그대로 둔 채 끝 화면을 켠다.
   */
  function 큐전진(자취줄: 처리자취, 다음: string | null, columnId: BoardColumnId): void {
    set자취((previous) => [자취줄, ...previous]);
    if (다음 === null) {
      set큐끝(true);
      return;
    }
    set열린카드({ itemId: 다음, columnId, 되짚기: null });
    set큐끝(false);
  }

  function 서랍열기(itemId: string, columnId: BoardColumnId): void {
    // 원본을 못 찾으면 서랍이 그릴 것이 없다. 빈 서랍을 여는 대신 왜 못 여는지 적는다 —
    // 카드는 언제나 원본에서 만들어지므로 여기 걸린다는 것은 두 목록이 어긋났다는 뜻이다.
    if (!원본.has(itemId)) {
      setStatusMessage("이 카드의 원본을 화면이 들고 있지 않아 근거 서랍을 열지 못했습니다. 보드를 다시 불러오십시오.");
      return;
    }
    set열린카드({ itemId, columnId, 되짚기: null });
    // 카드를 새로 누른 것은 새 큐의 시작이다. 지난 자취를 그대로 두면 이번에 무엇을
    // 처리했는지가 흐려진다. 「다시 보기」로 옮겨 갈 때는 여기를 지나지 않는다.
    set자취([]);
    set큐끝(false);
    set큐오류(null);
  }

  /**
   * 기각을 되돌린다.
   *
   * 서버에서 이것은 그냥 이동이다. rejectItem 이 confirmed_at 을 비워 둔 채 todo·human 으로만
   * 바꾸므로 확정 잠금(transition.ts)에 걸리지 않는다. 다만 origin 은 human 으로 남는다 —
   * moveItem 의 humanTakeover 는 approval→todo 에만 걸린다. 그 사실은 단추의 툴팁이 말한다.
   *
   * 승인에는 이 길이 없다. 확정된 카드는 서버가 어떤 전이도 409 로 막으므로 언제나 실패하는
   * 단추가 되고, 그래서 서랍은 승인 자취에 단추 대신 사유 한 줄을 적는다.
   */
  function 큐되돌리기(자취줄: 처리자취): void {
    if (자취줄.종류 !== "기각") return;
    const card = cards.find((item) => item.itemId === 자취줄.itemId);
    if (card === undefined) return;

    const intent: CardMoveIntent = {
      itemId: 자취줄.itemId,
      from: card.status,
      to: 자취줄.이전열,
      toIndex: 0,
    };
    // applyReject 가 다른 카드에서 풀어 버린 선행 링크를 함께 되살린다. 그러지 않으면
    // 되돌린 뒤 화면과 서버가 한 군데서 어긋난다.
    const 되살린 = applyMove(cards, intent, 자취줄.이전순서).map((item) => {
      const 되살릴것 = 자취줄.풀린대기.filter(
        (대기) =>
          대기.itemId === item.itemId &&
          !item.blockedBy.some((ref) => ref.itemId === 대기.ref.itemId),
      );
      if (되살릴것.length === 0) return item;
      return { ...item, blockedBy: [...item.blockedBy, ...되살릴것.map((대기) => 대기.ref)] };
    });

    set큐저장중(true);
    set큐오류(null);
    void (async () => {
      const 실패 = await commit(
        되살린,
        `「${shorten(자취줄.title)}」 기각을 되돌려 ${COLUMN_WORD[자취줄.이전열]} 열의 원래 자리로 돌려놓았습니다.`,
        async () => {
          await moveCard(intent, 자취줄.이전순서);
        },
      );
      set큐저장중(false);
      if (실패 !== null) {
        set큐오류(실패);
        return;
      }
      set자취((previous) => previous.filter((줄) => 줄.itemId !== 자취줄.itemId));
    })();
  }

  function handleApprove(card: TaskCard, edits: DraftEdit[]): void {
    const message = moveMessage(card, {
      itemId: card.itemId,
      from: "approval",
      to: "done",
      toIndex: 0,
    });
    const laneOrder = laneOrderFor(cards, card.itemId, "done", 0);
    // 이 화면에는 로그인이 없어 누가 눌렀는지 확인할 방법이 없다. 그래서 카드의 담당자를
    // 확정자로 적지 않는다 — 실제로 누르지 않은 사람의 이름이 board.work_item_events.actor
    // 와 work_items.confirmed_by 에 남으면 그것은 이행확인 기록의 위조와 같은 자리에 선다.
    // 확인되지 않은 확정자는 확인되지 않은 채로 적는다.
    const 확정자 = CONSOLE_ACTOR;
    const 표시이름 = card.confirmedBy ?? 확정자이름(확정자) ?? "시스템";
    const 임시확정시각 = new Date().toISOString();

    // 다음 카드는 낙관적 갱신을 **적용하기 전에** 정한다. applyApprove 가 카드를 완료 열
    // 맨 위로 옮기므로, 옮긴 뒤에 세면 현재 카드를 못 찾아 줄의 첫 장으로 되돌아가고 이미
    // 지나온 카드부터 다시 선다.
    const 큐 = 큐대상(card.itemId);
    const 다음 = 큐 === null ? null : 큐다음(visibleCards, 큐.columnId, card.itemId);
    const 자취줄: 처리자취 = {
      itemId: card.itemId,
      title: card.title,
      종류: "승인",
      이전열: card.status,
      이전순서: card.laneOrder,
      // 승인은 되돌릴 수 없으므로 되살릴 것을 적어 두지 않는다.
      풀린대기: [],
    };
    if (큐 !== null) {
      set큐저장중(true);
      set큐오류(null);
    }

    void (async () => {
      const 실패 = await commit(
        applyApprove(cards, card, laneOrder, 표시이름, 임시확정시각),
        message,
        async () => {
          const item = await approveCard({ itemId: card.itemId, edits }, 확정자, laneOrder);
          // 확정 시각은 서버가 정한다. 화면이 먼저 적어 둔 값을 응답으로 덮어 둬야
          // 카드에 적힌 시각과 이력에 남은 시각이 같아진다.
          setCards((previous) =>
            previous.map((entry) =>
              entry.itemId === item.itemId
                ? {
                    ...entry,
                    status: item.status,
                    confirmedBy: 확정자이름(item.confirmedBy),
                    confirmedAt: item.confirmedAt,
                    laneOrder: item.laneOrder,
                  }
                : entry,
            ),
          );
        },
      );
      if (큐 === null) return;
      set큐저장중(false);
      // 저장이 엎어지면 그 카드에 머문다. 전진해 버리면 실패한 카드가 화면에서 사라진다.
      if (실패 !== null) {
        set큐오류(실패);
        return;
      }
      큐전진(자취줄, 다음, 큐.columnId);
    })();
  }

  function handleReject(intent: RejectIntent): void {
    const card = cards.find((item) => item.itemId === intent.itemId);
    setRejectTarget(null);
    if (card === undefined) return;

    // 서버는 **승인 열에 있는 기계의 초안**만 기각으로 읽는다(transition.ts 의 isRejection).
    // 그 밖의 카드에 사유를 실어 보내면 planTransition 이 이동으로 읽어 사유를 버리는데,
    // 응답은 200 이라 화면만 "사유가 기록되었습니다" 라고 말하고 이력에는 아무 줄도 없다.
    // 여기서는 기각이라고 말하지 않고 있는 그대로 옮기기만 한다.
    if (card.status !== "approval" || card.origin !== "machine") {
      handleMove({ itemId: card.itemId, from: card.status, to: "todo", toIndex: 0 });
      return;
    }

    // 기각한 카드는 Todo 열 맨 위로 간다. 서버가 같은 자리로 옮기므로 값도 함께 보낸다.
    const laneOrder = laneOrderFor(cards, intent.itemId, "todo", 0);

    const 큐 = 큐대상(card.itemId);
    const 다음 = 큐 === null ? null : 큐다음(visibleCards, 큐.columnId, card.itemId);
    const 자취줄: 처리자취 = {
      itemId: card.itemId,
      title: card.title,
      종류: "기각",
      이전열: card.status,
      이전순서: card.laneOrder,
      // applyReject 가 지금부터 풀어 버릴 선행 링크. 되돌릴 때 이것으로 되살린다.
      풀린대기: cards.flatMap((item) =>
        item.blockedBy
          .filter((ref) => ref.itemId === intent.itemId)
          .map((ref) => ({ itemId: item.itemId, ref })),
      ),
    };
    if (큐 !== null) {
      set큐저장중(true);
      set큐오류(null);
    }

    void (async () => {
      const 실패 = await commit(
        applyReject(cards, intent.itemId, laneOrder),
        `「${shorten(card.title)}」 초안을 기각했습니다. 사유가 기록되었고 카드는 ${COLUMN_WORD.todo}로 돌아갔습니다.`,
        async () => {
          await rejectCard(intent, laneOrder);
        },
      );
      if (큐 === null) return;
      set큐저장중(false);
      if (실패 !== null) {
        set큐오류(실패);
        return;
      }
      큐전진(자취줄, 다음, 큐.columnId);
    })();
  }

  function handleToggleCondition(conditionId: string): void {
    setOpenConditionIds((previous) =>
      previous.includes(conditionId)
        ? previous.filter((id) => id !== conditionId)
        : [...previous, conditionId],
    );
  }

  if (loadError !== null) {
    return (
      <div className="board-shell">
        <div aria-live="assertive" className="board-status" role="alert">
          {loadError}
        </div>
        <div className="board-card-actions">
          <button
            className="board-button-approve"
            onClick={() => setAttempt((previous) => previous + 1)}
            type="button"
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  if (snapshot === null) {
    // 빈 화면에 한 줄만 띄우지 않고 보드와 같은 자리에 뼈대를 세운다. 카드가 도착하는 순간
    // 헤더와 칸반이 이미 있던 자리에 채워지므로 화면이 위아래로 튀지 않는다.
    return <BoardSkeleton message={LOADING_MESSAGE} />;
  }

  /**
   * AI 사이드바가 보드를 읽고 고치는 창구. **여기 없는 손잡이는 사이드바도 쓸 수 없다** —
   * 카드 변경은 전부 위의 세 핸들러를 지나므로 낙관적 갱신과 되돌리기가 한 자리에 남는다.
   */
  /** 조건 식별자를 사람이 부르는 코드(T-03)로 바꾸는 표. 도우미가 카드를 가리킬 때 쓴다. */
  const conditionCodes = new Map(
    snapshot.briefing.conditions.map((condition) => [condition.conditionId, condition.code]),
  );

  /* ---------------- 서랍에 넘길 것 ---------------- */

  // 카드는 itemId 로만 들고 매 렌더에서 다시 집는다. 낙관적 갱신이 카드를 새로 만들므로
  // 객체를 붙들면 승인 직후 한 박자 옛 값을 그린다.
  //
  // 「다시 보기」 중에는 그리는 카드와 큐가 선 카드가 갈린다. 화면은 되짚기 를 그리고 큐의
  // 셈(다음·남은 장수)은 아래에서 열린카드.itemId 로 한다.
  const 보일itemId = 열린카드 === null ? null : (열린카드.되짚기 ?? 열린카드.itemId);
  const 서랍카드 = 보일itemId === null ? null : (cards.find((c) => c.itemId === 보일itemId) ?? null);
  const 서랍원본 = 보일itemId === null ? null : (원본.get(보일itemId) ?? null);
  const 큐열 =
    열린카드 === null ? null : (snapshot.columns.find((c) => c.id === 열린카드.columnId) ?? null);
  // 큐가 세는 목록은 언제나 **사람이 보고 있는 것**이다. laneOrder 계산도 같은 목록으로
  // 세므로, 두 자리가 서로 다른 목록으로 세면 어느 쪽도 믿을 수 없다.
  const 큐남은 = 열린카드 === null ? [] : 큐줄(visibleCards, 열린카드.columnId);
  const 다음itemId =
    열린카드 === null ? null : 큐다음(visibleCards, 열린카드.columnId, 열린카드.itemId);

  const 서랍큐값: 서랍큐 | null =
    열린카드 === null || 큐열 === null
      ? null
      : {
          열이름: 큐열.label,
          저장중: 큐저장중,
          오류: 큐오류,
          다음있음: 다음itemId !== null,
          자취,
          종료: 큐끝
            ? 종료요약({
                열이름: 큐열.label,
                자취,
                남은수: 큐남은.length,
                막힌수: 큐남은.filter((c) => c.blockedBy.length > 0).length,
                날짜필터: selectedDate !== null && selectedDate !== boardDate,
              })
            : null,
          // 서랍의 승인은 초안 수정분을 싣지 않는다. 초안 편집칸은 카드 안에 있고 그 수정분은
          // TaskCardView 의 상태라, 서랍이 대신 보내면 사람이 카드에서 고친 것과 어긋난다.
          // 도우미 다리도 같은 이유로 빈 배열을 보낸다.
          onApprove: () => {
            if (서랍카드 !== null) handleApprove(서랍카드, []);
          },
          onReject: () => {
            // 사유 없이 보내면 서버가 400 을 돌려준다. 기존 기각 상자를 그대로 띄운다 —
            // 그 상자는 z-index 가 서랍보다 위라 서랍 위에 선다.
            if (서랍카드 !== null) setRejectTarget(서랍카드);
          },
          되짚는중: 열린카드.되짚기 !== null,
          onNext: () => {
            // 되짚어 보는 중이면 「다음」은 전진이 아니라 **제자리로 돌아가기**다. 그렇지
            // 않으면 지나온 카드를 한 장 들여다본 값으로 큐가 한 칸 앞질러 간다.
            if (열린카드.되짚기 !== null) {
              set열린카드({ ...열린카드, 되짚기: null });
              return;
            }
            if (다음itemId !== null)
              set열린카드({ itemId: 다음itemId, columnId: 열린카드.columnId, 되짚기: null });
          },
          onUndo: 큐되돌리기,
          // 「다시 보기」는 자취를 지우지 않는다. 지나온 목록도 큐의 자리도 그대로 둔 채
          // 그 카드만 겹쳐 편다.
          onRevisit: (itemId) => set열린카드({ ...열린카드, 되짚기: itemId }),
        };

  const assistantBridge: BoardBridge = {
    context: {
      siteName: snapshot.site.name,
      phase: snapshot.site.phase,
      boardDate,
      selectedDate,
      // 도구가 판단에 쓸 만큼만 추려 보낸다. 초안 본문처럼 긴 값은 빼고, 길이 상한이 걸린
      // 필드는 여기서 잘라 둔다 — 서버에서 스키마가 어긋나면 보드 도구가 통째로 사라진다.
      cards: cards.map((card) => ({
        itemId: card.itemId,
        title: card.title.slice(0, 200),
        status: card.status,
        note: card.note === null ? null : card.note.slice(0, 400),
        tone: card.tone,
        dueLabel: card.dueLabel === null ? null : card.dueLabel.slice(0, 60),
        assignee: card.assignee?.name ?? null,
        conditionCode: card.conditionId === null ? null : conditionCodes.get(card.conditionId) ?? null,
        blockedBy: card.blockedBy.slice(0, 20).map((ref) => ref.title.slice(0, 200)),
        hasDraft: card.draft !== null,
      })),
    },
    onMove: (itemId, to) => {
      const card = cards.find((item) => item.itemId === itemId);
      if (card === undefined || card.status === to) return;
      // 자리 번호는 handleMove 가 보이는 목록으로 읽으므로 여기서도 같은 목록으로 센다.
      handleMove({
        itemId,
        from: card.status,
        to,
        toIndex: visibleCards.filter((item) => item.status === to).length,
      });
    },
    onApprove: (itemId) => {
      const card = cards.find((item) => item.itemId === itemId);
      if (card === undefined || card.status !== "approval") return;
      handleApprove(card, []);
    },
    onReject: (itemId, reason) => {
      // 기각은 카드를 Todo 열로 되돌린다. 서버가 기각으로 읽는 카드인지 여기서 한 번 더
      // 본다 — 승인 열에 있는 기계의 초안만 사유가 이력에 남는다.
      const card = cards.find((item) => item.itemId === itemId);
      if (card === undefined || card.status !== "approval" || card.origin !== "machine") return;
      handleReject({ itemId, reason });
    },
    onFocusCard: setFocusedCardId,
    onSelectDate: (date) => {
      setSelectedDate(date);
      onUrlStateChange({ boardFilterDate: date });
    },
  };

  return (
    <ReferenceProvider references={snapshot.references}>
    <div className={assistantOpen ? "board-shell is-assistant-open" : "board-shell"}>
      <BoardHeader boardDate={boardDate} cards={cards} site={snapshot.site} />

      {/* 메일에서 감지된 변경이 기존 평가서를 무너뜨렸을 때만 뜬다. 이슈가 없으면 아무것도
          그리지 않으므로 아래 브리핑이 그 자리를 그대로 이어받는다. */}
      <RiskIssueSection siteId={siteId} demo={demo} />

      <DailyBriefingPanel
        briefing={snapshot.briefing}
        onFocusCard={setFocusedCardId}
        onToggleCondition={handleToggleCondition}
        openConditionIds={openConditionIds}
      />

      <WeekCalendar
        calendar={snapshot.calendar}
        onNextRange={() => undefined}
        onPrevRange={() => undefined}
        onSelectDate={(date) => {
          setSelectedDate(date);
          onUrlStateChange({ boardFilterDate: date });
        }}
        onViewModeChange={(mode) => {
          setViewMode(mode);
          onUrlStateChange({ boardView: mode });
        }}
        selectedDate={selectedDate}
        viewMode={viewMode}
      />

      <KanbanBoard
        cards={visibleCards}
        columns={snapshot.columns}
        draggingCardId={draggingCardId}
        focusedCardId={focusedCardId}
        onApprove={handleApprove}
        onClearDateFilter={() => {
          setSelectedDate(null);
          onUrlStateChange({ boardFilterDate: null });
        }}
        onDragStateChange={setDraggingCardId}
        onFocusCard={setFocusedCardId}
        onMove={handleMove}
        onOpenCard={서랍열기}
        onRequestReject={setRejectTarget}
        openCardId={보일itemId}
        selectedDate={selectedDate}
        title={kanbanTitle}
        totalCount={cards.length}
      />

      <div aria-live="polite" className="board-status" role="status">
        {statusMessage}
      </div>

      {/* 서랍은 기각 대화 상자보다 **앞에** 둔다. 그 상자가 z-index 60 이라 서랍(43) 위에
          서야 하고, DOM 순서로도 뒤에 와야 초점 가두기가 서랍을 넘어 걸린다. */}
      {서랍카드 === null || 서랍원본 === null || 서랍큐값 === null ? null : (
        <EvidenceDrawer
          card={서랍카드}
          item={서랍원본}
          onClose={() => set열린카드(null)}
          siteName={snapshot.site.name}
          큐={서랍큐값}
        />
      )}

      {rejectTarget === null ? null : (
        <RejectDialog
          card={rejectTarget}
          onCancel={() => setRejectTarget(null)}
          onConfirm={handleReject}
        />
      )}

      {/* 좁은 화면에서만 보이는 뒷막. 넓은 화면에서는 CSS 가 숨긴다 */}
      <button
        aria-label="AI 도우미 닫기"
        className={assistantOpen ? "board-assistant-backdrop is-visible" : "board-assistant-backdrop"}
        onClick={() => setAssistantOpen(false)}
        tabIndex={assistantOpen ? 0 : -1}
        type="button"
      />

      <AssistantPanel board={assistantBridge} onClose={() => setAssistantOpen(false)} open={assistantOpen} />

      <AssistantFab onOpen={() => setAssistantOpen(true)} open={assistantOpen} />
    </div>
    </ReferenceProvider>
  );
}
