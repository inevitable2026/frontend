"use client";

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

import { DraftPreview } from "./draft-preview";
import type { BadgeTone, BoardColumnId, CardMoveIntent, DraftEdit, TaskCard } from "./types";

/** 열은 왼쪽부터 이 순서다. ← → 이동의 이웃을 여기서 찾는다. */
const COLUMN_SEQUENCE: BoardColumnId[] = ["todo", "approval", "done"];

/** `.board-tag.is-*` — 태그는 alert · due · doc · ok 네 색만 쓴다. */
const TAG_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "",
  alert: " is-alert",
  due: " is-due",
  routine: "",
  ok: " is-ok",
  doc: " is-doc",
};

/** `.board-card-kind.is-*` — 유형 배지는 alert · due · routine · ok 네 색을 쓴다. */
const KIND_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "",
  alert: " is-alert",
  due: " is-due",
  routine: " is-routine",
  ok: " is-ok",
  doc: "",
};

type TaskCardProps = {
  card: TaskCard;
  /** 열 안 0-based 순번 */
  index: number;
  columnId: BoardColumnId;
  /** 순서 이동의 상한 */
  columnCount: number;
  isFocused: boolean;
  isDragging: boolean;
  onMove: (intent: CardMoveIntent) => void;
  onFocus: (cardId: string) => void;
  onApprove: (card: TaskCard, edits: DraftEdit[]) => void;
  onRequestReject: (card: TaskCard) => void;
};

