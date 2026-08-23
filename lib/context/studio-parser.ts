import type {
  DocumentKind,
  EvidenceAnchor,
  ExtractedFields,
  LayoutElement,
  RawEvidenceAnchor,
} from "./types.ts";
import { createHash } from "node:crypto";

const STUDIO_OUTPUT_ENVELOPE_VERSION = "studio-document-envelope/v1";

export class StudioParseError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "StudioParseError";
    this.code = code;
  }
}

type StudioOutputValue = {
  primary: unknown;
  additionalValues: Record<string, unknown> | null;
};

export type StudioStepOutput = {
  stepName: string;
  stepType: string;
  value: StudioOutputValue;
};
export type ParsedStudioWorkflow = {
  parse: { elements: LayoutElement[]; fullText: string; raw: unknown };
  extracted: ExtractedFields;
  validation: { valid: boolean; issues: unknown[]; raw: unknown };
  review: {
    decision: "accepted" | "corrected" | "needs_human_review" | "rejected";
    issues: unknown[];
    evidence: RawEvidenceAnchor[];
    raw: unknown;
  };
  steps: StudioStepOutput[];
};

const MAX_OUTPUT_CHARS = 2_000_000;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOrStructured(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > MAX_OUTPUT_CHARS)
    throw new StudioParseError("OUTPUT_TOO_LARGE");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new StudioParseError("OUTPUT_INVALID_JSON");
  }
}

function outputValue(output: Record<string, unknown>): StudioOutputValue {
  if ("json" in output)
    return { primary: textOrStructured(output.json), additionalValues: null };
  if ("parsed" in output)
    return { primary: textOrStructured(output.parsed), additionalValues: null };
  if ("text" in output)
    return { primary: textOrStructured(output.text), additionalValues: null };
  const content = Array.isArray(output.content) ? output.content : [];
  const candidates = content
    .map(object)
    .filter((item): item is Record<string, unknown> => item !== null)
    .filter((item) => "text" in item || "json" in item || "parsed" in item);
  if (candidates.length !== 1)
    throw new StudioParseError("OUTPUT_CONTENT_AMBIGUOUS");
  const primary = outputValue(candidates[0]).primary;
  const additionalValue =
    candidates[0].additional_values ?? output.additional_values;
  const additional =
    typeof additionalValue === "string"
      ? textOrStructured(additionalValue)
      : additionalValue;
  const additionalObject = object(additional);
  if (!additionalObject) return { primary, additionalValues: null };
  // Studio puts extraction values in `content.text` and transport/provenance
  // details in `additional_values`. They are deliberately kept separate: a
  // field's metadata object must never replace its extracted string/array.
  return { primary, additionalValues: additionalObject };
}

function stepMeta(
  output: Record<string, unknown>,
): { stepName: string; stepType: string } | null {
  const step = object(output.step);
  // Real Studio responses identify graph outputs with `model`; `step_name` is
  // kept for recorded fixtures and older responses.
  const stepName =
    output.step_name ??
    output.stepName ??
    step?.name ??
    output.name ??
    output.model;
  const stepType =
    output.step_type ??
    output.stepType ??
    step?.type ??
    output.type ??
    (typeof stepName === "string" && stepName === "parse"
      ? "document-parse"
      : typeof stepName === "string" && stepName.startsWith("extract_")
        ? "information-extract"
        : undefined);
  return typeof stepName === "string" && typeof stepType === "string"
    ? { stepName, stepType }
    : null;
}

function classify(
  step: StudioStepOutput,
): "parse" | "extract" | "validate" | "review" | null {
  const name = step.stepName.toLowerCase();
  const type = step.stepType.toLowerCase();
  if (name === "parse" || type === "document-parse") return "parse";
  if (name.startsWith("extract_") || type === "information-extract")
    return "extract";
  if (name.startsWith("validate_") || type === "validate") return "validate";
  if (name.startsWith("review_") || type === "review") return "review";
  return null;
}

function expectedStepName(
  kind: Exclude<ReturnType<typeof classify>, null>,
  requestedKind: string,
): string {
  return kind === "parse" ? "parse" : `${kind}_${requestedKind}`;
}

