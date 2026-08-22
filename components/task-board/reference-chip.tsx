"use client";

// 브리핑 본문의 근거 표시 `[1]` 에 마우스를 올리면 그 자리에서 실제 내용을 편다.
// 근거를 따로 열어 보지 않고도 판단할 수 있어야 담당자가 보드를 신뢰하기 때문이다.
//
// 내부 식별자는 화면에 내보내지 않는다. 담당자에게 필요한 것은 근거가 무엇이었는지이지
// 기계가 그것을 어떻게 찾았는지가 아니다.
//
// 팝오버는 `position: fixed` 로 띄운다. 브리핑 카드에 `overflow: hidden` 이 걸려 있어
// 문서 흐름 안에 두면 잘린다.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import type { ReferenceDetail } from "./types";

const ReferenceContext = createContext<Record<string, ReferenceDetail>>({});

/** 조건 하나 안에서 근거에 매겨진 번호. 나온 차례대로 1부터 붙는다. */
const RefNumberContext = createContext<Record<string, number>>({});

export function RefNumberProvider({
  numbers,
  children,
}: {
  numbers: Record<string, number>;
  children: ReactNode;
}): JSX.Element {
  return <RefNumberContext.Provider value={numbers}>{children}</RefNumberContext.Provider>;
}

export function ReferenceProvider({
  references,
  children,
}: {
  references: Record<string, ReferenceDetail>;
  children: ReactNode;
}): JSX.Element {
  return <ReferenceContext.Provider value={references}>{children}</ReferenceContext.Provider>;
}

export function useReference(key: string): ReferenceDetail | null {
  const references = useContext(ReferenceContext);
  return references[key] ?? null;
}

/** 팝오버 한 장의 크기. 자리를 잡을 때 화면 밖으로 나가는지 미리 재는 데 쓴다. */
const POP_WIDTH = 340;
const POP_MAX_HEIGHT = 320;
const GAP = 8;
const EDGE = 12;

type Placement = { top: number; left: number; side: "below" | "above" };

function placeNear(rect: DOMRect): Placement {
  const 아래여백 = window.innerHeight - rect.bottom;
  const side: Placement["side"] = 아래여백 < POP_MAX_HEIGHT && rect.top > 아래여백 ? "above" : "below";
  const top = side === "below" ? rect.bottom + GAP : Math.max(EDGE, rect.top - GAP - POP_MAX_HEIGHT);
  const 최대왼쪽 = window.innerWidth - POP_WIDTH - EDGE;
  const left = Math.max(EDGE, Math.min(rect.left, 최대왼쪽));
  return { top, left, side };
}

/**
 * 근거 표시. 본문에는 `[1]` 처럼 번호만 나가고 내부 식별자는 드러내지 않는다.
 * 담당자에게 필요한 것은 그 근거가 무엇이었는지이지, 기계가 그것을 어떻게 찾았는지가 아니다.
 */
export function ReferenceMarker({ refId }: { refId: string }): JSX.Element | null {
  const detail = useReference(refId);
  const numbers = useContext(RefNumberContext);
  const number = numbers[refId];

  if (detail === null || number === undefined) return null;
  return <ReferenceChip label={`[${number}]`} refKey={refId} />;
}

function ReferenceChip({ label, refKey }: { label: string; refKey: string }): JSX.Element {
  const detail = useReference(refKey);
  const popId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const open = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const node = triggerRef.current;
    if (node === null) return;
    setPlacement(placeNear(node.getBoundingClientRect()));
  }, []);

  const close = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setPlacement(null);
  }, []);

  /**
   * 칩에서 팝오버로 마우스를 옮기는 사이에 틈이 있다. 곧바로 닫으면 그 틈을 지나는
   * 동안 사라져 본문을 읽거나 긁을 수 없다. 잠깐 기다렸다 닫는다.
   */
  const closeSoon = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setPlacement(null);
    }, 140);
  }, []);

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  // 열려 있는 동안 화면이 움직이면 자리가 어긋난다. 따라다니게 만들기보다 닫는 편이
  // 덜 성가시다 — 다시 올리면 그만이다.
  useEffect(() => {
    if (placement === null) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }

    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [placement, close]);

  // 사전에 없으면 아무것도 그리지 않는다. 빈 팝오버를 여는 표시는 방해만 된다.
  if (detail === null) return <></>;

  const isOpen = placement !== null;

  return (
    <span className="board-ref">
      <button
        aria-describedby={isOpen ? popId : undefined}
        aria-expanded={isOpen}
        className={`board-ref-trigger${isOpen ? " is-open" : ""}`}
        onBlur={close}
        onClick={() => (isOpen ? close() : open())}
        onFocus={open}
        onMouseEnter={open}
        onMouseLeave={closeSoon}
        ref={triggerRef}
        type="button"
      >
        {label}
      </button>

      {placement === null ? null : (
        <span
          className={`board-ref-pop is-${placement.side}`}
          id={popId}
          onMouseEnter={open}
          onMouseLeave={closeSoon}
          role="tooltip"
          style={{ top: placement.top, left: placement.left }}
        >
          <span className="board-ref-pop-head">
            <span className="board-ref-pop-kind">{detail.kindLabel}</span>
            {detail.origin === null ? null : (
              <span className="board-ref-pop-origin">출처 {detail.origin}</span>
            )}
          </span>
          <b className="board-ref-pop-title">{detail.title}</b>
          {detail.meta.length === 0 ? null : (
            <span className="board-ref-pop-meta">
              {detail.meta.map((row) => (
                <span className="board-ref-pop-row" key={row.term}>
                  <span className="board-ref-pop-term">{row.term}</span>
                  <span className="board-ref-pop-value">{row.value}</span>
                </span>
              ))}
            </span>
          )}
          {detail.excerpt.map((paragraph, index) => (
            <span className="board-ref-pop-excerpt" key={index}>
              {paragraph}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
