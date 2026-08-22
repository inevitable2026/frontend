const FIELD_LABELS: Record<string, string> = {
  actionId: "조치",
  assessmentItemIds: "평가 항목",
  controls: "저감조치",
  description: "내용",
  dueDate: "기한",
  evidence: "근거",
  findingIds: "지적사항",
  hazard: "위험요인",
  itemId: "평가 항목",
  mitigationIds: "저감조치",
  mitigationId: "저감조치",
  name: "작업",
  order: "순서",
  ppe: "보호구",
  riskLevel: "위험도",
  severity: "심각도",
  status: "상태",
  stepId: "작업 단계",
};

const 한글 = /[가-힣]/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * 항목 키 → 화면에 적을 이름.
 *
 * 매핑에 없으면 키를 그대로 돌려준다. 위 표에 없는 영문 키는 화면에 영문 그대로 나가므로,
 * 그리기 전에 `알려진필드인가` 로 걸러야 한다.
 */
export function 필드이름(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

/**
 * 이 키를 화면에 그대로 적어도 되는지.
 *
 * 한글 키(`업체명`, `현장명` 처럼 추출 결과의 상위 항목)는 그 자체가 읽을 수 있는 이름이고,
 * 영문 키는 위 표에 이름이 있을 때만 읽을 수 있다. 둘 다 아니면 `false` 다 —
 * 호출하는 화면이 그 항목을 감추거나 원래 키를 `title` 로만 내려야 한다.
 */
export function 알려진필드인가(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, key) || 한글.test(key);
}

function label(key: string): string {
  return 필드이름(key);
}

function evidenceSummary(value: unknown): string {
  return `근거 ${Array.isArray(value) ? value.length : 1}건`;
}

function formatRecord(value: Record<string, unknown>): string {
  const parts = Object.entries(value)
    .filter(([, item]) => item != null && item !== "" && (!Array.isArray(item) || item.length > 0))
    .map(([key, item]) => key === "evidence"
      ? evidenceSummary(item)
      : `${label(key)}: ${formatExtractedFieldValue(item)}`);
  return parts.join(" · ");
}

export function hasExtractedDisplayValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function formatExtractedField(key: string, value: unknown): string {
  return key === "evidence" ? evidenceSummary(value) : formatExtractedFieldValue(value);
}

export function formatExtractedFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.every((item) => record(item) === null)) return value.map((item) => String(item)).join(", ");
    return value.map((item, index) => `${index + 1}. ${formatExtractedFieldValue(item)}`).join(" / ");
  }
  const object = record(value);
  if (object) return formatRecord(object);
  return String(value);
}