function only(
  steps: StudioStepOutput[],
  kind: Exclude<ReturnType<typeof classify>, null>,
  requestedKind: string,
): StudioStepOutput {
  const expected = expectedStepName(kind, requestedKind);
  const matches = steps.filter(
    (step) => classify(step) === kind && step.stepName === expected,
  );
  if (matches.length !== 1)
    throw new StudioParseError(
      matches.length ? "DUPLICATE_REQUIRED_STEP" : "MISSING_REQUIRED_STEP",
    );
  return matches[0];
}

function parseLayout(value: unknown): {
  elements: LayoutElement[];
  fullText: string;
  raw: unknown;
} {
  const root = object(value);
  if (!root || !Array.isArray(root.elements))
    throw new StudioParseError("PARSE_OUTPUT_INVALID");
  const elements: LayoutElement[] = root.elements.map((candidate) => {
    const element = object(candidate);
    const content = object(element?.content);
    if (
      !element ||
      typeof element.id !== "number" ||
      !Number.isInteger(element.id) ||
      typeof element.page !== "number" ||
      element.page < 1 ||
      !content
    ) {
      throw new StudioParseError("PARSE_ELEMENT_INVALID");
    }
    const coordinates = element.coordinates;
    if (coordinates !== undefined) {
      if (!Array.isArray(coordinates) || coordinates.length < 3)
        throw new StudioParseError("PARSE_COORDINATES_INVALID");
      for (const point of coordinates) {
        const coordinate = object(point);
        if (
          !coordinate ||
          typeof coordinate.x !== "number" ||
          typeof coordinate.y !== "number" ||
          !Number.isFinite(coordinate.x) ||
          !Number.isFinite(coordinate.y) ||
          coordinate.x < 0 ||
          coordinate.x > 1 ||
          coordinate.y < 0 ||
          coordinate.y > 1
        ) {
          throw new StudioParseError("PARSE_COORDINATES_INVALID");
        }
      }
    }
    return element as unknown as LayoutElement;
  });
  const content = object(root.content);
  return {
    elements,
    fullText:
      typeof content?.markdown === "string"
        ? content.markdown
        : typeof content?.text === "string"
          ? content.text
          : "",
    raw: value,
  };
}

function assertKind(value: unknown, requestedKind: string): void {
  const root = object(value);
  if (!root) throw new StudioParseError("OUTPUT_INVALID_ENVELOPE");
  const outputKind = root.kind ?? root.document_kind ?? root.documentKind;
  if (outputKind !== undefined && outputKind !== requestedKind)
    throw new StudioParseError("OUTPUT_WRONG_KIND");
  const version =
    root.schema_version ?? root.schemaVersion ?? root.envelope_version;
  if (version !== undefined && version !== STUDIO_OUTPUT_ENVELOPE_VERSION) {
    throw new StudioParseError("OUTPUT_WRONG_VERSION");
  }
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new StudioParseError(code);
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return string(value, code);
}

function optionalNullableString(value: unknown, code: string): string | null {
  // Enhanced Extract represents an optional scalar with no source value as an
  // empty string, just as it does for optional cells in parallel columns.
  return value === undefined || value === "" ? null : nullableString(value, code);
}

function optionalStringArray(value: unknown, code: string): string[] {
  return value === undefined ? [] : stringArray(value, code);
}

/** Extract represents optional parallel string columns as an empty string. */
function nullableStringArray(
  value: unknown,
  code: string,
): Array<string | null> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new StudioParseError(code);
  return value.map((item) => (item === "" ? null : item));
}

/** A native Extract array column which contains JSON-encoded string ID arrays. */
function encodedStringArrays(value: unknown, code: string): string[][] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new StudioParseError(code);
  return value.map((item) => {
    try {
      return stringArray(JSON.parse(item) as unknown, code);
    } catch (error) {
      if (error instanceof StudioParseError) throw error;
      throw new StudioParseError(code);
    }
  });
}

function assertParallelLength(
  code: string,
  ...columns: ArrayLike<unknown>[]
): void {
  if (new Set(columns.map((column) => column.length)).size !== 1)
    throw new StudioParseError(code);
}

function positiveInteger(value: unknown, code: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:[1-9]\d*)$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new StudioParseError(code);
  return parsed;
}

function stringArray(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new StudioParseError(code);
  }
  return [...new Set(value)];
}

