"use client";

import { useEffect, useMemo, useState, type JSX } from "react";

import { BoardHeader } from "./board-header";
import { approveCard, loadBoard, moveCard, rejectCard } from "./board-data";
import { DailyBriefingPanel } from "./daily-briefing";
import { KanbanBoard } from "./kanban-board";
import { RejectDialog } from "./reject-dialog";
import { WeekCalendar } from "./week-calendar";
import type {
  ApproveIntent,
  BoardColumnId,
  BoardSnapshot,
  CalendarViewMode,
  CardMoveIntent,
  DraftEdit,
  RejectIntent,
  TaskCard,
} from "./types";

/**
 * 보드 한 장을 가리키는 질의. 픽스처에는 이 하루치만 들어 있고 `loadBoard` 도 두 인자를
 * 아직 보지 않는다. 서버가 붙으면 이 두 값이 그대로 질의 문자열이 된다.
 */
const SITE_ID = "site_gimpo_gochon_01";
const BOARD_DATE = "2026-08-19";

/** 열 안의 순서를 다시 매길 때 쓰는 간격. 두 카드 사이에 끼울 자리를 남긴다. */
const LANE_STEP = 10;

/** aria-live 문장에 넣는 제목의 최대 길이. 넘으면 잘라 `…` 를 붙인다 (아티팩트 1658줄). */
const TITLE_LIMIT = 26;

const LOADING_MESSAGE = "보드를 불러오는 중입니다.";
const ROLLBACK_MESSAGE = "저장하지 못했습니다. 화면을 원래대로 되돌렸습니다.";

/* ------------------------------------------------------------------ *
 * 서버 호출 자리 — 지금은 board-data.ts 의 스텁이 곧바로 성공한다.
 * 되돌리는 분기는 코드로만 존재한다.
 * ------------------------------------------------------------------ */

// TODO(server): PATCH /api/board/cards/:itemId
async function persistMove(intent: CardMoveIntent): Promise<void> {
  await moveCard(intent);
}

// TODO(server): POST /api/board/cards/:itemId/approve
async function persistApprove(intent: ApproveIntent): Promise<void> {
  await approveCard(intent);
}

// TODO(server): POST /api/board/cards/:itemId/reject
async function persistReject(intent: RejectIntent): Promise<void> {
  await rejectCard(intent);
}

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

/** 한 열의 `laneOrder` 를 0부터 다시 매긴다. 목록은 이미 놓일 순서대로 들어온다. */
function renumber(column: TaskCard[]): TaskCard[] {
  return column.map((card, index) => ({ ...card, laneOrder: (index + 1) * LANE_STEP }));
}

function columnOf(cards: TaskCard[], columnId: BoardColumnId): TaskCard[] {
  return cards
    .filter((card) => card.status === columnId)
    .sort((left, right) => left.laneOrder - right.laneOrder);
}

/**
 * 카드를 옮긴 목록을 새로 만든다.
 *
 * 승인 열에서 Todo 로 끌어오면 `origin` 이 `"human"` 이 된다 — 사람이 직접 다시 쓴다는 뜻이므로
 * `is-ai` 표식이 떨어진다. 초안은 버리지 않고 카드에 그대로 남긴다 (계약 4.1 절).
 */
function applyMove(cards: TaskCard[], intent: CardMoveIntent): TaskCard[] {
  const moving = cards.find((card) => card.itemId === intent.itemId);
  if (moving === undefined) return cards;

  const rest = cards.filter((card) => card.itemId !== intent.itemId);
  const target = columnOf(rest, intent.to);
  const index = Math.min(Math.max(intent.toIndex, 0), target.length);

  const next: TaskCard = {
    ...moving,
    status: intent.to,
    origin:
      intent.from === "approval" && intent.to === "todo" && moving.origin === "machine"
        ? "human"
        : moving.origin,
  };
  target.splice(index, 0, next);

  const touched = new Set<BoardColumnId>([intent.from, intent.to]);
  const renumbered = new Map<string, TaskCard>();
  for (const card of renumber(target)) renumbered.set(card.itemId, card);
  if (intent.from !== intent.to) {
    for (const card of renumber(columnOf(rest, intent.from))) renumbered.set(card.itemId, card);
  }

  const others = rest.filter((card) => !touched.has(card.status));
  return [...others, ...renumbered.values()];
}

