"use client";

import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

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

/**
 * 카드 안에서 클릭이 자기 것인 요소들.
 *
 * 승인·기각 단추, 초안 미리보기의 접기 손잡이와 입력칸(draft-preview.tsx), 근거
 * 칩(reference-chip.tsx)이 카드 본문 네 군데에 흩어져 있다. 단추마다 stopPropagation 을
 * 다는 방식은 나중에 하나만 빠뜨려도 타이핑 도중이나 초안을 펼치는 중에 서랍이 열린다.
 * 그래서 뿌리에서 한 번 거른다. 같은 파일군이 이미 "이 이벤트가 나에게서 났나" 를 두 번
 * 판정하고 있고(아래 handleKeyDown, kanban-board 의 handleDragStart) 그 어투를 그대로 쓴다.
 *
 * `summary` 가 목록에 있는 이유: 초안 미리보기가 `<details>` 라 그 손잡이를 누르면 초안이
 * 펼쳐지는데, 거르지 않으면 같은 누름이 서랍까지 연다.
 *
 * `event.target !== event.currentTarget` 으로 좁히지 않는 이유는 반대쪽에 있다. 그러면
 * 제목 글자를 눌렀을 때 서랍이 안 열린다 — 사람이 카드를 여는 가장 자연스러운 자리다.
 */
const 자기클릭_SELECTOR =
  "button, a[href], input, textarea, select, label, summary, [role='button']";

type TaskCardProps = {
  card: TaskCard;
  /** 열 안 0-based 순번 */
  index: number;
  columnId: BoardColumnId;
  /** 순서 이동의 상한 */
  columnCount: number;
  isFocused: boolean;
  isDragging: boolean;
  /** 증거 서랍이 지금 이 카드를 열고 있다. 초점과는 다른 일이라 표식만 준다. */
  isOpen: boolean;
  onMove: (intent: CardMoveIntent) => void;
  onFocus: (cardId: string) => void;
  onApprove: (card: TaskCard, edits: DraftEdit[]) => void;
  onRequestReject: (card: TaskCard) => void;
  /** 증거 서랍을 연다. 어느 열에서 열었는지가 큐 모드의 열이 된다. */
  onOpen: (cardId: string, columnId: BoardColumnId) => void;
};

export function TaskCardView({
  card,
  index,
  columnId,
  columnCount,
  isFocused,
  isDragging,
  isOpen,
  onMove,
  onFocus,
  onApprove,
  onRequestReject,
  onOpen,
}: TaskCardProps): JSX.Element {
  /** 초안 대비 수정분. 승인할 때 함께 올라간다. 열·순서는 컨테이너가 들고 있다. */
  const [edits, setEdits] = useState<DraftEdit[]>([]);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /**
   * 이번 누름이 끌기로 자랐나 (AC-5).
   *
   * 이 보드의 끌기는 pointer 기반이 아니라 **네이티브 HTML5 DnD** 다(아래 draggable +
   * kanban-board.tsx 의 컨테이너 onDragStart). 끌기가 성립하면 브라우저는 그 뒤에 click 을
   * 내보내지 않으므로 판정자는 이미 있다. 여기서는 그 판정을 한 겹 확인만 한다.
   *
   * 좌표 임계값을 고르지 않은 이유: 매직 넘버를 만들어야 하고, 그 값은 "끌기가 시작되었나"
   * 가 아니라 "손이 흔들렸나" 를 재게 되어 좁은 범위에서 시작해 드롭까지 끝낸 진짜 드래그를
   * 클릭으로 오인한다.
   *
   * 내리는 자리를 dragend 가 아니라 **다음 pointerdown** 으로 잡은 것이 핵심이다. dragend 는
   * click 보다 먼저 오므로 거기서 지우면 확인이 무의미해진다.
   */
  const 끌었나 = useRef(false);

  /**
   * 옮긴 뒤에도 초점이 카드에 남는다. 상태를 바꾸지 않으므로 set-state-in-effect 에 걸리지 않는다.
   *
   * 이 효과는 **마운트할 때도** 돈다. 열을 옮긴 카드는 열마다 다른 section 안에서 다시
   * 마운트되므로(kanban-column.tsx 의 key) 화살표 이동의 초점 복귀가 바로 그 성질에 기댄다.
   * 그런데 같은 성질이 큐 모드에서는 해가 된다 — 서랍에서 승인한 카드도 완료 열에서 다시
   * 마운트되고, isFocused 가 그대로 true 라 초점을 뒷막 뒤로 끌어간다. 마지막 장이면 서랍이
   * 그 자리에 머물러(AC-16 의 끝 화면) 초점을 되찾을 계기조차 없고 그 뒤의 Tab 이 모달 뒤
   * 보드를 훑는다.
   *
   * 그래서 열려 있는 대화 상자가 초점을 들고 있으면 빼앗지 않는다. prop 으로 "서랍이
   * 열렸나" 를 받지 않은 이유는 그 값이 의존성에 들어가는 순간 **닫히는 commit 에서 이
   * 효과가 한 번 더 돌기** 때문이다. 그때 서랍은 이미 돌아갈 자리를 골라 초점을 놓아 둔
   * 뒤라(evidence-drawer.tsx 의 정리 효과) 그 선택을 도로 빼앗는다. 지금 초점이 어디
   * 있는지는 반응형 값이 아니므로 효과가 실제로 도는 순간에만 읽으면 된다.
   */
  useEffect(() => {
    const element = cardRef.current;
    if (!isFocused || element === null) return;
    const 지금 = document.activeElement;
    if (지금 === element) return;
    if (지금 instanceof HTMLElement && 지금.closest("[role='dialog']") !== null) return;
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

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    if (끌었나.current) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target !== null && target.closest(자기클릭_SELECTOR) !== null) return;
    onOpen(card.itemId, columnId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // 입력칸이나 버튼에 초점이 있을 때의 화살표는 그 요소의 것이다.
    if (event.target !== event.currentTarget) return;

    const key = event.key;

    // Enter 와 Space 둘 다 연다. 카드가 tabIndex={0} 짜리 role="listitem" 이라 사용자는 두
    // 키를 다 눌러 본다. Space 는 원래 페이지 스크롤이라 막아야 하고, 위 가드가 초안
    // textarea 의 Enter 를 이미 걸러 주므로 여기서 다시 볼 것이 없다.
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      onOpen(card.itemId, columnId);
      return;
    }

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
  if (isOpen) classNames.push("is-open");

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
      onPointerDown={() => {
        끌었나.current = false;
      }}
      onDragStart={() => {
        // 컨테이너의 onDragStart 와 버블링으로 함께 뜬다. 그쪽의 target !== cardElement
        // 검사에는 영향이 없다 — 여기서는 상태를 읽지도 바꾸지도 않는다.
        끌었나.current = true;
      }}
      onClick={handleClick}
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
        {/* 커서는 하나뿐이라 끌기와 열기를 다 말할 수 없다. pointer 로 바꾸면 끌 수 있다는
            사실을 잃으므로(명세 제약 6) cursor: grab 을 그대로 두고, 잃는 쪽을 글자로 메운다.
            CSS 가 :hover 와 :focus-visible 에서만 띄우되 자리는 늘 차지한다 — 뜰 때마다
            줄이 흔들리면 그것대로 읽기 어렵다. 키보드 사용자도 알아야 하므로 :hover 만으로
            좁히지 않는다. */}
        <span className="board-card-open-hint" aria-hidden="true">
          근거 보기
        </span>
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
