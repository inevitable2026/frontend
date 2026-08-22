import fixture from "./demo-fixture.json" with { type: "json" };
import fixtures from "./demo-fixtures.json" with { type: "json" };
import type { DocumentKind, ExtractedFields, IngestEvent, IngestStage } from "./types.ts";

type Fixture = {
  recordedAt: string;
  kind: string;
  sourceFilename: string;
  events: IngestEvent[];
};

const DEMO: Fixture = fixture as Fixture;

type DemoDefinition = {
  source: "recorded" | "synthetic";
  recordedAt: string;
  recording: { agent: string; config: string };
  extracted: ExtractedFields;
  events?: IngestEvent[];
};

type FixtureBundle = { version: number; fixtures: Partial<Record<DocumentKind, DemoDefinition>> };
const BUNDLE = fixtures as FixtureBundle;

const MIN_STAGE_MS = 320;
const MAX_STAGE_MS = 2_600;

export function demoRecordedAt(kind: DocumentKind = "하도급계약서"): string {
  return BUNDLE.fixtures[kind]?.recordedAt ?? DEMO.recordedAt;
}

export function demoFixture(kind: DocumentKind): DemoDefinition | null {
  return BUNDLE.fixtures[kind] ?? null;
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

function withKindContract(stage: IngestStage, definition: DemoDefinition): IngestStage {
  if (stage.이름 === "레이아웃분석") {
    const output = (stage.산출 ?? {}) as Record<string, unknown>;
    return {
      ...stage,
      산출: { ...output, agent: definition.recording.agent, config: definition.recording.config },
    };
  }
  if (stage.이름 === "필드추출") return { ...stage, 산출: definition.extracted };
  return stage;
}

function demoStages(definition: DemoDefinition): IngestEvent[] {
  if (definition.events) return definition.events;
  return DEMO.events.filter((event) => event.종류 === "단계");
}

export async function* replayDemo(
  jobId: string,
  kind: DocumentKind,
  filename: string,
  byteLength: number,
  wait: (ms: number) => Promise<void> = sleep,
): AsyncGenerator<IngestEvent, void> {
  const definition = demoFixture(kind);
  if (!definition) {
    yield { 종류: "실패", 단계: "필드추출", 사유: `${kind} 데모 픽스처가 없어 재생하지 않았습니다.` };
    return;
  }
  for (const event of demoStages(definition)) {
    if (event.종류 === "단계") {
      const stage = withKindContract(withFilename(event.단계, filename, byteLength), definition);
      yield { 종류: "단계", 단계: { ...stage, 상태: "실행중", 소요ms: null } };
      await wait(pace(stage.소요ms));
      yield { 종류: "단계", 단계: stage };
      continue;
    }
    yield event;
  }
  const indexed = demoStages(definition)
    .filter((event): event is Extract<IngestEvent, { 종류: "단계" }> => event.종류 === "단계")
    .find((event) => event.단계.이름 === "색인")?.단계.산출 as { 적재청크?: number } | undefined;
  yield {
    종류: "완료",
    jobId,
    upstageCalls: 0,
    청크수: indexed?.적재청크 ?? 0,
    추천: null,
    execution: {
      mode: "demo",
      source: definition.source,
      selectedKind: kind,
      recordedAt: definition.recordedAt,
      agent: definition.recording.agent,
      requestedConfigId: definition.recording.config,
      cleanup: "not_applicable",
      networkCalls: 0,
    },
  };
}
