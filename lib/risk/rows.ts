import type { SnapshotFact } from "@/lib/board/types";

/**
 * 위험성평가 회의록의 한 행.
 *
 * `data/board/seed-facts.json` 의 `riskAssessmentRow` 팩트 값과 **같은 이름**을 쓴다.
 * 여기서 이름을 바꾸면 저장했다가 다시 읽을 때 필드가 사라진다.
 *
 * `lib/risk/types.ts` 의 `Hazard` 와는 **다른 타입이다.** 저쪽은 SAFEGRID 백엔드가 만드는
 * 평가표이고 이쪽은 보드 팩트다. 이름이 비슷해 합치고 싶어지지만, 정본이 서로 달라
 * 한쪽을 고치면 다른 쪽이 조용히 어긋난다.
 */
export type 평가행 = {
  회의록: string;
  관리기간?: string;
  행id: string;
  공종분류?: string;
  단위작업: string;
  위험요인?: string;
  사고분류?: string;
  대책?: string[];
  법적근거?: string[];
  개선전?: { 빈도: number; 강도: number; 위험도: number };
  개선후?: { 빈도: number; 강도: number; 위험도: number };
  담당사?: string;
  이행확인담당?: string;
  /**
   * 이행확인. **상태가 셋이다.** 참/거짓 둘로 읽으면 안 된다.
   *
   * - `true` — 확인됨
   * - `undefined` / `false` — 아직 비어 있음
   * - `"불일치"` — **표시는 되어 있는데 실제로는 실행되지 않았다고 판정된 행**
   *
   * 처음에 `boolean` 으로만 선언하고 `!이행확인` 으로 미확인을 골랐다. 그러면
   * `!"불일치"` 가 false 라 **위조로 판정된 행이 「확인 완료」로 세어진다.** 실제로
   * `ra_2026_08_regular#RI-04` 가 그렇다 — `표시값: true, 실제실행: false,
   * 근거: nm_20260818_01`. 근접사고 보고가 그 대책이 실행되지 않았음을 증명한 행이다.
   *
   * 이 제품이 존재하는 이유가 바로 그 행을 찾아내는 것인데, 화면이 그걸 완료로 세고
   * 기본 필터로 가려 버렸다. 비어 있는 것보다 **나쁜** 상태다.
   */
  이행확인?: boolean | "불일치";
  /** 불일치 행에만 있다. 평가서에 적힌 표시. */
  표시값?: boolean;
  /** 불일치 행에만 있다. 실제로 실행되었는지. */
  실제실행?: boolean;
  /** 불일치 판정의 근거 문서(근접사고 보고 등). */
  근거?: string;
};

export type 이행상태 = "확인" | "빈칸" | "불일치";

export function 이행상태읽기(행: 평가행): 이행상태 {
  if (행.이행확인 === "불일치") return "불일치";
  if (행.이행확인 === true) return "확인";
  return "빈칸";
}

export type 행팩트 = SnapshotFact & { value: 평가행 };

/**
 * 확인이 끝나지 않은 행. 결재 상신을 막는 것이 바로 이것들이다.
 *
 * 빈칸과 **불일치를 함께** 담는다. `!r.이행확인` 로 고르면 `"불일치"` 가 참이라
 * 위조 판정 행이 빠진다 — 정확히 반대로 골라야 할 행이다.
 */
export function 미확인행(rows: 평가행[]): 평가행[] {
  return rows.filter((r) => 이행상태읽기(r) !== "확인");
}

/** 위조로 판정된 행. 목록에서 맨 위로 올린다. */
export function 불일치행(rows: 평가행[]): 평가행[] {
  return rows.filter((r) => 이행상태읽기(r) === "불일치");
}

/**
 * 같은 key 의 팩트를 **가장 나중 것 하나**로 접는다.
 *
 * `data/board/seed-facts.json` 의 「키규칙」은 *"같은 (factType, key) 의 앞뒤 두 항목이
 * 곧 델타의 before · after"* 라고 말한다. 즉 중복은 이력이지 오류가 아니다. 화면이
 * 묻는 것은 "지금 상태" 이므로 접어야 한다.
 *
 * 접지 않으면 실제로 숫자가 어긋난다. `ra_2026_08_regular` 의 이행확인이 빈 행은
 * 접으면 **9행**(카드가 말하는 수)이지만, 접지 않으면 `RI-11` 이 두 번 세어져 10행이 된다.
 */
export function 최신만<T extends { key: string; observedAt: string }>(facts: T[]): T[] {
  const 최신 = new Map<string, T>();
  for (const f of facts) {
    const 이전 = 최신.get(f.key);
    // observedAt 이 같으면 나중에 온 것을 쓴다. 배열 순서가 곧 기록 순서다.
    if (!이전 || 이전.observedAt <= f.observedAt) 최신.set(f.key, f);
  }
  return [...최신.values()];
}

/** 팩트 배열에서 행만 골라 행id 순으로 세운다. */
export function 행정렬(facts: 행팩트[]): 평가행[] {
  return facts
    .map((f) => f.value)
    .filter((v) => v && typeof v === "object" && typeof v.행id === "string")
    .sort((a, b) => a.행id.localeCompare(b.행id, "en", { numeric: true }));
}

/** 하도급사 코드 → 사람이 읽는 이름. 없는 코드는 코드 그대로 보인다. */
export const 회사이름: Record<string, string> = {
  co_hanshin: "한신종합건설",
  sub_seojin: "서진건설",
  sub_hanbit: "한빛가설",
  sub_daeyang: "대양토공",
  sub_kyungin: "경인전기",
  sub_woori: "우리설비",
  sub_jungang: "중앙철근",
};

export function 회사표시(code: string | undefined): string {
  if (!code) return "미지정";
  return 회사이름[code] ?? code;
}

/**
 * 위험도 표시. `빈도 × 강도 = 위험도` 그대로 보인다.
 *
 * **등급(높음·보통·낮음)을 화면에서 만들지 않는다.** 처음에는 9 이상이면 높음 같은
 * 고정 임계로 색을 칠했는데, 그건 이 저장소가 여러 곳에서 경고하는 바로 그 잘못이다 —
 * 「높음」기준이 매트릭스마다 다르다(4x3 은 9 이상, 5x4 는 15 이상). 그런데
 * `riskAssessmentRow` 팩트에는 **매트릭스 필드가 아예 없고**, 시나리오는 4×3 과 5×4 를
 * 일부러 섞어 쓴다(`lib/detect/rules/t07-score-gap.ts:24`). 그래서 같은 12 가 어떤
 * 행에서는 높음이고 어떤 행에서는 보통이다. 모르는 것을 색으로 단정하면, 안전 화면에서
 * 가장 하면 안 되는 종류의 거짓말이 된다.
 *
 * `lib/detect/delta.ts:197` 의 `scoreText` 와 같은 표기를 쓴다.
 */
export function 위험도표시(s: { 빈도: number; 강도: number; 위험도: number } | undefined): string {
  if (!s) return "미기재";
  return `빈도 ${s.빈도} × 강도 ${s.강도} = ${s.위험도}`;
}
