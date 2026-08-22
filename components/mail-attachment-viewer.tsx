"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import type { MailAttachment } from "@/lib/context/mail-threads";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

const ATTACH_STATE_NOTE: Record<MailAttachment["상태"], string> = {
  적재됨: "이 첨부는 문서함에 적재되어 검색에 걸립니다.",
  적재대기: "아직 문서함에 적재되지 않아 검색에 걸리지 않습니다.",
  제외: "적재 대상에서 빼 둔 첨부입니다. 문서함에는 들어가지 않습니다.",
};

/**
 * 메일 첨부 미리보기.
 *
 * 문서함의 DocumentViewer 와 달리 원본 파일을 iframe 으로 띄우지 않는다. 메일함이 아직
 * 목업이라 첨부에 대응하는 PDF 파일 자체가 없기 때문이다. 대신 lib/context/mail-threads.ts
 * 에 적어 둔 쪽 내용을 종이 모양으로 다시 그려서, 그 첨부에 무엇이 적혀 있는지를 보여준다.
 *
 * 커넥터가 붙어 실제 파일이 생기면, 이 컴포넌트를 지우고 DocumentViewer 를 쓰거나
 * 아래 종이 자리에 iframe 을 놓으면 된다.
 */
export function MailAttachmentViewer({
  attachment,
  siteName,
  onClose,
}: {
  attachment: MailAttachment;
  siteName: string;
  onClose: () => void;
}) {
  const pages = attachment.미리보기;
  const [pageIndex, setPageIndex] = useState(0);
  const page = pages[pageIndex] ?? null;

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

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
    onClose();
  }

  // .workspace 가 쌓임 맥락을 만들기 때문에 그 안에 두면 사이드바 아래에 깔린다.
  // DocumentViewer 와 같은 이유로 body 에 직접 붙인다.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="docview-backdrop" onMouseDown={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="docview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mailfile-title"
        onKeyDown={handleKeyDown}
      >
        <header className="docview-head">
          <div>
            <p className="eyebrow">{siteName} · 메일 첨부</p>
            <h2 id="mailfile-title">{attachment.이름}</h2>
            <p className="docview-meta">
              {attachment.종류} · 전체 {attachment.쪽수}쪽 · {attachment.상태}
            </p>
          </div>
          <div className="docview-actions">
            <span className="mail-badge">목업 — 원본 파일 대신 내용을 다시 그린 화면입니다</span>
            <button ref={closeRef} type="button" className="docview-close" onClick={onClose}>
              닫기
            </button>
          </div>
        </header>

        <div className="docview-body">
          <div className="docview-file mailfile-paper">
            {page ? (
              <article className="mailfile-page">
                <h3>{page.제목}</h3>
                {page.문단.map((줄, i) => (
                  <p key={i}>{줄}</p>
                ))}
                {page.표.length > 0 ? (
                  <dl className="mailfile-table">
                    {page.표.map((행) => (
                      <div key={행.항목}>
                        <dt>{행.항목}</dt>
                        <dd>{행.값}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <p className="mailfile-foot">
                  {page.쪽} / {attachment.쪽수}
                </p>
              </article>
            ) : (
              <p className="context-empty">이 첨부는 아직 미리보기 내용이 없습니다.</p>
            )}
          </div>

          <div className="docview-side">
            <section className="docview-fields">
              <h3>
                쪽 고르기 {pages.length}/{attachment.쪽수}쪽
              </h3>
              {pages.length === 0 ? (
                <p className="context-empty">채워 둔 쪽이 없습니다.</p>
              ) : (
                <ol className="mailfile-pages">
                  {pages.map((p, i) => (
                    <li key={p.쪽}>
                      <button
                        type="button"
                        className={i === pageIndex ? "is-active" : ""}
                        onClick={() => setPageIndex(i)}
                      >
                        <span className="mailfile-page-no">{p.쪽}쪽</span>
                        <span className="mailfile-page-title">{p.제목}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <p className="context-note">
              {ATTACH_STATE_NOTE[attachment.상태]}
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
