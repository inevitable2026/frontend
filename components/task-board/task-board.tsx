"use client";

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";

import { BOARD_AT, BOARD_DATE } from "@/lib/board/scene";
import { BOARD_SITE_ID } from "@/lib/board/site";

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
import { DailyBriefingPanel } from "./daily-briefing";
import { KanbanBoard } from "./kanban-board";
import { ReferenceProvider } from "./reference-chip";
import { RejectDialog } from "./reject-dialog";
import { 확정자이름 } from "./view-model";
import { WeekCalendar } from "./week-calendar";
import type {
  ApproveIntent,
  BoardColumnId,
  BoardSnapshot,
  BoardWatch,
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
const SITE_ID = BOARD_SITE_ID;



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
 * 보드 날짜를 고르면 그 현장의 카드가 전부 나오고, 다른 날을 고르면 그날이 기한인 카드만
 * 남는다. 서버 items 질의에 date 를 붙이지 않는 것과 짝이 되는 규칙이다 — 기한이 없는 승인
 * 카드까지 서버에서 걸러 버리면 칸반의 승인 열이 통째로 빈다.
 */
function isOnDate(card: TaskCard, boardDate: string, date: string): boolean {
  if (date === boardDate) return true;
  return card.dueBy !== null && card.dueBy.slice(0, 10) === date;
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
  onWatchChange,
}: {
  /**
   * 서버가 첫 그림 전에 이미 읽어 둔 보드 재료다.
   *
   * 이것이 있으면 화면은 요청을 한 번도 보내지 않고 곧바로 카드를 그린다. 없을 때만 예전처럼
   * 마운트 뒤에 읽는데, 그 길은 HTML 이 도착하고 번들을 내려받아 hydration 이 끝난 뒤에야
   * 첫 요청이 나가므로 데이터베이스 왕복 앞에 대기가 한 겹 더 붙는다.
   */
  initialSources?: BoardSources | null;
  /**
   * "연결된 맥락을 보고 있습니다" 를 왼쪽 사이드바가 그린다. 그 데이터는 보드 스냅샷 안에
   * 있고 그것을 읽는 곳은 여기뿐이라, 읽고 나서 위로 올려 준다. 콘솔이 따로 한 번 더 읽으면
   * 같은 요청이 두 벌이 되고 두 화면의 값이 갈라진다.
   */
  onWatchChange?: (watch: BoardWatch) => void;
}): JSX.Element {
  // 서버가 준 재료를 뷰모델로 옮기는 일은 첫 렌더에 한 번이면 된다. 재료는 요청마다 새로
  // 오는 객체라 의존성에 그대로 걸면 매 렌더에서 다시 계산된다.
  const 서버보드 = useMemo(
    () => (initialSources === null ? null : boardSnapshotOf(initialSources)),
    [initialSources],
  );

  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(서버보드);
  const [cards, setCards] = useState<TaskCard[]>(서버보드?.cards ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 다시 시도 단추가 올리는 값. 바뀌면 읽기 효과가 한 번 더 돈다. */
  const [attempt, setAttempt] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(서버보드?.selectedDate ?? null);
  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [openConditionIds, setOpenConditionIds] = useState<string[]>(() =>
    처음펼칠조건(서버보드),
  );
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<TaskCard | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  // AI 도우미 사이드바의 열림 여부. 패널은 흐름 밖에 서지만 껍데기에도 수식을 붙여
  // 두어야 열린 동안 칸반이 패널 아래로 숨지 않게 여백을 줄 수 있다.
  const [assistantOpen, setAssistantOpen] = useState(false);

  // 서버가 못 읽어 줬을 때, 그리고 다시 시도 단추를 눌렀을 때만 화면이 직접 읽는다.
  // setState 는 await 경계 뒤에서만 부른다.
  useEffect(() => {
    // 첫 회차에 서버가 준 보드가 이미 서 있으면 같은 것을 한 번 더 받아 올 이유가 없다.
    if (서버보드 !== null && attempt === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const next = await loadBoard(SITE_ID, BOARD_DATE, BOARD_AT);
        if (cancelled) return;
        setSnapshot(next);
        setCards(next.cards);
        setLoadError(null);
        setSelectedDate(next.selectedDate);
        setOpenConditionIds(처음펼칠조건(next));
      } catch (error) {
        if (cancelled) return;
        // 실패를 숨기고 지난 화면을 그대로 두지 않는다. 무엇이 잘못되었는지 적고 멈춘다.
        setSnapshot(null);
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
  }, [attempt, 서버보드]);

  /** 맥락 소스는 스냅샷을 읽어야 알 수 있으므로, 읽은 뒤에 왼쪽 사이드바로 올려 보낸다. */
  const watch = snapshot?.site.watch ?? null;
  useEffect(() => {
    if (watch !== null) onWatchChange?.(watch);
  }, [watch, onWatchChange]);

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
  const commit = useCallback(
    async (next: TaskCard[], message: string, persist: () => Promise<void>): Promise<void> => {
      const previous = cards;
      setCards(next);
      setStatusMessage(message);
      try {
        await persist();
      } catch (error) {
        setCards(previous);
        setStatusMessage(실패문구(error));
      }
    },
    [cards],
  );

  function handleMove(intent: CardMoveIntent): void {
    const card = cards.find((item) => item.itemId === intent.itemId);
    if (card === undefined) return;

    // 기계가 올린 초안을 승인 열에서 Todo 로 되돌리는 것은 서버에서 기각으로 읽힌다. 사유
    // 없이 보내면 400 이 돌아오므로, 이 조합만 가로채 사유를 묻는 대화 상자를 연다.
    if (intent.from === "approval" && intent.to === "todo" && card.origin === "machine") {
      setRejectTarget(card);
      return;
    }

    const laneOrder = laneOrderFor(cards, intent.itemId, intent.to, intent.toIndex);
    void commit(applyMove(cards, intent, laneOrder), moveMessage(card, intent), async () => {
      await moveCard(intent, laneOrder);
    });
  }

  function handleApprove(card: TaskCard, edits: DraftEdit[]): void {
    const message = moveMessage(card, {
      itemId: card.itemId,
      from: "approval",
      to: "done",
      toIndex: 0,
    });
    const laneOrder = laneOrderFor(cards, card.itemId, "done", 0);
    // 서버에는 식별자를 보내고 화면에는 이름을 적는다. 두 값이 같은 사람을 가리키므로
    // 새로 고침한 뒤에도 확정자가 바뀌지 않는다.
    const 확정자 = card.assignee?.id ?? "system";
    const 표시이름 = card.confirmedBy ?? 확정자이름(확정자) ?? "시스템";
    const 임시확정시각 = new Date().toISOString();

    void commit(
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
  }

  function handleReject(intent: RejectIntent): void {
    const card = cards.find((item) => item.itemId === intent.itemId);
    setRejectTarget(null);
    if (card === undefined) return;

    // 기각한 카드는 Todo 열 맨 위로 간다. 서버가 같은 자리로 옮기므로 값도 함께 보낸다.
    const laneOrder = laneOrderFor(cards, intent.itemId, "todo", 0);
    void commit(
      applyReject(cards, intent.itemId, laneOrder),
      `「${shorten(card.title)}」 초안을 기각했습니다. 사유가 기록되었고 카드는 ${COLUMN_WORD.todo}로 돌아갔습니다.`,
      async () => {
        await rejectCard(intent, laneOrder);
      },
    );
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
      handleMove({ itemId, from: card.status, to, toIndex: cards.filter((item) => item.status === to).length });
    },
    onApprove: (itemId) => {
      const card = cards.find((item) => item.itemId === itemId);
      if (card === undefined || card.status !== "approval") return;
      handleApprove(card, []);
    },
    onReject: (itemId, reason) => {
      // 기각은 카드를 Todo 열로 되돌린다. 승인 열에 있는 초안인지 여기서 한 번 더 본다.
      const card = cards.find((item) => item.itemId === itemId);
      if (card === undefined || card.status !== "approval") return;
      handleReject({ itemId, reason });
    },
    onFocusCard: setFocusedCardId,
    onSelectDate: setSelectedDate,
  };

  return (
    <ReferenceProvider references={snapshot.references}>
    <div className={assistantOpen ? "board-shell is-assistant-open" : "board-shell"}>
      <BoardHeader cards={cards} site={snapshot.site} />

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
