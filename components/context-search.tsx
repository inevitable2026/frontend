"use client";

import { useRef, useState } from "react";

import { DOCUMENT_KINDS, type DocumentKind } from "@/lib/context/types";

/**
 * 맥락 DB 검색.
 *
 * 문서를 적재할 때마다 청크를 임베딩해 pgvector 에 넣고 있었는데 **그걸 읽는 화면이
 * 하나도 없었다.** `POST /api/context/search` 는 완성돼 있었고 호출자만 0이었다.
 * 문서마다 임베딩 비용과 시간을 쓰면서 산출물이 없는 상태였고, 화면은 "맥락 DB 를
 * 만든다"고 말하면서 그 DB 로 무엇을 할 경로를 내주지 않았다.
 *
 * 여기가 그 입구다. 이 화면이 있어야 *"우리 회사 문서로 답한다"* 가 말이 아니라
 * 눌러 볼 수 있는 것이 된다.
 *
 * **점수를 지어내지 않는다.** 서버가 준 코사인 유사도(1 - distance)를 관련도로 그대로
 * 보인다. 벡터 검색은 언제나 무언가를 돌려주므로 (가장 가까운 것이 있기만 하면)
 * 점수를 안 보이면 관련 없는 결과가 근거처럼 보인다.
 * 소요시간(latencyMs)은 받아 두되 화면에는 적지 않는다 — 관리자의 판단에 쓰이지 않는다.
 */

type 검색결과 = {
  documentId: string;
  title: string;
  kind: DocumentKind;
  siteId: string;
  siteName: string;
  page: number;
  seq: number;
  text: string;
  score: number;
};

type 응답 = {
  q: string;
  found: number;
  latencyMs: { embed: number; search: number };
  results: 검색결과[];
  error?: string;
};

/** 질의어를 본문에서 굵게. 벡터 검색이라 글자가 안 겹칠 수도 있는데, 겹치면 눈에 띄어야 한다. */
function 강조(본문: string, 질의: string) {
  const 조각 = 질의
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  if (조각.length === 0) return 본문;

  const 본체 = 조각.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // 쪼개는 것과 판정하는 것을 **다른 정규식으로** 한다. `/g` 붙은 하나를 돌려쓰면
  // `test` 가 `lastIndex` 를 들고 다녀 한 칸 걸러 하나씩만 강조된다.
  const 쪼개기 = new RegExp(`(${본체})`, "gi");
  const 판정 = new RegExp(`^(?:${본체})$`, "i");

  return 본문.split(쪼개기).map((part, i) =>
    판정.test(part) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
  );
}

export default function ContextSearch({
  sites,
}: {
  sites: Array<{ id: string; name: string }>;
}) {
  const [질의, set질의] = useState("");
  const [현장, set현장] = useState("");
  const [종류, set종류] = useState("");
  const [찾는중, set찾는중] = useState(false);
  const [답, set답] = useState<응답 | null>(null);
  const [오류, set오류] = useState<string | null>(null);
  const 입력 = useRef<HTMLInputElement>(null);

  async function 검색() {
    const q = 질의.trim();
    if (!q || 찾는중) return;
    set찾는중(true);
    set오류(null);

    try {
      const res = await fetch("/api/context/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q,
          siteId: 현장 || undefined,
          kind: 종류 || undefined,
          k: 8,
        }),
      });
      const body = (await res.json()) as 응답;
      if (!res.ok) {
        console.error("맥락 검색 실패", res.status, body.error);
        throw new Error("검색하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      }
      set답(body);
    } catch (e) {
      // 빈 결과로 두지 않는다. 못 찾은 것과 검색이 실패한 것은 다른 사실이다.
      console.error("맥락 검색 실패", e);
      set오류("검색하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      set답(null);
    } finally {
      set찾는중(false);
    }
  }

  return (
    <section className="context-search">
      <header>
        <h2>맥락 검색</h2>
        <p className="context-search-note">
          문서함에 저장한 문서를 뜻으로 찾습니다. 글자가 안 겹쳐도 뜻이 가까우면 나옵니다.
        </p>
      </header>

      <div className="context-search-bar">
        <input
          ref={입력}
          type="search"
          value={질의}
          placeholder="예: 동바리 반입 전에 뭘 받아야 하지?"
          disabled={찾는중}
          onChange={(e) => set질의(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void 검색();
          }}
        />
        <select value={현장} onChange={(e) => set현장(e.target.value)} aria-label="현장">
          <option value="">전체 현장</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={종류} onChange={(e) => set종류(e.target.value)} aria-label="종류">
          <option value="">전체 종류</option>
          {DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void 검색()} disabled={찾는중 || !질의.trim()}>
          {찾는중 ? "찾는 중…" : "찾기"}
        </button>
      </div>

      {오류 ? <p className="context-search-error">{오류}</p> : null}

      {답 ? (
        <>
          <p className="context-search-meta">검색 결과 {답.found}건</p>

          {답.found === 0 ? (
            <p className="context-empty">
              찾은 내용이 없습니다. 문서함에 저장된 문서만 검색됩니다. 올린 문서를 저장까지
              마쳤는지 확인해 주세요.
            </p>
          ) : (
            <ol className="context-hits">
              {답.results.map((r) => (
                <li key={`${r.documentId}-${r.seq}`}>
                  <p className="context-hit-head">
                    <b>{r.title}</b>
                    <span className="context-hit-kind">{r.kind}</span>
                    <span>{r.siteName}</span>
                    <span className="context-hit-page">{r.page}쪽</span>
                    {/* 점수를 그대로 보인다. 벡터 검색은 항상 무언가를 돌려주므로
                        점수 없이 보이면 먼 결과가 근거처럼 읽힌다. */}
                    <span className="context-hit-score">
                      질문과 {(r.score * 100).toFixed(0)}% 관련
                    </span>
                  </p>
                  <p className="context-hit-text">{강조(r.text, 답.q)}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </section>
  );
}
