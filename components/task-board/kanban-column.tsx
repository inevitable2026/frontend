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
  /** 증거 서랍이 열고 있는 카드. 초점과 다른 일이라 값을 따로 내린다. */
  openCardId: string | null;
  onMove: (intent: CardMoveIntent) => void;
  onFocusCard: (cardId: string | null) => void;
  onApprove: (card: TaskCard, edits: DraftEdit[]) => void;
  onRequestReject: (card: TaskCard) => void;
  onOpenCard: (cardId: string, columnId: BoardColumnId) => void;
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
  openCardId,
  onMove,
  onFocusCard,
  onApprove,
  onRequestReject,
  onOpenCard,
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
        isOpen={card.itemId === openCardId}
        onMove={onMove}
        onFocus={onFocusCard}
        onApprove={onApprove}
        onRequestReject={onRequestReject}
        onOpen={onOpenCard}
      />,
    );
    if (!isDragging) slot += 1;
  });
  if (showPlaceholder && dropIndex !== null && dropIndex >= slot) items.push(placeholder);

  // .board-column-body 의 tabIndex={-1} 은 증거 서랍이 닫힐 때의 착지점이다. 돌아갈 카드가
  // 사라져 있으면(승인되어 완료 열로 갔거나 날짜 필터에 걸렸으면) 초점이 body 로 떨어져
  // 키보드 사용자가 길을 잃는다. -1 이라 탭 순서에는 들어가지 않는다 — 0 이면 탭 이동이
  // 열 하나마다 한 번씩 멈춘다.
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
        tabIndex={-1}
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