/** Parallel Extract columns retain duplicate values and their original indexes. */
function stringList(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new StudioParseError(code);
  }
  return value;
}

function rawEvidence(value: unknown, code: string): RawEvidenceAnchor[] {
  if (!Array.isArray(value)) throw new StudioParseError(code);
  return value.map((candidate) => {
    const anchor = object(candidate);
    if (
      !anchor ||
      typeof anchor.page !== "number" ||
      !Number.isInteger(anchor.page) ||
      anchor.page < 1 ||
      !["string", "number"].includes(typeof anchor.elementId) ||
      !string(anchor.sourceKey, code) ||
      (anchor.coordinates !== null && !Array.isArray(anchor.coordinates))
    ) {
      throw new StudioParseError(code);
    }
    const coordinates =
      anchor.coordinates === null
        ? null
        : anchor.coordinates.map((point) => {
            const coordinate = object(point);
            if (
              !coordinate ||
              typeof coordinate.x !== "number" ||
              typeof coordinate.y !== "number" ||
              !Number.isFinite(coordinate.x) ||
              !Number.isFinite(coordinate.y) ||
              coordinate.x < 0 ||
              coordinate.x > 1 ||
              coordinate.y < 0 ||
              coordinate.y > 1
            ) {
              throw new StudioParseError(code);
            }
            return { x: coordinate.x, y: coordinate.y };
          });
    return {
      page: anchor.page,
      elementId: String(anchor.elementId),
      sourceKey: anchor.sourceKey as string,
      coordinates,
    };
  });
}

function validateCommon(
  root: Record<string, unknown>,
  output: ExtractedFields,
): void {
  for (const key of ["업체명", "현장명"] as const) {
    output[key] = optionalNullableString(root[key], "EXTRACT_COMMON_INVALID");
  }
  for (const key of ["공종", "장비", "자재"] as const) {
    output[key] = optionalStringArray(root[key], "EXTRACT_COMMON_INVALID");
  }
}

function extractedFieldsRoot(value: unknown): Record<string, unknown> {
  const envelope = object(value);
  if (!envelope) throw new StudioParseError("EXTRACT_OUTPUT_INVALID");
  return object(envelope.fields) ?? object(envelope.extracted) ?? envelope;
}

