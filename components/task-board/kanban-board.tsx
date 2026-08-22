"use client";

import { useMemo, useState, type DragEvent, type JSX } from "react";

import { KanbanColumn } from "./kanban-column";
import type { BoardColumnId, BoardColumnMeta, CardMoveIntent, DraftEdit, TaskCard } from "./types";

type KanbanBoardProps = {
  /** "8월 19일 수요일" */
  title: string;
  columns: BoardColumnMeta[];
  /** 날짜 필터가 이미 적용된 목록 */
  cards: TaskCard[];
  totalCount: number;
  selectedDate: string | null;
  focusedCardId: string | null;
  draggingCardId: string | null;
  onClearDateFilter: () => void;
  onMove: (intent: CardMoveIntent) => void;
  onDragStateChange: (cardId: string | null) => void;
  onFocusCard: (cardId: string | null) => void;
  onApprove: (card: TaskCard, edits: DraftEdit[]) => void;
  onRequestReject: (card: TaskCard) => void;
};

const COLUMN_IDS: BoardColumnId[] = ["todo", "approval", "done"];

function toColumnId(value: string | undefined): BoardColumnId | null {
  const found = COLUMN_IDS.find((id) => id === value);
  return found ?? null;
}

/** 포인터 높이로 놓일 자리를 정한다. 끌고 있는 카드는 세지 않는다. */
function dropIndexFrom(body: HTMLElement, clientY: number, draggingCardId: string): number {
  const cards = Array.from(body.querySelectorAll<HTMLElement>(":scope > .board-card"));
  let index = 0;
  for (const element of cards) {
    if (element.dataset.itemId === draggingCardId) continue;
    const rect = element.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return index;
    index += 1;
  }
  return index;
}

export function KanbanBoard({
  title,
  columns,
  cards,
  totalCount,
  selectedDate,
  focusedCardId,
  draggingCardId,
  onClearDateFilter,
  onMove,
  onDragStateChange,
  onFocusCard,
  onApprove,
  onRequestReject,
}: KanbanBoardProps): JSX.Element {
  // 드래그가 지금 어느 열 위에 있고 어느 자리에 놓이는지만 자기 상태로 든다.
  // 카드의 실제 위치는 언제나 컨테이너의 cards 다.
  const [overColumnId, setOverColumnId] = useState<BoardColumnId | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const cardsByColumn = useMemo(() => {
    const grouped: Record<BoardColumnId, TaskCard[]> = { todo: [], approval: [], done: [] };
    for (const card of cards) grouped[card.status].push(card);
    for (const id of COLUMN_IDS) grouped[id].sort((a, b) => a.laneOrder - b.laneOrder);
    return grouped;
  }, [cards]);

  /** 키보드와 드래그가 같은 경로로 나간다. 자리 번호만 열 길이 안으로 눌러 준다. */
  function emitMove(intent: CardMoveIntent): void {
    const target = cardsByColumn[intent.to];
    const limit = intent.from === intent.to ? target.length - 1 : target.length;
    const toIndex = Math.min(Math.max(intent.toIndex, 0), Math.max(limit, 0));
    onMove({ ...intent, toIndex });
  }

  function clearDragMarks(): void {
    setOverColumnId(null);
    setDropIndex(null);
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const cardElement = target === null ? null : target.closest<HTMLElement>(".board-card");
    // 입력칸이나 버튼에서 시작한 끌기는 카드 이동이 아니다.
    if (target === null || cardElement === null || target !== cardElement) return;
    const itemId = cardElement.dataset.itemId;
    if (itemId === undefined) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
    onDragStateChange(itemId);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (draggingCardId === null) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const body = target === null ? null : target.closest<HTMLElement>(".board-column-body");
    if (body === null) return;
    const columnId = toColumnId(body.dataset.columnId);
    if (columnId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const next = dropIndexFrom(body, event.clientY, draggingCardId);
    if (columnId !== overColumnId) setOverColumnId(columnId);
    if (next !== dropIndex) setDropIndex(next);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    const itemId = draggingCardId ?? event.dataTransfer.getData("text/plain");
    const target = event.target instanceof HTMLElement ? event.target : null;
    const body = target === null ? null : target.closest<HTMLElement>(".board-column-body");
    const columnId = body === null ? null : toColumnId(body.dataset.columnId);
    const card = cards.find((item) => item.itemId === itemId) ?? null;
    if (body === null || columnId === null || card === null) {
      clearDragMarks();
      onDragStateChange(null);
      return;
    }
    event.preventDefault();
    emitMove({
      itemId: card.itemId,
      from: card.status,
      to: columnId,
      toIndex: dropIndexFrom(body, event.clientY, card.itemId),
    });
    clearDragMarks();
    onDragStateChange(null);
    onFocusCard(card.itemId);
  }

  function handleDragEnd(): void {
    clearDragMarks();
    onDragStateChange(null);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    clearDragMarks();
  }

  return (
    <div className="board-kanban-wrap">
      <div className="board-kanban-head">
        <h2 className="board-kanban-title">{title}</h2>
        <span className="board-kanban-count">{cards.length}건</span>
        {selectedDate === null ? null : (
          <button
            type="button"
            className="board-kanban-scope"
            title={`전체 ${totalCount}건 가운데 ${cards.length}건을 보고 있습니다`}
            onClick={onClearDateFilter}
          >
            선택한 날만 보기
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
        <span className="board-kanban-hint">
          카드를 끌어 옮기거나, 카드를 고른 뒤 <kbd className="board-kanban-hint-key">←</kbd>{" "}
          <kbd className="board-kanban-hint-key">→</kbd> 로 열을,{" "}
          <kbd className="board-kanban-hint-key">↑</kbd> <kbd className="board-kanban-hint-key">↓</kbd> 로 순서를
          바꿉니다
        </span>
      </div>

      <div
        className="board-kanban"
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      >
        {columns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            cards={cardsByColumn[column.id]}
            isOver={overColumnId === column.id}
            focusedCardId={focusedCardId}
            draggingCardId={draggingCardId}
            dropIndex={overColumnId === column.id ? dropIndex : null}
            onMove={emitMove}
            onFocusCard={onFocusCard}
            onApprove={onApprove}
            onRequestReject={onRequestReject}
            onPointerEnterColumn={setOverColumnId}
          />
        ))}
      </div>
    </div>
  );
}
