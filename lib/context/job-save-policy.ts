import type { IngestStage } from "./types.ts";

export function canSaveStudioJob(input: {
  mode: string;
  status: string;
  steps: IngestStage[] | null;
  cleanupDeadline?: Date | null;
  now?: number;
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.mode === "demo") {
    return { allowed: false, reason: "데모 모드 결과는 저장할 수 없습니다." };
  }
  if (input.status !== "done") {
    return { allowed: false, reason: `잡이 아직 ${input.status} 입니다.` };
  }
  if (!input.cleanupDeadline) {
    return { allowed: false, reason: "저장 보존 기간이 확인되지 않아 문서를 저장할 수 없습니다." };
  }
  if (input.cleanupDeadline.getTime() <= (input.now ?? Date.now())) {
    return { allowed: false, reason: "저장 대기 시간이 만료되어 원본과 임시 색인이 정리되었습니다." };
  }
  const layout = input.steps?.find((stage) => stage.이름 === "레이아웃분석")?.산출 as
    | { execution?: { mode?: string; cleanup?: string } }
    | undefined;
  if (!layout?.execution || layout.execution.mode !== "studio" || layout.execution.cleanup !== "deleted") {
    return { allowed: false, reason: "Studio 전체 워크플로우와 원격 파일 정리가 확인된 결과만 저장할 수 있습니다." };
  }
  return { allowed: true };
}