function validateExtracted(
  value: unknown,
  requestedKind: DocumentKind,
): ExtractedFields {
  const root = extractedFieldsRoot(value);
  const output: ExtractedFields = {};
  validateCommon(root, output);
  const evidence = rawEvidence(root.evidence ?? [], "EXTRACT_EVIDENCE_INVALID");
  output.evidence = evidence;

  if (requestedKind === "하도급계약서") {
    output.계약금액 = optionalNullableString(
      root.계약금액,
      "EXTRACT_CONTRACT_INVALID",
    );
    output.공사기간 = optionalNullableString(
      root.공사기간,
      "EXTRACT_CONTRACT_INVALID",
    );
  } else if (requestedKind === "위험성평가표") {
    const itemIds = stringList(root.평가항목ID, "EXTRACT_ASSESSMENT_INVALID");
    const hazards = stringList(root.위험요인, "EXTRACT_ASSESSMENT_INVALID");
    const riskLevels = nullableStringArray(
      root.위험도,
      "EXTRACT_ASSESSMENT_INVALID",
    );
    const mitigationIdsByItem = encodedStringArrays(
      root.평가항목저감조치IDs,
      "EXTRACT_ASSESSMENT_INVALID",
    );
    const mitigationIds = stringList(
      root.저감조치ID,
      "EXTRACT_ASSESSMENT_INVALID",
    );
    const assessmentIdsByMitigation = encodedStringArrays(
      root.저감조치평가항목IDs,
      "EXTRACT_ASSESSMENT_INVALID",
    );
    const descriptions = stringList(
      root.저감조치내용,
      "EXTRACT_ASSESSMENT_INVALID",
    );
    const statuses = nullableStringArray(
      root.저감조치상태,
      "EXTRACT_ASSESSMENT_INVALID",
    );
    assertParallelLength(
      "EXTRACT_ASSESSMENT_INVALID",
      itemIds,
      hazards,
      riskLevels,
      mitigationIdsByItem,
    );
    assertParallelLength(
      "EXTRACT_ASSESSMENT_INVALID",
      mitigationIds,
      assessmentIdsByMitigation,
      descriptions,
      statuses,
    );
    output.평가항목 = itemIds.map((itemId, index) => ({
      itemId,
      hazard: hazards[index],
      riskLevel: riskLevels[index],
      mitigationIds: mitigationIdsByItem[index],
      evidence: [],
    }));
    output.저감조치 = mitigationIds.map((mitigationId, index) => ({
      mitigationId,
      assessmentItemIds: assessmentIdsByMitigation[index],
      description: descriptions[index],
      status: statuses[index],
      evidence: [],
    }));
    const uniqueItemIds = new Set(output.평가항목.map((item) => item.itemId));
    const uniqueMitigationIds = new Set(
      output.저감조치.map((item) => item.mitigationId),
    );
    if (
      uniqueItemIds.size !== output.평가항목.length ||
      uniqueMitigationIds.size !== output.저감조치.length
    ) {
      throw new StudioParseError("EXTRACT_ASSESSMENT_DUPLICATE_ID");
    }
    for (const item of output.평가항목) {
      if (item.mitigationIds.some((id) => !uniqueMitigationIds.has(id)))
        throw new StudioParseError("EXTRACT_ASSESSMENT_LINK_INVALID");
      for (const id of item.mitigationIds) {
        if (
          !output.저감조치
            .find((mitigation) => mitigation.mitigationId === id)
            ?.assessmentItemIds.includes(item.itemId)
        ) {
          throw new StudioParseError("EXTRACT_ASSESSMENT_LINK_INVALID");
        }
      }
    }
    for (const mitigation of output.저감조치) {
      if (mitigation.assessmentItemIds.some((id) => !uniqueItemIds.has(id)))
        throw new StudioParseError("EXTRACT_ASSESSMENT_LINK_INVALID");
    }
  } else if (requestedKind === "TBM회의록") {
    output.일자 = optionalNullableString(root.일자, "EXTRACT_TBM_INVALID");
    output.참석자 = optionalStringArray(root.참석자, "EXTRACT_TBM_INVALID");
    output.중점위험요인 = optionalNullableString(
      root.중점위험요인,
      "EXTRACT_TBM_INVALID",
    );
  } else if (requestedKind === "작업표준") {
    output.작업명 = optionalNullableString(
      root.작업명,
      "EXTRACT_WORK_STANDARD_INVALID",
    );
    output.보호구 = optionalStringArray(
      root.보호구,
      "EXTRACT_WORK_STANDARD_INVALID",
    );
    const stepIds = stringList(
      root.작업단계ID,
      "EXTRACT_WORK_STANDARD_INVALID",
    );
    const orders = stringList(root.작업순서, "EXTRACT_WORK_STANDARD_INVALID");
    const names = stringList(root.작업단계명, "EXTRACT_WORK_STANDARD_INVALID");
    const hazards = nullableStringArray(
      root.작업단계위험요인,
      "EXTRACT_WORK_STANDARD_INVALID",
    );
    const controls = encodedStringArrays(
      root.작업단계통제조치,
      "EXTRACT_WORK_STANDARD_INVALID",
    );
    const ppe = encodedStringArrays(
      root.작업단계보호구,
      "EXTRACT_WORK_STANDARD_INVALID",
    );
    assertParallelLength(
      "EXTRACT_WORK_STANDARD_INVALID",
      stepIds,
      orders,
      names,
      hazards,
      controls,
      ppe,
    );
    output.작업단계 = stepIds.map((stepId, index) => ({
      stepId,
      order: positiveInteger(orders[index], "EXTRACT_WORK_STANDARD_INVALID"),
      name: names[index],
      hazard: hazards[index],
      controls: controls[index],
      ppe: ppe[index],
      evidence: [],
    }));
    const uniqueStepIds = new Set(output.작업단계.map((step) => step.stepId));
    const uniqueOrders = new Set(output.작업단계.map((step) => step.order));
    if (
      uniqueStepIds.size !== output.작업단계.length ||
      uniqueOrders.size !== output.작업단계.length
    ) {
      throw new StudioParseError("EXTRACT_WORK_STANDARD_DUPLICATE");
    }
  } else if (requestedKind === "순회점검일지") {
    output.점검일자 = optionalNullableString(
      root.점검일자,
      "EXTRACT_PATROL_INVALID",
    );
    const findingIds = stringList(root.지적사항ID, "EXTRACT_PATROL_INVALID");
    const findingDescriptions = stringList(
      root.지적내용,
      "EXTRACT_PATROL_INVALID",
    );
    const severities = nullableStringArray(
      root.지적심각도,
      "EXTRACT_PATROL_INVALID",
    );
    const actionIdsByFinding = encodedStringArrays(
      root.지적사항조치IDs,
      "EXTRACT_PATROL_INVALID",
    );
    const actionIds = stringList(root.조치사항ID, "EXTRACT_PATROL_INVALID");
    const findingIdsByAction = encodedStringArrays(
      root.조치사항지적IDs,
      "EXTRACT_PATROL_INVALID",
    );
    const actionDescriptions = stringList(
      root.조치내용,
      "EXTRACT_PATROL_INVALID",
    );
    const actionStatuses = nullableStringArray(
      root.조치상태,
      "EXTRACT_PATROL_INVALID",
    );
    const dueDates = nullableStringArray(
      root.조치기한,
      "EXTRACT_PATROL_INVALID",
    );
    assertParallelLength(
      "EXTRACT_PATROL_INVALID",
      findingIds,
      findingDescriptions,
      severities,
      actionIdsByFinding,
    );
    assertParallelLength(
      "EXTRACT_PATROL_INVALID",
      actionIds,
      findingIdsByAction,
      actionDescriptions,
      actionStatuses,
      dueDates,
    );
    output.지적사항 = findingIds.map((findingId, index) => ({
      findingId,
      description: findingDescriptions[index],
      severity: severities[index],
      actionIds: actionIdsByFinding[index],
      evidence: [],
    }));
    output.조치사항 = actionIds.map((actionId, index) => ({
      actionId,
      findingIds: findingIdsByAction[index],
      description: actionDescriptions[index],
      status: actionStatuses[index],
      dueDate: dueDates[index],
      evidence: [],
    }));
    const uniqueFindingIds = new Set(
      output.지적사항.map((item) => item.findingId),
    );
    const uniqueActionIds = new Set(
      output.조치사항.map((item) => item.actionId),
    );
    if (
      uniqueFindingIds.size !== output.지적사항.length ||
      uniqueActionIds.size !== output.조치사항.length
    ) {
      throw new StudioParseError("EXTRACT_PATROL_DUPLICATE_ID");
    }
    for (const finding of output.지적사항) {
      if (finding.actionIds.some((id) => !uniqueActionIds.has(id)))
        throw new StudioParseError("EXTRACT_PATROL_LINK_INVALID");
      for (const id of finding.actionIds) {
        if (
          !output.조치사항
            .find((action) => action.actionId === id)
            ?.findingIds.includes(finding.findingId)
        ) {
          throw new StudioParseError("EXTRACT_PATROL_LINK_INVALID");
        }
      }
    }
    for (const action of output.조치사항) {
      if (action.findingIds.some((id) => !uniqueFindingIds.has(id)))
        throw new StudioParseError("EXTRACT_PATROL_LINK_INVALID");
    }
  } else {
    output.문서유형 = optionalNullableString(
      root.문서유형,
      "EXTRACT_GENERAL_INVALID",
    );
    output.요약 = optionalNullableString(root.요약, "EXTRACT_GENERAL_INVALID");
  }
  return output;
}