/**
 * 초안을 승인한다. 카드는 완료 열 **맨 위**로 가고 `confirmedBy` · `confirmedAt` 이 채워진다.
 * 이 카드를 `blockedBy` 로 걸고 있던 카드는 대기가 풀린다 (계약 4.2 절).
 */
function applyApprove(cards: TaskCard[], card: TaskCard, confirmedAt: string): TaskCard[] {
  const moved = applyMove(cards, {
    itemId: card.itemId,
    from: card.status,
    to: "done",
    toIndex: 0,
  });

  return moved.map((item) => {
    if (item.itemId === card.itemId) {
      return {
        ...item,
        confirmedBy: item.confirmedBy ?? item.assignee?.name ?? "시스템",
        confirmedAt,
      };
    }
    if (item.blockedBy.some((ref) => ref.itemId === card.itemId)) {
      return { ...item, blockedBy: item.blockedBy.filter((ref) => ref.itemId !== card.itemId) };
    }
    return item;
  });
}

/** 기각한 카드는 목록에서 내려간다. 그 카드를 기다리던 카드의 대기도 함께 푼다. */
function applyReject(cards: TaskCard[], itemId: string): TaskCard[] {
  return cards
    .filter((card) => card.itemId !== itemId)
    .map((card) =>
      card.blockedBy.some((ref) => ref.itemId === itemId)
        ? { ...card, blockedBy: card.blockedBy.filter((ref) => ref.itemId !== itemId) }
        : card,
    );
}

/**
 * 날짜 필터.
 *
 * 픽스처는 보드 하루치(`BOARD_DATE`)만 들고 있다. 그래서 **보드 날짜를 고르면 올라온 카드가 전부**
 * 나오고, 다른 날을 고르면 그날이 기한인 카드만 남는다. 서버가 붙으면 `loadBoard(siteId, date)` 가
 * 그날의 스냅숏을 새로 가져오므로 이 갈래는 사라진다.
 */
function isOnDate(card: TaskCard, boardDate: string, date: string): boolean {
  if (date === boardDate) return true;
  return card.dueBy !== null && card.dueBy.slice(0, 10) === date;
}

/* ------------------------------------------------------------------ *
 * 컨테이너
 * ------------------------------------------------------------------ */

