"use client";

import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { RejectIntent, TaskCard } from "./types";

type RejectDialogProps = {
  card: TaskCard;
  onCancel: () => void;
  onConfirm: (intent: RejectIntent) => void;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function RejectDialog({ card, onCancel, onConfirm }: RejectDialogProps): JSX.Element {
  const [reason, setReason] = useState("");
  const [showError, setShowError] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 열릴 때 입력란으로 초점을 옮긴다. 상태를 바꾸지 않으므로 set-state-in-effect 에 걸리지 않는다.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleConfirm(): void {
    const trimmed = reason.trim();
    if (trimmed === "") {
      // 사유가 비어 있으면 닫히지 않는다. 기록 자체가 나중에 방어 근거가 된다.
      setShowError(true);
      textareaRef.current?.focus();
      return;
    }
    onConfirm({ itemId: card.itemId, reason: trimmed });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    // 초점이 상자 밖으로 빠져나가지 않게 한다.
    const root = dialogRef.current;
    if (root === null) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && root.contains(active);

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    onCancel();
  }

  return (
    <div className="board-dialog-backdrop" onMouseDown={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="board-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="board-reject-title"
        aria-describedby="board-reject-desc"
        onKeyDown={handleKeyDown}
      >
        <h2 className="board-dialog-title" id="board-reject-title">
          기각에는 사유를 받습니다
        </h2>
        <p className="board-dialog-desc" id="board-reject-desc">
          「{card.title}」 초안을 기각합니다. 초안을 버릴 때 사유를 남기게 합니다. 담당자가 판단을 내렸다는 기록
          자체가 나중에 방어 근거가 됩니다.
        </p>
        <textarea
          ref={textareaRef}
          className="board-dialog-textarea"
          rows={4}
          value={reason}
          aria-label="기각 사유"
          aria-invalid={showError}
          aria-describedby={showError ? "board-reject-error" : undefined}
          placeholder="어디가 어떻게 잘못되었는지 적어 주십시오."
          onChange={(event) => {
            setReason(event.target.value);
            if (showError && event.target.value.trim() !== "") setShowError(false);
          }}
        />
        {showError ? (
          <p className="board-dialog-error" id="board-reject-error" role="alert">
            기각 사유를 적어 주십시오.
          </p>
        ) : null}
        <div className="board-dialog-actions">
          <button type="button" className="board-dialog-cancel" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="board-dialog-confirm" onClick={handleConfirm}>
            기각
          </button>
        </div>
      </div>
    </div>
  );
}
