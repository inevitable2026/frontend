import type { FactDelta, FactType, SnapshotFact } from "@/lib/board/types";

// 사실 하나가 놓이는 자리. 현장·종류·키가 모두 같아야 같은 자리이고, 델타는 이 자리
// 안에서만 계산된다. 다른 현장의 같은 키를 섞으면 남의 변화가 우리 감지로 새어 든다.
const SLOT_SEP = "::";

export function factSlot(fact: Pick<SnapshotFact, "siteId" | "factType" | "key">): string {
  return `${fact.siteId}${SLOT_SEP}${fact.factType}${SLOT_SEP}${fact.key}`;
}

export function factTime(observedAt: string | null | undefined): number {
  if (!observedAt) return 0;
  const parsed = Date.parse(observedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 키 순서가 달라도 같은 값으로 읽히도록 정렬해서 직렬화한다. 이것이 없으면 파이프라인이
// 같은 사실을 다시 넣기만 해도 델타가 생긴다.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = canonicalize(source[key]);
      if (item === undefined) continue;
      out[key] = item;
    }
    return out;
  }
  return value;
}

export function canonical(value: unknown): string {
  const text = JSON.stringify(canonicalize(value));
  return text === undefined ? "null" : text;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

type Slotted = { fact: SnapshotFact; index: number };

// 최신이 앞. 관측 시각이 같으면 나중에 들어온 것을 최신으로 본다.
function byNewest(a: Slotted, b: Slotted): number {
  const gap = factTime(b.fact.observedAt) - factTime(a.fact.observedAt);
  if (gap !== 0) return gap;
  const text = String(b.fact.observedAt ?? "").localeCompare(String(a.fact.observedAt ?? ""));
  if (text !== 0) return text;
  return b.index - a.index;
}

function groupBySlot(facts: SnapshotFact[]): Map<string, Slotted[]> {
  const groups = new Map<string, Slotted[]>();
  facts.forEach((fact, index) => {
    const slot = factSlot(fact);
    const bucket = groups.get(slot);
    if (bucket) bucket.push({ fact, index });
    else groups.set(slot, [{ fact, index }]);
  });
  for (const bucket of groups.values()) bucket.sort(byNewest);
  return groups;
}

// 자리마다 최신 한 건만 남긴다. 규칙이 "지금 현장의 상태"를 볼 때 쓰는 목록이다.
export function latestFacts(facts: SnapshotFact[]): SnapshotFact[] {
  const groups = groupBySlot(facts);
  return [...groups.values()].map((bucket) => bucket[0].fact);
}

export type ComputeDeltaOptions = {
  siteId?: string;
  factTypes?: FactType[];
  // 이 시각보다 오래된 변화는 지난 감지에서 이미 다룬 것으로 보고 버린다.
  since?: string;
};

// 같은 자리의 최신 두 건을 비교한다. 값이 같으면 델타가 아니고, 이전 값이 없는 신규
// 사실은 before 를 null 로 둔 델타가 된다.
export function computeDeltas(facts: SnapshotFact[], options: ComputeDeltaOptions = {}): FactDelta[] {
  const wanted = options.factTypes ? new Set<FactType>(options.factTypes) : null;
  const scoped = facts.filter((fact) => {
    if (options.siteId && fact.siteId !== options.siteId) return false;
    if (wanted && !wanted.has(fact.factType)) return false;
    return true;
  });

  const since = options.since ? factTime(options.since) : 0;
  const deltas: FactDelta[] = [];

  for (const bucket of groupBySlot(scoped).values()) {
    const current = bucket[0].fact;
    const previous = bucket[1]?.fact ?? null;
    if (previous && sameValue(previous.value, current.value)) continue;
    if (since && factTime(current.observedAt) < since) continue;

    deltas.push({
      factType: current.factType,
      key: current.key,
      before: previous ? previous.value : null,
      after: current.value,
      observedAt: current.observedAt,
      sourceDocId: current.sourceDocId,
    });
  }

  deltas.sort((a, b) => factTime(b.observedAt) - factTime(a.observedAt));
  return deltas;
}

export function deltasOfType(deltas: FactDelta[], factType: FactType): FactDelta[] {
  return deltas.filter((delta) => delta.factType === factType);
}

// 사실 값 읽기
//
// SnapshotFact.value 는 unknown 이다. 스냅샷을 채우는 쪽이 바뀌어도 규칙이 터지지
// 않도록, 규칙은 아래 읽기 함수로만 값을 꺼낸다. 없는 필드는 예외가 아니라 null 이다.

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readNumber(source: unknown, ...keys: string[]): number | null {
  const record = asRecord(source);
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function readString(source: unknown, ...keys: string[]): string | null {
  const record = asRecord(source);
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return null;
}

export function readBoolean(source: unknown, ...keys: string[]): boolean | null {
  const record = asRecord(source);
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "boolean") return raw;
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return null;
}

export function readList(source: unknown, ...keys: string[]): unknown[] {
  const record = asRecord(source);
  if (!record) return [];
  for (const key of keys) {
    const raw = record[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

export function readStrings(source: unknown, ...keys: string[]): string[] {
  return readList(source, ...keys)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

// 여러 규칙이 함께 쓰는 사실 값의 모양
//
// tbm-check 의 RiskScore(빈도 · 강도 · 위험도) 와 RiskItem 의 추천 · 개선전 구조를
// 그대로 따른다. 도메인 필드는 한국어, 시스템 필드는 영어다.

export type RiskScoreValue = { 빈도: number; 강도: number; 위험도: number };

export function readRiskScore(value: unknown): RiskScoreValue | null {
  const record = asRecord(value);
  if (!record) return null;
  const 빈도 = readNumber(record, "빈도", "likelihood");
  const 강도 = readNumber(record, "강도", "severity");
  const 위험도 = readNumber(record, "위험도", "score");
  if (빈도 === null && 강도 === null && 위험도 === null) return null;
  const frequency = 빈도 ?? 0;
  const severity = 강도 ?? 0;
  return { 빈도: frequency, 강도: severity, 위험도: 위험도 ?? frequency * severity };
}

export function scoreText(score: RiskScoreValue): string {
  return `${score.빈도}×${score.강도}=${score.위험도}`;
}

export type RiskAssessmentRowValue = {
  docId: string | null;
  행id: string | null;
  taskId: string | null;
  공종분류: string | null;
  단위작업: string | null;
  위험요인: string | null;
  개선전: RiskScoreValue | null;
  추천: RiskScoreValue | null;
  법적근거: string | null;
  이행확인: boolean | null;
  관리기간: string | null;
};

export function readRiskRow(value: unknown): RiskAssessmentRowValue | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    docId: readString(record, "docId", "assessmentId", "회의록"),
    행id: readString(record, "행id", "itemId", "rowId"),
    taskId: readString(record, "taskId"),
    공종분류: readString(record, "공종분류", "process", "공종"),
    단위작업: readString(record, "단위작업", "task", "작업"),
    위험요인: readString(record, "위험요인", "hazard"),
    개선전: readRiskScore(record["개선전"] ?? record["before"] ?? record["risk"]),
    추천: readRiskScore(record["추천"] ?? record["recommendation"]),
    법적근거: readString(record, "법적근거", "legalReference"),
    이행확인: readBoolean(record, "이행확인", "verified"),
    관리기간: readString(record, "관리기간", "period"),
  };
}
