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

const CATEGORY_LABEL: Record<string, string> = {
  heading1: "제목",
  header: "머리",
  paragraph: "본문",
  table: "표",
  list: "목록",
  footnote: "각주",
  figure: "그림",
};

function label(category: string): string {
  return CATEGORY_LABEL[category?.toLowerCase()] ?? category;
}

/**
 * 에이전트가 읽어낸 영역을 문서 지면 비율 그대로 그린다.
 *
 * coordinates 는 0~1 로 정규화된 네 꼭짓점이라 지면 크기를 몰라도 상자를 칠 수 있다.
 * PDF 자체는 iframe 안에 있어 그 위에 겹칠 수 없다 — 브라우저 뷰어가 스크롤과 확대를
 * 자기 방식으로 다루기 때문이다. 그래서 옆에 같은 비율의 지면을 따로 세우고 상자만 그린다.
 * "저 문서의 이 자리를 이 에이전트가 읽었다"를 보여주는 데는 이것으로 충분하고,
 * pdf.js 를 들이지 않아도 된다.
 */
export function ParseOverlay({ regions, agent, activeId, onHover }: Props) {
  const pages = useMemo(() => {
    const byPage = new Map<number, ParsedRegion[]>();
    for (const region of regions) {
      if (!region.coordinates?.length) continue;
      const list = byPage.get(region.page) ?? [];
      list.push(region);
      byPage.set(region.page, list);
    }
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [regions]);

  const [page, setPage] = useState(1);
  const current = pages.find(([p]) => p === page) ?? pages[0];

  if (pages.length === 0) {
    return <p className="context-empty">아직 읽어낸 영역이 없습니다.</p>;
  }

  const [pageNumber, items] = current;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <span className="overlay-agent">{agent ?? "에이전트"}</span>
        <span className="overlay-count">영역 {regions.length}개</span>
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

      <div className="overlay-sheet">
        {items.map((region) => {
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
              aria-label={`${label(region.category)} 영역 ${region.id}`}
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
