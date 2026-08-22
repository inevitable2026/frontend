// 커넥터 계약.
//
// 출처가 기상청 API 든 시드 표든, 커넥터가 돌려주는 것은 언제나 SnapshotFact[] 다.
// 감지 엔진은 사실만 보고 출처를 모른다 — 그래야 규칙 여덟 개가 커넥터 목록이
// 바뀔 때마다 다시 쓰이지 않는다. 어느 경로로 얻은 값인지는 사실의 sourceDocId
// 에만 드러난다.
//
// 도메인 필드는 한국어, 시스템 필드는 영어다(lib/context/types.ts 의 감각).

import type { FactType, SnapshotFact } from "@/lib/board/types";

export type Connector = {
  id: string;
  label: string;
  factTypes: FactType[];
  fetch(siteId: string, at: Date): Promise<SnapshotFact[]>;
};

export type ConnectorStatus = "성공" | "실패";

export type ConnectorResult = {
  connectorId: string;
  label: string;
  상태: ConnectorStatus;
  facts: SnapshotFact[];
  사유: string | null;
  소요ms: number;
};

export type ConnectRun = {
  siteId: string;
  수집시각: string;
  facts: SnapshotFact[];
  결과: ConnectorResult[];
  성공수: number;
  실패수: number;
  // 두 커넥터가 같은 (factType, key) 를 내면 먼저 온 쪽이 이기고 여기 남는다.
  중복키: string[];
  // 요청한 현장이 아닌 사실은 버린다. 그 개수.
  버린사실수: number;
};

// ── 시각 도우미 ────────────────────────────────────────────────────────────
// 날짜는 KST 'YYYY-MM-DD' 문자열로만 왕복한다. Date 로 돌리면 UTC 로 도는
// 서버리스 함수에서 하루가 밀린다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function shifted(at: Date): Date {
  return new Date(at.getTime() + KST_OFFSET_MS);
}

/** KST 기준 'YYYY-MM-DD'. */
export function kstDay(at: Date): string {
  return shifted(at).toISOString().slice(0, 10);
}

/** KST 기준 '2026-08-19T08:10:00+09:00'. */
export function kstStamp(at: Date): string {
  return `${shifted(at).toISOString().slice(0, 19)}+09:00`;
}

/** KST 기준 { 날짜: 'YYYYMMDD', 시각: 'HHmm' } — 기상청 base_date · base_time 용. */
export function kstCompact(at: Date): { 날짜: string; 시각: string } {
  const iso = shifted(at).toISOString();
  return {
    날짜: `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`,
    시각: `${iso.slice(11, 13)}${iso.slice(14, 16)}`,
  };
}

/** 'YYYY-MM-DD' 에 날짜를 더한다. 문자열로 들어가 문자열로 나온다. */
export function kstDayAdd(day: string, days: number): string {
  const base = Date.parse(`${day}T00:00:00+09:00`);
  if (Number.isNaN(base)) throw new Error(`날짜 형식이 아닙니다: ${day}`);
  return kstDay(new Date(base + days * 24 * 60 * 60 * 1000));
}

/** 'YYYY-MM-DD' 두 개의 날짜 수 차이. from 이 이르면 양수. */
export function kstDayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00+09:00`);
  const b = Date.parse(`${to}T00:00:00+09:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** KST 자정 기준 Date. 'YYYY-MM-DD' 를 시각으로 다뤄야 할 때만 쓴다. */
export function kstMidnight(day: string): Date {
  return new Date(`${day}T00:00:00+09:00`);
}

// ── 사실 도우미 ────────────────────────────────────────────────────────────

export function makeFact(input: {
  siteId: string;
  factType: FactType;
  key: string;
  value: unknown;
  observedAt: string;
  sourceDocId?: string | null;
  confidence?: number;
}): SnapshotFact {
  return {
    siteId: input.siteId,
    factType: input.factType,
    key: input.key,
    value: input.value,
    observedAt: input.observedAt,
    sourceDocId: input.sourceDocId ?? null,
    confidence: input.confidence ?? 1,
  };
}

/** 중복 판정에 쓰는 사실의 자리. */
export function factKey(fact: SnapshotFact): string {
  return `${fact.factType}|${fact.key}`;
}
