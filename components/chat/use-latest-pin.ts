"use client";

// 답이 길어지면 화면이 저절로 따라 내려간다. 다만 사용자가 위로 올려 읽고 있을 때는
// 끌어내리지 않고, 대신 "새 내용이 도착했어요" 알약을 띄워 스스로 내려가게 둔다.
//
// 이 논리는 원래 콘솔 파일 안에 있었다. 챗봇이 훅과 컴포넌트로 쪼개지면서 갈 곳을 잃어
// 여기로 옮겼다 — 챗봇 탭과 AI 사이드바가 같은 규칙을 쓰려면 한곳에 있어야 한다.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 맨 아래로 데려가는 스크롤이 끝났다고 볼 때까지 기다리는 시간. */
const SCROLL_SETTLE_MS = 800;

/** 이만큼 가려져 있으면 아직 보고 있는 것으로 치지 않는다. */
const VISIBLE_MARGIN_PX = 12;

export type LatestPin = {
  /** 대화의 맨 끝에 두는 표식. 이것이 보이면 사용자가 최신 내용을 보고 있는 것이다. */
  anchorRef: RefObject<HTMLDivElement | null>;
  /** 입력줄. 화면 아래에 고정되어 있어 그 윗선까지만 "보인다"고 셈한다. */
  composerRef: RefObject<HTMLFormElement | null>;
  /** 사용자가 위로 올라가 최신 내용에서 떨어져 있는가. */
  isAwayFromLatest: boolean;
  /** 떨어져 있는 동안 새 내용이 도착했는가. */
  hasUnseenContent: boolean;
  scrollToLatest: () => void;
};

export function useLatestPin({
  enabled,
  hasResponseContent,
  revision,
}: {
  /** 챗봇 화면이 열려 있고 대화가 시작된 동안에만 따라다닌다. */
  enabled: boolean;
  hasResponseContent: boolean;
  /** 답이 늘어날 때마다 값이 바뀌는 표식. 이 값이 바뀌면 따라갈지 다시 판단한다. */
  revision: string;
}): LatestPin {
  const [isAwayFromLatest, setIsAwayFromLatest] = useState(false);
  const [hasUnseenContent, setHasUnseenContent] = useState(false);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const followsLatest = useRef(false);
  const isScrollingToLatest = useRef(false);
  const scrollResetTimer = useRef<number | undefined>(undefined);

  const latestIsVisible = useCallback(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return true;

    const composerTop = composerRef.current?.getBoundingClientRect().top ?? window.innerHeight;
    const visibleBottom = Math.min(composerTop, window.innerHeight);
    return anchor.getBoundingClientRect().top <= visibleBottom - VISIBLE_MARGIN_PX;
  }, []);

  const scrollToLatest = useCallback(() => {
    followsLatest.current = true;
    isScrollingToLatest.current = true;
    setIsAwayFromLatest(false);
    setHasUnseenContent(false);

    if (scrollResetTimer.current !== undefined) window.clearTimeout(scrollResetTimer.current);

    window.requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    });

    scrollResetTimer.current = window.setTimeout(() => {
      isScrollingToLatest.current = false;
    }, SCROLL_SETTLE_MS);
  }, []);

  // 사용자가 스크롤할 때마다 최신 내용을 보고 있는지 다시 센다.
  useEffect(() => {
    if (!enabled) return;

    let frame: number | undefined;

    function measure(): void {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const visible = latestIsVisible();

        // 우리가 데려가는 중이라면 도착할 때까지 사용자의 뜻으로 오해하지 않는다.
        if (isScrollingToLatest.current) {
          if (!visible) return;
          isScrollingToLatest.current = false;
          followsLatest.current = true;
          setIsAwayFromLatest(false);
          setHasUnseenContent(false);
          return;
        }

        followsLatest.current = visible;
        setIsAwayFromLatest(!visible);
        if (visible) setHasUnseenContent(false);
      });
    }

    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [enabled, latestIsVisible]);

  // 답이 늘어날 때마다, 따라가고 있었으면 끝까지 데려가고 아니면 알약을 켠다.
  useEffect(() => {
    if (!enabled || !hasResponseContent) return;

    const frame = window.requestAnimationFrame(() => {
      if (followsLatest.current) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
        setIsAwayFromLatest(false);
        setHasUnseenContent(false);
        return;
      }

      const visible = latestIsVisible();
      followsLatest.current = visible;
      setIsAwayFromLatest(!visible);
      setHasUnseenContent(!visible);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [enabled, hasResponseContent, revision, latestIsVisible]);

  useEffect(() => () => {
    if (scrollResetTimer.current !== undefined) window.clearTimeout(scrollResetTimer.current);
  }, []);

  return { anchorRef, composerRef, isAwayFromLatest, hasUnseenContent, scrollToLatest };
}
