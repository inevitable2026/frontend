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
   * 이행확인. **`undefined` 와 `false` 를 구분하지 않는다.**
   *
   * 시드에는 이 값이 아예 없는 행이 있고 `false` 인 행이 있는데, 둘 다 "확인되지 않음"이다.
   * 화면에서 굳이 가르면 "미표시"와 "미이행"이라는 없는 구분이 생긴다.
   */
  이행확인?: boolean;
};

export type 행팩트 = SnapshotFact & { value: 평가행 };

/** 이행확인이 채워지지 않은 행. 결재 상신을 막는 것이 바로 이것들이다. */
export function 미확인행(rows: 평가행[]): 평가행[] {
  return rows.filter((r) => !r.이행확인);
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
