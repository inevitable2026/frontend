"use client";

import { useMemo, useState } from "react";

export type ParsedRegion = {
  id: number;
  page: number;
  category: string;
  coordinates?: Array<{ x: number; y: number }>;
};

type Props = {
  regions: ParsedRegion[];
  agent: string | null;
  activeId: number | null;
  onHover: (id: number | null) => void;
};

/** 영역 종류 → 화면에 적을 이름. 원값은 문서 분석 결과의 키라 그대로 두고 표시만 바꾼다. */
const CATEGORY_LABEL: Record<string, string> = {
  heading1: "제목",
  heading2: "소제목",
  heading3: "작은 제목",
  header: "머리말",
  footer: "꼬리말",
  paragraph: "본문",
  table: "표",
  list: "목록",
  footnote: "각주",
  figure: "그림",
  chart: "도표",
  caption: "그림 설명",
  equation: "수식",
  index: "목차",
};

/** 처음 보는 종류는 원값 대신 "기타"로 적는다. 영문 원값이 화면에 나오면 안 된다. */
function label(category: string): string {
  return CATEGORY_LABEL[category?.toLowerCase()] ?? "기타";
}

export function validatedRegions(regions: ParsedRegion[]): ParsedRegion[] {
  return regions.flatMap((region) => {
    if (!Number.isInteger(region.page) || region.page < 1 || !region.coordinates || region.coordinates.length < 3) {
      return [];
    }
    const coordinates = region.coordinates.map(({ x, y }) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    });
    if (coordinates.some((point) => point === null)) return [];
    const points = coordinates as Array<{ x: number; y: number }>;
    const width = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
    const height = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
    return width > 0 && height > 0 ? [{ ...region, coordinates: points }] : [];
  });
}

/**
 * 에이전트가 읽어낸 영역을 문서 지면 비율 그대로 그린다.
 *
 * coordinates 는 0~1 로 정규화된 네 꼭짓점이라 지면 크기를 몰라도 상자를 칠 수 있다.
 * PDF 자체는 iframe 안에 있어 그 위에 겹칠 수 없다 — 브라우저 뷰어가 스크롤과 확대를
 * 자기 방식으로 다루기 때문이다. 그래서 옆에 같은 비율의 지면을 따로 세우고 상자만 그린다.
 * "저 문서의 이 자리를 읽었다"를 보여주는 데는 이것으로 충분하고, pdf.js 를 들이지
 * 않아도 된다. agent 는 받아 두되 화면에는 적지 않는다 — 내부 식별자다.
 */
export function ParseOverlay({ regions, activeId, onHover }: Props) {
  const safeRegions = useMemo(() => validatedRegions(regions), [regions]);
  const pages = useMemo(() => {
    const byPage = new Map<number, ParsedRegion[]>();
    for (const region of safeRegions) {
      if (!region.coordinates?.length) continue;
      const list = byPage.get(region.page) ?? [];
      list.push(region);
      byPage.set(region.page, list);
    }
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [safeRegions]);

  const [page, setPage] = useState(1);
  const current = pages.find(([p]) => p === page) ?? pages[0];

  if (pages.length === 0) {
    return <p className="context-empty">이 문서에서 표시할 영역이 없습니다.</p>;
  }

  const [pageNumber, items] = current;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <span className="overlay-count">영역 {safeRegions.length}곳</span>
        {pages.length > 1 ? (
          <div className="overlay-pages">
            {pages.map(([p]) => (
              <button
                key={p}
                type="button"
                className={p === pageNumber ? "is-active" : ""}
                onClick={() => setPage(p)}
              >
                {p}쪽
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <p role="note" style={{ margin: "0 0 0.75rem" }}>
        원본 문서 위에 겹쳐 그린 것이 아니라, 읽어낸 자리를 같은 비율로 따로 그린 그림입니다.
      </p>

      <div className="overlay-sheet">
        {items.map((region, i) => {
          const xs = region.coordinates!.map((c) => c.x);
          const ys = region.coordinates!.map((c) => c.y);
          const left = Math.min(...xs);
          const top = Math.min(...ys);
          const width = Math.max(...xs) - left;
          const height = Math.max(...ys) - top;
          const cat = (region.category || "").toLowerCase();
          return (
            <button
              key={region.id}
              type="button"
              className={`region region--${cat}${activeId === region.id ? " is-active" : ""}`}
              style={{
                left: `${left * 100}%`,
                top: `${top * 100}%`,
                width: `${width * 100}%`,
                height: `${height * 100}%`,
              }}
              onMouseEnter={() => onHover(region.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(region.id)}
              onBlur={() => onHover(null)}
              aria-label={`${pageNumber}쪽 ${i + 1}번째 영역 · ${label(region.category)}`}
            >
              <span>{label(region.category)}</span>
            </button>
          );
        })}
      </div>

      <ul className="overlay-legend">
        {[...new Set(items.map((r) => (r.category || "").toLowerCase()))].map((cat) => (
          <li key={cat}>
            <i className={`swatch region--${cat}`} />
            {label(cat)}
          </li>
        ))}
      </ul>
    </div>
  );
}
