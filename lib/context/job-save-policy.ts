import type { IngestStage } from "./types.ts";

// ingest_jobs.status 값은 서버·저장 데이터와 맞물려 있어 그대로 두고, 화면 문구만 여기서 고른다.
const 저장못하는이유: Record<string, string> = {
  pending: "문서 분석이 아직 시작되지 않았습니다. 분석이 끝난 뒤 저장해 주세요.",
  running: "문서 분석이 아직 진행 중입니다. 분석이 끝난 뒤 저장해 주세요.",
  failed: "문서 분석에 실패해 저장할 수 없습니다. 문서를 다시 올려 주세요.",
};

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
    return {
      allowed: false,
      reason:
        저장못하는이유[input.status] ??
        "문서 분석이 끝나지 않아 저장할 수 없습니다. 분석이 끝난 뒤 다시 저장해 주세요.",
    };
  }
  if (!input.cleanupDeadline) {
    return {
      allowed: false,
      reason: "이 문서를 언제까지 저장할 수 있는지 확인되지 않았습니다. 문서를 다시 올려 주세요.",
    };
  }
  if (input.cleanupDeadline.getTime() <= (input.now ?? Date.now())) {
    return {
      allowed: false,
      reason: "저장할 수 있는 시간이 지나 올린 파일과 임시 분석 결과가 정리되었습니다. 문서를 다시 올려 주세요.",
    };
  }
  const layout = input.steps?.find((stage) => stage.이름 === "레이아웃분석")?.산출 as
    | { execution?: { mode?: string; cleanup?: string } }
    | undefined;
  if (!layout?.execution || layout.execution.mode !== "studio" || layout.execution.cleanup !== "deleted") {
    return {
      allowed: false,
      reason: "문서 분석과 파일 정리가 모두 끝난 결과만 저장할 수 있습니다. 문서를 다시 올려 주세요.",
    };
  }
  return { allowed: true };
}
