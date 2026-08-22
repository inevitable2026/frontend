import { createHash } from "node:crypto";
import rawManifest from "./studio-manifest.json" with { type: "json" };
import { INGEST_DOCUMENT_KINDS, type IngestDocumentKind } from "./types.ts";

export type StudioStep = {
  logicalName: string;
  physicalStepId: string | null;
  type: "document-parse" | "information-extract";
  is_first: boolean;
  data: Record<string, unknown>;
  next_steps: Array<{ step_name: string }>;
};

export type StudioContract = {
  kind: IngestDocumentKind;
  agentLogicalName: string;
  description: string;
  expectedConfigFingerprint: string | null;
  expectedConfigExternalId: string | null;
  steps: StudioStep[];
};

export type StudioManifest = Omit<typeof rawManifest, "contracts"> & { contracts: StudioContract[] };

export function canonicalizeStudioValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeStudioValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // 코드유닛 비교로 고정한다. `localeCompare` 는 런타임 기본 Collator 로케일에 의존해서
        // 같은 바이트가 환경마다 다른 지문을 낸다 — 서명에 쓸 수 없는 성질이다. 이 매니페스트의
        // 키에는 `저감조치ID`·`작업단계ID`·`지적사항ID`처럼 한글 뒤에 라틴 접미사가 붙은 것이
        // 있고, ICU 한국어 콜레이션은 그 접미사를 한글 뒤로 보내지만 코드유닛 정렬은 앞으로
        // 보낸다. 그래서 ko-KR 개발 머신에서만 검증이 실패했다. 커밋된 지문은 코드유닛
        // 계열(scripts/studio-reconcile.mjs 와 같은 정렬)로 찍힌 값이라 여기서 바꿀 것은
        // 서명값이 아니라 비교 함수다 — 지문을 다시 찍으면 "누가 어느 로케일에서 찍었나"의
        // 기록이 되어 제3자가 재현할 수 없고, 그때 위조 감지가 무의미해진다.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalizeStudioValue(child)]),
    );
  }
  return value;
}

export function canonicalStudioJson(value: unknown): string {
  return JSON.stringify(canonicalizeStudioValue(value));
}

