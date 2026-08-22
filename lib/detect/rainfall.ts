// 강우 임계치 표
//
// **법령에는 강우량 숫자가 없다.** 「산업안전보건기준에 관한 규칙」 제37조(악천후 및 강풍 시
// 작업 중지)는 "비·눈·바람 또는 그 밖의 기상상태의 불안정으로 인하여 근로자가 위험해질 우려가
// 있는 경우"라는 정성적 문구만 두고, 숫자가 붙은 것은 풍속뿐이다(타워크레인 설치·해체 초속
// 10미터, 운전 초속 15미터).
//
// 그래서 임계치를 하나 골라 코드에 박고 그것을 「법적 근거」로 인용하면 안 된다. 이 제품이
// 「원문 조회에 성공한 조문만 인용한다」는 계약을 지키기로 한 것과 정확히 같은 문제이고,
// 인용 가능한 숫자와 현장이 정한 숫자를 화면에서 구별하지 못하면 그 구별이 없는 것과 같다.
//
// 아래 표는 네 단계로 나누고 단계마다 출처와 인용 가능 여부를 함께 들고 다닌다. 사면·법면
// 점검 단계만 공식 근거가 없는 현장 설정값이며, 그 사실이 `citable: false` 로 드러난다.

export type RainfallTierId = "concretePour" | "slopeInspection" | "heavyRainAdvisory" | "extremeRain";

export type RainfallTier = {
  id: RainfallTierId;
  label: string;
  /** 누적 시간 창(시간). 그 창 안의 누적 강우량과 비교한다. */
  windowHours: number;
  thresholdMm: number;
  /** 같은 단계에 두 번째 창이 있으면 둘 중 하나만 넘어도 도달로 본다. */
  alt: { windowHours: number; thresholdMm: number } | null;
  /** 도달했을 때 무엇을 해야 하는가. */
  action: string;
  source: string;
  /**
   * 문서에 근거로 적어도 되는 숫자인가. false 면 화면과 초안 양쪽에서 「현장 설정값」으로
   * 표시해야 하고, 법령 인용란에 넣으면 안 된다.
   */
  citable: boolean;
};

export const RAINFALL_TIERS: readonly RainfallTier[] = [
  {
    id: "concretePour",
    label: "콘크리트 타설 중지",
    windowHours: 1,
    thresholdMm: 3,
    alt: null,
    action: "타설을 중지하고 이미 친 구간에 보호 조치를 한다.",
    // 시간당 3mm 를 넘으면 구조체 콘크리트의 강도 저하가 허용치를 넘는다.
    source: "국토교통부 「강우 시 콘크리트 타설을 위한 가이드라인」(2024.12)",
    citable: true,
  },
  {
    id: "slopeInspection",
    label: "사면·법면 점검",
    windowHours: 24,
    thresholdMm: 30,
    alt: null,
    action: "되메움·법면·굴착 구간의 등재 대책이 그대로 유효한지 눈으로 확인한다.",
    // ⚠ 공식 근거가 없다. 시나리오의 주말 누적 41mm 가 이 단계에 걸리도록 잡은 값이며,
    //   현장 내규로 흔히 쓰이는 범위(일 20~30mm)의 위쪽을 택했다. 발주처나 현장 내규에
    //   숫자가 있으면 그 값으로 덮어야 한다.
    source: "현장 설정값 — 공식 근거 없음",
    citable: false,
  },
  {
    id: "heavyRainAdvisory",
    label: "작업 중지 검토",
    windowHours: 3,
    thresholdMm: 60,
    alt: { windowHours: 12, thresholdMm: 110 },
    action: "옥외 작업 전반의 중지 여부를 판단하고 배수와 흙막이 계측을 확인한다.",
    source: "기상청 호우주의보 발표기준",
    citable: true,
  },
  {
    id: "extremeRain",
    label: "긴급 대피",
    windowHours: 1,
    thresholdMm: 72,
    alt: { windowHours: 3, thresholdMm: 90 },
    action: "옥외 작업을 즉시 중지하고 저지대와 사면 하부에서 인원을 뺀다.",
    // 기상청이 긴급재난문자를 직접 보내는 기준이다(2023.06.15 시행).
    source: "기상청 극한호우 기준",
    citable: true,
  },
] as const;

export function tierOf(id: RainfallTierId): RainfallTier {
  const tier = RAINFALL_TIERS.find((candidate) => candidate.id === id);
  if (!tier) throw new Error(`알 수 없는 강우 단계입니다: ${id}`);
  return tier;
}

/** 사면·법면 점검을 발동시키는 값. T-01 이 쓰는 임계치가 이것이다. */
export const SLOPE_INSPECTION_MM = tierOf("slopeInspection").thresholdMm;

/**
 * 누적 강우량이 어느 단계까지 도달했는지 돌려준다. 가장 무거운 단계 하나만 돌려주며,
 * 어느 단계에도 못 미치면 null 이다.
 *
 * 관측 창(`windowHours`)을 모르는 값이 흔하다. 시나리오의 「주말 누적 41mm」처럼 창이
 * 적혀 있지 않으면 사면 점검 단계의 24시간 창으로 읽는다. 창을 모른 채 3시간 창 기준에
 * 대보면 없는 호우주의보를 만들어 내기 때문이다.
 */
export function reachedTier(mm: number, windowHours: number | null): RainfallTier | null {
  if (!Number.isFinite(mm) || mm <= 0) return null;
  const 창 = windowHours ?? tierOf("slopeInspection").windowHours;

  // 무거운 단계부터 본다. 같은 값이 여러 단계에 걸리면 무거운 쪽이 이긴다.
  for (let i = RAINFALL_TIERS.length - 1; i >= 0; i -= 1) {
    const tier = RAINFALL_TIERS[i];
    if (창 <= tier.windowHours && mm >= tier.thresholdMm) return tier;
    if (tier.alt && 창 <= tier.alt.windowHours && mm >= tier.alt.thresholdMm) return tier;
  }
  return null;
}

/** 근거 문구. 인용 불가한 값은 그 사실을 문구 안에 남긴다. */
export function tierText(tier: RainfallTier): string {
  const 창 = `${tier.windowHours}시간 누적 ${tier.thresholdMm}mm`;
  const 둘째 = tier.alt ? ` 또는 ${tier.alt.windowHours}시간 ${tier.alt.thresholdMm}mm` : "";
  const 꼬리 = tier.citable ? tier.source : `${tier.source} · 인용 불가`;
  return `${tier.label} 기준 ${창}${둘째} (${꼬리})`;
}
