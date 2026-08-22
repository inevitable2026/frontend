"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import type { DocumentKind, ExtractedFields } from "@/lib/context/types";

type DocumentDetail = {
  document: {
    id: string;
    site_id: string;
    site_name: string;
    site_code: string;
    kind: DocumentKind;
    title: string;
    source_filename: string;
    mime: string | null;
    page_count: number | null;
    extracted: ExtractedFields | null;
    created_at: string;
  };
  file: { mime: string; filename: string; byteSize: number } | null;
  chunks: Array<{ id: string; seq: number; page: number | null; text: string }>;
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function savedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export function DocumentViewer({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 청크를 고르면 원본에서 그 쪽으로 옮겨 간다. 브라우저 PDF 뷰어는 주소의
  // #page 조각만 읽기 때문에, iframe 을 다시 그려야 쪽 이동이 실제로 일어난다.
  const [page, setPage] = useState(1);
  const [activeChunk, setActiveChunk] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // 문서마다 새로 마운트되므로(부모가 documentId 를 key 로 준다) 초기화는 따로 하지 않는다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/context/documents/${documentId}`);
      if (cancelled) return;
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "문서를 불러오지 못했습니다.");
        return;
      }
      setDetail(body as DocumentDetail);
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId]);

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

  const fileUrl = `/api/context/documents/${documentId}/file`;
  const extracted = detail?.document.extracted ?? null;
  const filled = extracted
    ? Object.entries(extracted).filter(([, value]) =>
        Array.isArray(value) ? value.length > 0 : Boolean(value),
      )
    : [];

  // .workspace 가 z-index 로 쌓임 맥락을 만들기 때문에, 그 안에 두면 아무리 높은
  // z-index 를 줘도 사이드바 아래에 깔린다. body 에 직접 붙여 그 맥락을 벗어난다.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="docview-backdrop" onMouseDown={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="docview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docview-title"
        onKeyDown={handleKeyDown}
      >
        <header className="docview-head">
          <div>
            <p className="eyebrow">{detail ? detail.document.site_name : "문서"}</p>
            <h2 id="docview-title">{detail ? detail.document.title : "불러오는 중…"}</h2>
            {detail ? (
              <p className="docview-meta">
                {detail.document.kind} · {detail.document.source_filename}
                {detail.document.page_count ? ` · ${detail.document.page_count}쪽` : ""}
                {detail.file ? ` · ${fileSize(detail.file.byteSize)}` : ""}
                {` · ${savedAt(detail.document.created_at)} 저장`}
              </p>
            ) : null}
          </div>
          <div className="docview-actions">
            {detail?.file ? (
              <a className="docview-link" href={fileUrl} target="_blank" rel="noreferrer">
                새 탭에서 열기
              </a>
            ) : null}
            <button ref={closeRef} type="button" className="docview-close" onClick={onClose}>
              닫기
            </button>
          </div>
        </header>

        {error ? <p className="context-message">{error}</p> : null}

        {detail ? (
          <div className="docview-body">
            <div className="docview-file">
              {detail.file ? (
                <iframe key={page} src={`${fileUrl}#page=${page}`} title={detail.document.title} />
              ) : (
                <p className="context-empty">
                  원본 파일이 남아 있지 않은 문서입니다. 읽어낸 값과 청크만 볼 수 있습니다.
                </p>
              )}
            </div>

            <div className="docview-side">
              {filled.length > 0 ? (
                <section className="docview-fields">
                  <h3>읽어낸 값</h3>
                  <dl>
                    {filled.map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              <section className="docview-chunks">
                <h3>검색 청크 {detail.chunks.length}개</h3>
                {detail.chunks.length === 0 ? (
                  <p className="context-empty">이 문서에는 저장된 청크가 없습니다.</p>
                ) : (
                  <ol>
                    {detail.chunks.map((chunk) => (
                      <li key={chunk.id}>
                        <button
                          type="button"
                          className={activeChunk === chunk.id ? "is-active" : ""}
                          onClick={() => {
                            setActiveChunk(chunk.id);
                            if (chunk.page) setPage(chunk.page);
                          }}
                        >
                          <span className="docview-chunk-meta">
                            #{chunk.seq}
                            {chunk.page ? ` · ${chunk.page}쪽` : ""}
                          </span>
                          <span className="docview-chunk-text">{chunk.text}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