export function studioManifestFingerprint(manifest: StudioManifest): string {
  const unsigned = { ...manifest };
  delete (unsigned as { fingerprint?: string }).fingerprint;
  return createHash("sha256").update(canonicalStudioJson(unsigned)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateExtractSchema(schema: unknown, path = "schema"): void {
  if (!isRecord(schema) || schema.type !== "object" || typeof schema.description !== "string" || schema.description.length === 0) {
    throw new Error(`${path} must be a described object schema.`);
  }
  if (schema.additionalProperties !== false || !isRecord(schema.properties)) {
    throw new Error(`${path} must explicitly close and describe its properties.`);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    const propertyPath = `${path}.properties.${name}`;
    if (!isRecord(property) || typeof property.description !== "string" || property.description.length === 0) {
      throw new Error(`${propertyPath} must have a description.`);
    }
    if (property.type === "string") continue;
    if (property.type !== "array" || !isRecord(property.items) || property.items.type === undefined) {
      throw new Error(`${propertyPath} must be a string or an explicitly typed array.`);
    }
    if (property.items.type === "string") {
      if (typeof property.items.description !== "string" || property.items.description.length === 0) {
        throw new Error(`${propertyPath}.items must have a description.`);
      }
      continue;
    }
    validateExtractSchema(property.items, `${propertyPath}.items`);
  }
}

function validateExtractRuntime(data: unknown, kind: string): void {
  const text = isRecord(data) ? data.text : null;
  const format = isRecord(text) ? text.format : null;
  if (
    !isRecord(data) ||
    data.model !== "default" ||
    data.mode !== "enhanced" ||
    data.confidence !== true ||
    data.location !== true ||
    data.location_granularity !== "element" ||
    !isRecord(text) ||
    !isRecord(format) ||
    format.type !== "json_schema" ||
    typeof format.name !== "string"
  ) {
    throw new Error(`${kind} must use the supported Extract runtime contract.`);
  }
  validateExtractSchema(format.schema, `${kind}.extract.schema`);
}

export function validateStudioManifest(value: unknown): asserts value is StudioManifest {
  if (!isRecord(value)) throw new Error("Studio manifest must be an object.");
  const remoteRetention = isRecord(value.remoteRetention) ? value.remoteRetention : null;
  if (value.schemaVersion !== 1) throw new Error("Unsupported Studio manifest schema version.");
  if (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
    throw new Error("Studio manifest fingerprint must be a SHA-256 hex value.");
  }
  if (!isRecord(value.ownership) || value.ownership.noAdoption !== true || typeof value.ownership.marker !== "string") {
    throw new Error("Studio manifest requires an explicit no-adoption ownership marker.");
  }
  if (
    value.outputEnvelopeVersion !== "studio-document-envelope/v1" ||
    value.responseParserVersion !== "studio-response-parser/v2" ||
    !isRecord(value.fallbackPolicy) ||
    value.fallbackPolicy.default !== "disabled" ||
    !remoteRetention ||
    !Array.isArray(remoteRetention.deleteOnTerminal) ||
    !["success", "failure", "timeout", "parse_error", "fallback"].every((reason) =>
      (remoteRetention.deleteOnTerminal as unknown[]).includes(reason)
    )
  ) {
    throw new Error("Studio manifest versions, fallback, or retention policy are invalid.");
  }
  if (!Array.isArray(value.contracts) || value.contracts.length !== INGEST_DOCUMENT_KINDS.length) {
    throw new Error("Studio manifest must contain exactly six document contracts.");
  }
  const kinds = new Set<string>();
  const agents = new Set<string>();
  for (const contract of value.contracts) {
    if (!isRecord(contract) || typeof contract.kind !== "string" || !INGEST_DOCUMENT_KINDS.includes(contract.kind as IngestDocumentKind)) {
      throw new Error("Studio manifest has an unknown document kind.");
    }
    if (!kinds.add(contract.kind)) throw new Error(`Studio manifest duplicates kind ${contract.kind}.`);
    if (typeof contract.agentLogicalName !== "string" || !agents.add(contract.agentLogicalName)) {
      throw new Error("Studio manifest agent names must be unique.");
    }
    if (!Array.isArray(contract.steps) || contract.steps.length !== 2) throw new Error(`${contract.kind} requires two physical Studio steps.`);
    if (typeof contract.description !== "string" || contract.description.length === 0) throw new Error(`${contract.kind} requires a description.`);
    const names = new Set<string>();
    let first = 0;
    for (const step of contract.steps) {
      if (!isRecord(step) || typeof step.logicalName !== "string" || !names.add(step.logicalName)) throw new Error(`${contract.kind} has duplicate/invalid step names.`);
      if (!["document-parse", "information-extract"].includes(String(step.type))) throw new Error(`${contract.kind} has unknown step type.`);
      if (step.is_first === true) first += 1;
      if (!Array.isArray(step.next_steps) || step.next_steps.some((edge) => !isRecord(edge) || typeof edge.step_name !== "string")) {
        throw new Error(`${contract.kind} has malformed next_steps.`);
      }
    }
    const parse = contract.steps.find((step) => step.logicalName === "parse");
    const [parseStep, extractStep] = contract.steps;
    if (
      first !== 1 ||
      !parse ||
      parse.type !== "document-parse" ||
      parse.is_first !== true ||
      parseStep.type !== "document-parse" ||
      extractStep.type !== "information-extract" ||
      extractStep.logicalName !== `extract_${contract.kind}`
    ) throw new Error(`${contract.kind} must use the exact Studio Parse -> Extract contract.`);
    validateExtractRuntime(extractStep.data, contract.kind);
    for (const step of contract.steps) for (const edge of step.next_steps) {
      if (!names.has(edge.step_name)) throw new Error(`${contract.kind} points at an unknown step ${edge.step_name}.`);
    }
    // The documented physical graph is a forward chain; validation/review are application-owned.
    for (let index = 0; index < contract.steps.length; index += 1) {
      const expected = index === contract.steps.length - 1 ? [] : [contract.steps[index + 1].logicalName];
      const actual = contract.steps[index].next_steps.map((edge: { step_name: string }) => edge.step_name);
      if (canonicalStudioJson(actual) !== canonicalStudioJson(expected)) throw new Error(`${contract.kind} must use Studio Parse -> Extract.`);
    }
  }
  if (studioManifestFingerprint(value as StudioManifest) !== value.fingerprint) throw new Error("Studio manifest fingerprint does not match its contents.");
}

export const STUDIO_MANIFEST = rawManifest as StudioManifest;
validateStudioManifest(STUDIO_MANIFEST);
export const STUDIO_MANIFEST_SHA = STUDIO_MANIFEST.fingerprint;

export function getStudioWorkflowIdentity(kind: IngestDocumentKind) {
  const contract = STUDIO_MANIFEST.contracts.find((item) => item.kind === kind);
  if (!contract) throw new Error(`Missing Studio workflow contract for ${kind}.`);
  return {
    kind,
    agentLogicalName: contract.agentLogicalName,
    ownershipMarker: STUDIO_MANIFEST.ownership.marker,
    expectedConfigFingerprint: contract.expectedConfigFingerprint,
    revisionExternalId: contract.expectedConfigExternalId,
    stepNames: Object.fromEntries(contract.steps.map((step) => [step.type, step.logicalName])) as Record<StudioStep["type"], string>,
  };
}