export function TaskCardView({
  card,
  index,
  columnId,
  columnCount,
  isFocused,
  isDragging,
  onMove,
  onFocus,
  onApprove,
  onRequestReject,
}: TaskCardProps): JSX.Element {
  /** 초안 대비 수정분. 승인할 때 함께 올라간다. 열·순서는 컨테이너가 들고 있다. */
  const [edits, setEdits] = useState<DraftEdit[]>([]);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 옮긴 뒤에도 초점이 카드에 남는다. 상태를 바꾸지 않으므로 set-state-in-effect 에 걸리지 않는다.
  useEffect(() => {
    const element = cardRef.current;
    if (!isFocused || element === null) return;
    if (document.activeElement === element) return;
    element.focus({ preventScroll: true });
  }, [isFocused]);

  const isBlocked = card.blockedBy.length > 0;
  const blockedTitles = card.blockedBy.map((ref) => `「${ref.title}」`).join(" · ");
  const blockedReason = isBlocked ? `${blockedTitles}이 승인되어야 확정됩니다` : null;

  function handleEdit(edit: DraftEdit): void {
    setEdits((previous) => {
      const original = previous.find((item) => item.path === edit.path);
      const rest = previous.filter((item) => item.path !== edit.path);
      const before = original ? original.before : edit.before;
      if (before === edit.after) return rest;
      return [...rest, { path: edit.path, before, after: edit.after }];
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // 입력칸이나 버튼에 초점이 있을 때의 화살표는 그 요소의 것이다.
    if (event.target !== event.currentTarget) return;

    const key = event.key;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const here = COLUMN_SEQUENCE.indexOf(columnId);
      const next = key === "ArrowLeft" ? here - 1 : here + 1;
      if (here < 0 || next < 0 || next >= COLUMN_SEQUENCE.length) return;
      event.preventDefault();
      onMove({ itemId: card.itemId, from: columnId, to: COLUMN_SEQUENCE[next], toIndex: index });
      return;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      const next = key === "ArrowUp" ? index - 1 : index + 1;
      if (next < 0 || next >= columnCount) return;
      event.preventDefault();
      onMove({ itemId: card.itemId, from: columnId, to: columnId, toIndex: next });
    }
  }

  const classNames = ["board-card", `is-${card.tone}`];
  if (card.origin === "machine") classNames.push("is-ai");
  if (isDragging) classNames.push("is-dragging");
  if (isBlocked) classNames.push("is-blocked");

  // 소요 시간이 태그로 이미 나와 있지 않을 때만 예상 소요를 한 칸 덧붙인다.
  const showEstimate =
    card.estimatedMinutes !== null && !card.tags.some((tag) => tag.label.includes("분"));

  return (
    <div
      ref={cardRef}
      className={classNames.join(" ")}
      role="listitem"
      tabIndex={0}
      draggable
      data-item-id={card.itemId}
      aria-label={`${card.kind.label} · ${card.title}`}
      onKeyDown={handleKeyDown}
      onFocus={() => onFocus(card.itemId)}
    >
      <div className="board-card-top">
        <span className={`board-card-kind${KIND_TONE_CLASS[card.kind.tone]}`}>{card.kind.label}</span>
        {card.origin === "machine" ? (
          <span className="board-card-ai-mark">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v3" />
              <path d="M12 18v3" />
              <path d="M3 12h3" />
              <path d="M18 12h3" />
            </svg>
            자동 생성
          </span>
        ) : null}
        {card.delegable ? null : (
          <span className="board-card-lock" title={card.delegableReason ?? "이관 불가"}>
            이관 불가
          </span>
        )}
      </div>

      <div className="board-card-title">{card.title}</div>
      {card.note === null ? null : <div className="board-card-note">{card.note}</div>}

      <div className="board-card-meta">
        {card.tags.map((tag) => (
          <span key={tag.label} className={`board-tag${TAG_TONE_CLASS[tag.tone]}`}>
            {tag.label}
          </span>
        ))}
        {showEstimate ? <span className="board-tag">예상 {card.estimatedMinutes}분</span> : null}
      </div>

      {card.draft === null ? null : (
        <DraftPreview draft={card.draft} edits={edits} onEdit={handleEdit} />
      )}

      {card.rationale === null ? null : (
        <div className="board-card-why">{card.rationale.text}</div>
      )}

      {blockedReason === null ? null : <div className="board-card-blocked">{blockedReason}</div>}

      {/*
        승인·기각은 **승인 열에서만** 한다. 예전에는 초안이 붙어 있기만 하면 열을 가리지
        않고 두 단추를 그렸는데, 그러면 Todo 열의 카드를 승인 열을 거치지 않고 곧바로
        확정할 수 있었고 완료 카드에도 단추가 떠 있었다.

        기각은 거기서 한 번 더 좁혀 **기계가 올린 초안**에만 그린다. 서버는 그 경우에만
        기각으로 읽어 사유를 이력에 남기고(lib/board/transition.ts 의 isRejection), 사람이
        올려 둔 카드는 같은 요청을 그냥 이동으로 처리해 사유를 버린다. 단추를 그대로 두면
        화면은 "사유가 기록되었습니다" 라고 말하는데 아무 데도 남지 않는다.
      */}
      {card.status !== "approval" || card.draft === null ? null : (
        <div className="board-card-actions">
          <button
            type="button"
            className="board-button-approve"
            disabled={isBlocked}
            title={blockedReason ?? undefined}
            onClick={() => onApprove(card, edits)}
          >
            승인
          </button>
          {card.origin !== "machine" ? null : (
            <button type="button" className="board-button-reject" onClick={() => onRequestReject(card)}>
              기각
            </button>
          )}
        </div>
      )}

      {card.assignee === null && card.dueLabel === null ? null : (
        <div className="board-card-foot">
          {card.assignee === null ? (
            <span className="board-tag">시스템</span>
          ) : (
            <>
              <span
                className={`board-card-who${card.assignee.external ? " is-sub" : ""}`}
                title={card.delegable ? card.assignee.name : (card.delegableReason ?? card.assignee.name)}
              >
                {card.assignee.initial}
              </span>
              <span className="board-tag">{card.assignee.name}</span>
            </>
          )}
          {card.dueLabel === null ? null : (
            <span className={`board-card-when${card.dueIsHot ? " is-hot" : ""}`}>{card.dueLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
