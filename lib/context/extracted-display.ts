const FIELD_LABELS: Record<string, string> = {
  actionId: "조치 ID",
  assessmentItemIds: "평가 항목",
  controls: "저감조치",
  description: "내용",
  dueDate: "기한",
  findingIds: "지적사항",
  hazard: "위험요인",
  itemId: "평가 항목 ID",
  mitigationIds: "저감조치",
  mitigationId: "저감조치 ID",
  name: "작업",
  order: "순서",
  ppe: "보호구",
  riskLevel: "위험도",
  severity: "심각도",
  status: "상태",
  stepId: "작업 단계 ID",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function label(key: string): string {
  return FIELD_LABELS[key] ?? key;
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
