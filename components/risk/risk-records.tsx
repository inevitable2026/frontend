"use client";

import type { 평가일자 } from "@/lib/risk/safegrid";

/**
 * 지금까지 만든 평가서 목록.
 *
 * 대기열이 "지금 손봐야 할 것"이라면 여기는 **"이미 만든 것"** 이다. 탭 이름이
 * 「위험성평가 기록 목록」인데 감지 카드만 보이면 실제로 만든 평가서가 통째로 사라진다.
 *
 * 이 기록은 **SAFEGRID 자체 DB** 에 있다 — 태스크 보드의 카드와도, 공유 Postgres 의
 * `assessments` 와도 다른 곳이다. 세 곳이 아직 하나로 합쳐져 있지 않다.
 */

function 날짜표시(key: string): string {
  const [, m, d] = key.split("-");
  return `${Number(m)}월 ${Number(d)}일`;
}

function 시각표시(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  });
}

export default function RiskRecords({
  일자별,
  불러오는중,
  열기,
  펼침,
  펼치기,
}: {
  일자별: 평가일자[];
  불러오는중: boolean;
  열기: (id: string) => void;
  펼침: boolean;
  펼치기: () => void;
}) {
  if (불러오는중) return <p className="risk-queue-empty">기록을 불러오는 중…</p>;
  if (일자별.length === 0) return null;

  const 총건수 = 일자별.reduce((n, d) => n + d.items.length, 0);
  // 61건이 대기열을 밀어내면 "지금 손봐야 할 것"이 안 보인다. 접어 두고 필요할 때 편다.
  const 보일일자 = 펼침 ? 일자별 : 일자별.slice(0, 1);

  return (
    <section className="risk-queue-group is-기록">
      <h3>
        <span aria-hidden="true">▣</span>
        만든 평가서
        <em>{총건수}</em>
      </h3>

      {보일일자.map((day) => (
        <div className="risk-rec-day" key={day.date}>
          <h4>
            {날짜표시(day.date)}
            <em>{day.items.length}건</em>
          </h4>
          <ul>
            {(펼침 ? day.items : day.items.slice(0, 5)).map((rec) => (
              <li key={rec.id}>
                <button type="button" className="risk-rec-item" onClick={() => 열기(rec.id)}>
                  <span className="risk-rec-time">{시각표시(rec.created_at)}</span>
                  <span className="risk-rec-title">{rec.title || "제목 없음"}</span>
                  <span className="risk-rec-go" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {펼침 ? null : (
        <button type="button" className="risk-rec-more" onClick={펼치기}>
          {총건수}건 전체 보기
        </button>
      )}

      {/* 저쪽 API 에 현장 필터가 없다. 숨기지 않고 적는다. */}
      <p className="risk-rec-note">
        이 목록에는 같은 백엔드를 쓰는 <b>모든 기록</b>이 들어 있습니다. 현장별로 가르는 것은
        현장 식별자가 붙은 뒤입니다.
      </p>
    </section>
  );
}