export function TaskBoard(): JSX.Element {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [cards, setCards] = useState<TaskCard[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [openConditionIds, setOpenConditionIds] = useState<string[]>([]);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<TaskCard | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  // AI 도우미 패널은 다음 회차다. 지금은 여는 자리만 잡아 둔다 — `.board-shell` 이
  // `position: relative` 로 그 패널을 받을 자리이므로 상태를 껍데기의 수식으로 내보낸다.
  const [assistantOpen, setAssistantOpen] = useState(false);

  // 첫 그림 뒤에 보드를 읽는다. setState 는 await 경계 뒤에서만 부른다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await loadBoard(SITE_ID, BOARD_DATE);
      if (cancelled) return;
      setSnapshot(next);
      setCards(next.cards);
      setSelectedDate(next.selectedDate);
      setOpenConditionIds(
        next.briefing.conditions
          .filter((condition) => condition.defaultOpen)
          .map((condition) => condition.conditionId),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ctrl+K 로 열고 Esc 로 닫는다 (아티팩트 317줄). 효과는 리스너만 걸고 상태는 핸들러가 바꾼다.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setAssistantOpen((previous) => !previous);
        return;
      }
      if (event.key === "Escape") setAssistantOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const boardDate = snapshot === null ? BOARD_DATE : snapshot.selectedDate;

  const visibleCards = useMemo(() => {
    if (selectedDate === null) return cards;
    return cards.filter((card) => isOnDate(card, boardDate, selectedDate));
  }, [cards, boardDate, selectedDate]);

  const kanbanTitle = useMemo(() => {
    if (snapshot === null) return "";
    if (selectedDate === null) return snapshot.calendar.rangeLabel;
    if (selectedDate === snapshot.selectedDate) return snapshot.kanbanTitle;
    const day = snapshot.calendar.days.find((item) => item.date === selectedDate);
    if (day === undefined) return snapshot.calendar.rangeLabel;
    return `${Number(day.date.split("-")[1])}월 ${day.dayNumber}일 ${day.dow}요일`;
  }, [snapshot, selectedDate]);

  /** 낙관적 갱신 한 자리. 화면을 먼저 바꾸고, 저장이 엎어지면 이전 목록으로 되돌린다. */
  async function commit(
    next: TaskCard[],
    message: string,
    persist: () => Promise<void>,
  ): Promise<void> {
    const previous = cards;
    setCards(next);
    setStatusMessage(message);
    try {
      await persist();
    } catch {
      setCards(previous);
      setStatusMessage(ROLLBACK_MESSAGE);
    }
  }

  function handleMove(intent: CardMoveIntent): void {
    const card = cards.find((item) => item.itemId === intent.itemId);
    if (card === undefined) return;
    void commit(applyMove(cards, intent), moveMessage(card, intent), () => persistMove(intent));
  }

  function handleApprove(card: TaskCard, edits: DraftEdit[]): void {
    const message = moveMessage(card, {
      itemId: card.itemId,
      from: "approval",
      to: "done",
      toIndex: 0,
    });
    void commit(applyApprove(cards, card, new Date().toISOString()), message, () =>
      persistApprove({ itemId: card.itemId, edits }),
    );
  }

  function handleReject(intent: RejectIntent): void {
    const card = cards.find((item) => item.itemId === intent.itemId);
    setRejectTarget(null);
    if (card === undefined) return;
    void commit(
      applyReject(cards, intent.itemId),
      `「${shorten(card.title)}」 초안을 기각했습니다. 사유가 기록되었습니다.`,
      () => persistReject(intent),
    );
  }

  function handleToggleCondition(conditionId: string): void {
    setOpenConditionIds((previous) =>
      previous.includes(conditionId)
        ? previous.filter((id) => id !== conditionId)
        : [...previous, conditionId],
    );
  }

  if (snapshot === null) {
    return (
      <div className="board-shell">
        <div aria-live="polite" className="board-status" role="status">
          {LOADING_MESSAGE}
        </div>
      </div>
    );
  }

  return (
    <div className={assistantOpen ? "board-shell is-assistant-open" : "board-shell"}>
      <BoardHeader
        cards={cards}
        onViewModeChange={setViewMode}
        site={snapshot.site}
        viewMode={viewMode}
      />

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
        onSelectDate={setSelectedDate}
        onViewModeChange={setViewMode}
        selectedDate={selectedDate}
        viewMode={viewMode}
      />

      <KanbanBoard
        cards={visibleCards}
        columns={snapshot.columns}
        draggingCardId={draggingCardId}
        focusedCardId={focusedCardId}
        onApprove={handleApprove}
        onClearDateFilter={() => setSelectedDate(null)}
        onDragStateChange={setDraggingCardId}
        onFocusCard={setFocusedCardId}
        onMove={handleMove}
        onRequestReject={setRejectTarget}
        selectedDate={selectedDate}
        title={kanbanTitle}
        totalCount={cards.length}
      />

      <div aria-live="polite" className="board-status" role="status">
        {statusMessage}
      </div>

      {rejectTarget === null ? null : (
        <RejectDialog
          card={rejectTarget}
          onCancel={() => setRejectTarget(null)}
          onConfirm={handleReject}
        />
      )}
    </div>
  );
}
