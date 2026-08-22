import fixture from "@/lib/context/demo-fixture.json";
import type { IngestEvent, IngestStage } from "@/lib/context/types";

type Fixture = {
  recordedAt: string;
  kind: string;
  sourceFilename: string;
  events: IngestEvent[];
};

const DEMO: Fixture = fixture as Fixture;

const MIN_STAGE_MS = 320;
const MAX_STAGE_MS = 2_600;

export function demoRecordedAt(): string {
  return DEMO.recordedAt;
}

function pace(recordedMs: number | null): number {
  if (!recordedMs || recordedMs <= 0) return MIN_STAGE_MS;
  return Math.min(MAX_STAGE_MS, Math.max(MIN_STAGE_MS, Math.round(recordedMs / 4)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withFilename(stage: IngestStage, filename: string, byteLength: number): IngestStage {
  if (stage.이름 !== "수신") return stage;
  return { ...stage, 산출: { 파일명: filename, 바이트: byteLength, mime: "application/pdf" } };
}

export async function* replayDemo(
  jobId: string,
  filename: string,
  byteLength: number,
): AsyncGenerator<IngestEvent, void> {
  for (const event of DEMO.events) {
    if (event.종류 === "단계") {
      const stage = withFilename(event.단계, filename, byteLength);
      yield { 종류: "단계", 단계: { ...stage, 상태: "실행중", 소요ms: null } };
      await sleep(pace(stage.소요ms));
      yield { 종류: "단계", 단계: stage };
      continue;
    }
    if (event.종류 === "완료") {
      yield { ...event, jobId, upstageCalls: 0 };
      continue;
    }
    yield event;
  }
}