type Point = { x: number; y: number };

function coordinates(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const points: Point[] = [];
  for (const candidate of value) {
    const point = object(candidate);
    if (
      !point ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1
    )
      return null;
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

function sameCoordinates(left: Point[], right: Point[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (point, index) =>
        point.x === right[index].x && point.y === right[index].y,
    )
  );
}

function bounds(points: Point[]): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function overlapsOrContains(left: Point[], right: Point[]): boolean {
  const a = bounds(left);
  const b = bounds(right);
  return (
    a.left <= b.right &&
    b.left <= a.right &&
    a.top <= b.bottom &&
    b.top <= a.bottom
  );
}

function anchorElement(
  page: number,
  fieldCoordinates: Point[],
  elements: LayoutElement[],
): LayoutElement | null {
  const candidates = elements
    .filter((element) => element.page === page)
    .map((element) => ({
      element,
      coordinates: coordinates(element.coordinates),
    }))
    .filter(
      (
        candidate,
      ): candidate is { element: LayoutElement; coordinates: Point[] } =>
        candidate.coordinates !== null,
    )
    .sort((left, right) => left.element.id - right.element.id);
  return (
    candidates.find((candidate) =>
      sameCoordinates(candidate.coordinates, fieldCoordinates),
    )?.element ??
    candidates.find((candidate) =>
      overlapsOrContains(candidate.coordinates, fieldCoordinates),
    )?.element ??
    null
  );
}

const TRANSPORT_METADATA_KEYS = new Set([
  "previous_step_name",
  "step_run_id",
  "occurrence_id",
  "job_execution_id",
  "cache_hit",
]);

/**
 * Studio's Extract node returns values in `content.text` and per-field layout
 * metadata in `additional_values`. Array metadata is indexed by its native
 * primitive value, preserving the only safe correspondence for reassembled
 * parallel columns. Evidence is derived only when it can be matched to a
 * Parse element; this keeps review fail-closed without manufacturing IDs.
 */
type EvidenceDerivation = {
  anchors: RawEvidenceAnchor[];
  indexed: Map<string, Array<RawEvidenceAnchor | null>>;
};

function deriveFieldEvidence(
  value: unknown,
  additionalValues: Record<string, unknown> | null,
  elements: LayoutElement[],
): EvidenceDerivation {
  if (!additionalValues) return { anchors: [], indexed: new Map() };
  const fields = extractedFieldsRoot(value);
  const anchors: RawEvidenceAnchor[] = [];
  const indexed = new Map<string, Array<RawEvidenceAnchor | null>>();
  const anchor = (
    sourceKey: string,
    metadataValue: unknown,
    expectedValue: unknown,
  ): RawEvidenceAnchor | null => {
    const metadata = object(metadataValue);
    if (!metadata || !("_value" in metadata) || !hasClaim(metadata._value))
      return null;
    if (metadata._value !== expectedValue) return null;
    const page = metadata.page;
    const fieldCoordinates = coordinates(metadata.coordinates);
    if (
      typeof page !== "number" ||
      !Number.isInteger(page) ||
      page < 1 ||
      !fieldCoordinates
    )
      return null;
    const element = anchorElement(page, fieldCoordinates, elements);
    return element
      ? {
          page,
          elementId: String(element.id),
          sourceKey,
          coordinates: fieldCoordinates,
        }
      : null;
  };
  for (const [sourceKey, metadataValue] of Object.entries(additionalValues)) {
    if (TRANSPORT_METADATA_KEYS.has(sourceKey) || !hasClaim(fields[sourceKey]))
      continue;
    if (Array.isArray(metadataValue)) {
      const values = metadataValue.map((candidate, index) =>
        anchor(
          sourceKey,
          candidate,
          Array.isArray(fields[sourceKey])
            ? fields[sourceKey][index]
            : undefined,
        ),
      );
      indexed.set(sourceKey, values);
      anchors.push(
        ...values.filter(
          (candidate): candidate is RawEvidenceAnchor => candidate !== null,
        ),
      );
      continue;
    }
    const result = anchor(sourceKey, metadataValue, fields[sourceKey]);
    if (result) anchors.push(result);
  }
  return { anchors, indexed };
}

function attachCollectionEvidence(
  extracted: ExtractedFields,
  indexedEvidence: EvidenceDerivation["indexed"],
): ExtractedFields {
  const attach = <T extends { evidence: RawEvidenceAnchor[] }>(
    items: T[] | undefined,
    sourceKeys: string[],
  ): T[] | undefined => {
    if (!items) return items;
    return items.map((item, index) =>
      item.evidence.length > 0
        ? item
        : {
            ...item,
            evidence: sourceKeys.flatMap(
              (sourceKey) => indexedEvidence.get(sourceKey)?.[index] ?? [],
            ),
          },
    );
  };
  return {
    ...extracted,
    평가항목: attach(extracted.평가항목, [
      "평가항목ID",
      "위험요인",
      "위험도",
      "평가항목저감조치IDs",
    ]),
    저감조치: attach(extracted.저감조치, [
      "저감조치ID",
      "저감조치평가항목IDs",
      "저감조치내용",
      "저감조치상태",
    ]),
    작업단계: attach(extracted.작업단계, [
      "작업단계ID",
      "작업순서",
      "작업단계명",
      "작업단계위험요인",
      "작업단계통제조치",
      "작업단계보호구",
    ]),
    지적사항: attach(extracted.지적사항, [
      "지적사항ID",
      "지적내용",
      "지적심각도",
      "지적사항조치IDs",
    ]),
    조치사항: attach(extracted.조치사항, [
      "조치사항ID",
      "조치사항지적IDs",
      "조치내용",
      "조치상태",
      "조치기한",
    ]),
  };
}

function enrichEvidence(
  extracted: ExtractedFields,
  responseId: string,
  stepName: string,
  elements: LayoutElement[],
): ExtractedFields {
  const validElements = new Set(
    elements.map((element) => `${element.page}:${element.id}`),
  );
  const enrich = (anchor: EvidenceAnchor) => {
    if ("evidenceId" in anchor) return anchor;
    if (!validElements.has(`${anchor.page}:${anchor.elementId}`))
      throw new StudioParseError("EVIDENCE_ELEMENT_MISSING");
    const canonical = JSON.stringify({
      coordinates: anchor.coordinates,
      elementId: anchor.elementId,
      page: anchor.page,
      sourceKey: anchor.sourceKey,
    });
    return {
      ...anchor,
      evidenceId: createHash("sha256")
        .update(`${responseId}\n${stepName}\n${canonical}`)
        .digest("hex"),
      responseId,
      stepName,
    };
  };
  return {
    ...extracted,
    evidence: (extracted.evidence ?? []).map(enrich),
    평가항목: extracted.평가항목?.map((item) => ({
      ...item,
      evidence: item.evidence.map(enrich),
    })),
    저감조치: extracted.저감조치?.map((item) => ({
      ...item,
      evidence: item.evidence.map(enrich),
    })),
    작업단계: extracted.작업단계?.map((item) => ({
      ...item,
      evidence: item.evidence.map(enrich),
    })),
    지적사항: extracted.지적사항?.map((item) => ({
      ...item,
      evidence: item.evidence.map(enrich),
    })),
    조치사항: extracted.조치사항?.map((item) => ({
      ...item,
      evidence: item.evidence.map(enrich),
    })),
  };
}

function hasClaim(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== "";
}

/**
 * 근거를 못 댄 주장이 무엇이었는지 적는다.
 *
 * 이 오류가 났을 때 남는 것이 코드 한 줄뿐이면, 문서를 다시 올려 보는 것 말고는 할 수
 * 있는 일이 없다. 손글씨가 든 순회점검일지에서 실제로 그랬다 — 사람은 읽히는데 무엇이
 * 걸렸는지 알 길이 없었다.
 *
 * **화면에는 나가지 않는다.** `StudioError` 가 사용자 문장을 따로 고르고, 이 글은
 * `cause` 를 타고 서버 로그에만 남는다.
 */
function 근거없는주장(extracted: ExtractedFields): string {
  const 빈것: string[] = [];
  const 중첩 = [
    ["평가항목", extracted.평가항목],
    ["저감조치", extracted.저감조치],
    ["작업단계", extracted.작업단계],
    ["지적사항", extracted.지적사항],
    ["조치사항", extracted.조치사항],
  ] as const;
  for (const [이름, 목록] of 중첩) {
    const 없는것 = (목록 ?? []).filter((item) => item.evidence.length === 0).length;
    if (없는것 > 0) 빈것.push(`${이름} ${없는것}/${(목록 ?? []).length}건`);
  }
  if ((extracted.evidence?.length ?? 0) === 0) 빈것.push("문서 전체 근거 0건");
  return 빈것.length > 0 ? `근거 없는 주장: ${빈것.join(" · ")}` : "근거 없는 주장을 특정하지 못함";
}

function assertAcceptedEvidence(extracted: ExtractedFields): void {
  const topLevelClaim = [
    extracted.업체명,
    extracted.현장명,
    extracted.공종,
    extracted.장비,
    extracted.자재,
    extracted.계약금액,
    extracted.공사기간,
    extracted.일자,
    extracted.참석자,
    extracted.중점위험요인,
    extracted.작업명,
    extracted.보호구,
    extracted.점검일자,
    extracted.문서유형,
    extracted.요약,
  ].some(hasClaim);
  if (topLevelClaim && (extracted.evidence?.length ?? 0) === 0) {
    throw new StudioParseError("ACCEPTED_CLAIM_MISSING_EVIDENCE", 근거없는주장(extracted));
  }
  const nested = [
    ...(extracted.평가항목 ?? []),
    ...(extracted.저감조치 ?? []),
    ...(extracted.작업단계 ?? []),
    ...(extracted.지적사항 ?? []),
    ...(extracted.조치사항 ?? []),
  ];
  if (nested.some((item) => item.evidence.length === 0)) {
    throw new StudioParseError("ACCEPTED_CLAIM_MISSING_EVIDENCE", 근거없는주장(extracted));
  }
}

function extractedEvidenceAnchors(
  extracted: ExtractedFields,
): EvidenceAnchor[] {
  return [
    ...(extracted.evidence ?? []),
    ...(extracted.평가항목 ?? []).flatMap((item) => item.evidence),
    ...(extracted.저감조치 ?? []).flatMap((item) => item.evidence),
    ...(extracted.작업단계 ?? []).flatMap((item) => item.evidence),
    ...(extracted.지적사항 ?? []).flatMap((item) => item.evidence),
    ...(extracted.조치사항 ?? []).flatMap((item) => item.evidence),
  ];
}

function applicationValidationAndReview(
  extracted: ExtractedFields,
): Pick<ParsedStudioWorkflow, "validation" | "review"> {
  // These stages are deliberately deterministic application logic. Studio only
  // performs the documented Parse -> Extract topology.
  assertAcceptedEvidence(extracted);
  const evidence = extractedEvidenceAnchors(extracted);
  return {
    validation: {
      valid: true,
      issues: [],
      raw: { owner: "application", stage: "validation" },
    },
    review: {
      decision: "accepted",
      issues: [],
      evidence,
      raw: { owner: "application", stage: "review" },
    },
  };
}

/** Parses all graph outputs; array order and unrelated response messages are intentionally ignored. */
export function parseStudioWorkflowResponse(
  payload: unknown,
  requestedKind: DocumentKind,
): ParsedStudioWorkflow {
  const root = object(payload);
  const outputs = Array.isArray(root?.output)
    ? root.output
    : Array.isArray(root?.outputs)
      ? root.outputs
      : null;
  if (!outputs) throw new StudioParseError("RESPONSE_OUTPUT_MISSING");
  const steps = outputs
    .map(object)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const meta = stepMeta(item);
      if (!meta) return null;
      return { ...meta, value: outputValue(item) };
    })
    .filter((item): item is StudioStepOutput => item !== null);
  const parse = only(steps, "parse", requestedKind);
  const extract = only(steps, "extract", requestedKind);
  assertKind(extract.value.primary, requestedKind);
  const parsedLayout = parseLayout(parse.value.primary);
  const responseId = string(root?.id, "RESPONSE_ID_MISSING");
  const validated = validateExtracted(extract.value.primary, requestedKind);
  const derivedEvidence = deriveFieldEvidence(
    extract.value.primary,
    extract.value.additionalValues,
    parsedLayout.elements,
  );
  const extracted = enrichEvidence(
    attachCollectionEvidence(
      {
        ...validated,
        evidence: [...(validated.evidence ?? []), ...derivedEvidence.anchors],
      },
      derivedEvidence.indexed,
    ),
    responseId,
    extract.stepName,
    parsedLayout.elements,
  );
  const application = applicationValidationAndReview(extracted);
  const unrelatedStudioSteps = steps
    .filter((step) => classify(step) !== null)
    .filter(
      (step) => ![parse.stepName, extract.stepName].includes(step.stepName),
    );
  if (unrelatedStudioSteps.length > 0)
    throw new StudioParseError("UNEXPECTED_STUDIO_STEP");
  return {
    parse: parsedLayout,
    extracted,
    validation: application.validation,
    review: application.review,
    steps: [parse, extract],
  };
}
