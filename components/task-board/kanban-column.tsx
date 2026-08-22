"use client";

import type { JSX } from "react";

import { TaskCardView } from "./task-card";
import type { BoardColumnId, BoardColumnMeta, CardMoveIntent, DraftEdit, TaskCard } from "./types";

type KanbanColumnProps = {
  column: BoardColumnMeta;
  /** laneOrder 로 이미 정렬된 목록 */
  cards: TaskCard[];
  isOver: boolean;
  focusedCardId: string | null;
  draggingCardId: string | null;
  onMove: (intent: CardMoveIntent) => void;
  onFocusCard: (cardId: string | null) => void;
  onApprove: (card: TaskCard, edits: DraftEdit[]) => void;
  onRequestReject: (card: TaskCard) => void;
  onPointerEnterColumn: (columnId: BoardColumnId) => void;
  /** 끌고 온 카드가 놓일 자리. 계약에 없는 덧붙임이라 선택 값이다. */
  dropIndex?: number | null;
};

export function KanbanColumn({
  column,
  cards,
  isOver,
  focusedCardId,
  draggingCardId,
  onMove,
  onFocusCard,
  onApprove,
  onRequestReject,
  onPointerEnterColumn,
  dropIndex = null,
}: KanbanColumnProps): JSX.Element {
  const bodyClassNames = ["board-column-body"];
  if (isOver) bodyClassNames.push("is-over");
  if (cards.length === 0) bodyClassNames.push("is-empty");

  const showPlaceholder = isOver && draggingCardId !== null && dropIndex !== null;
  const placeholder = <div className="board-placeholder" key="board-placeholder" aria-hidden="true" />;

  const items: JSX.Element[] = [];
  let slot = 0;
  cards.forEach((card, index) => {
    const isDragging = card.itemId === draggingCardId;
    if (!isDragging && showPlaceholder && dropIndex === slot) items.push(placeholder);
    items.push(
      <TaskCardView
        key={card.itemId}
        card={card}
        index={index}
        columnId={column.id}
        columnCount={cards.length}
        isFocused={card.itemId === focusedCardId}
        isDragging={isDragging}
        onMove={onMove}
        onFocus={onFocusCard}
        onApprove={onApprove}
        onRequestReject={onRequestReject}
      />,
    );
    if (!isDragging) slot += 1;
  });
  if (showPlaceholder && dropIndex !== null && dropIndex >= slot) items.push(placeholder);

  return (
    <section className="board-column" data-column-id={column.id}>
      <div className="board-column-head">
        <i className={`board-column-dot is-${column.tone}`} aria-hidden="true" />
        <b className="board-column-name">{column.label}</b>
        <span className="board-column-count">{cards.length}</span>
        <span className="board-column-role">{column.role}</span>
      </div>
      <div
        className={bodyClassNames.join(" ")}
        role="list"
        aria-label={`${column.label} 열 · ${column.role} · ${cards.length}건`}
        data-column-id={column.id}
        data-empty-message={column.emptyMessage}
        onDragEnter={() => onPointerEnterColumn(column.id)}
        onPointerEnter={() => {
          if (draggingCardId !== null) onPointerEnterColumn(column.id);
        }}
      >
        {items}
      </div>
    </section>
  );
}
