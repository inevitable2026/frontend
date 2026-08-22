import assert from "node:assert/strict";
import test from "node:test";

import {
  formatExtractedField,
  formatExtractedFieldValue,
  hasExtractedDisplayValue,
  알려진필드인가,
  필드이름,
} from "../tmp/test-dist/lib/context/extracted-display.js";

test("formats primitive extracted values and lists without changing their readable form", () => {
  assert.equal(formatExtractedFieldValue("강남 업무시설"), "강남 업무시설");
  assert.equal(formatExtractedFieldValue(["안전모", "안전화"]), "안전모, 안전화");
  assert.equal(hasExtractedDisplayValue([]), false);
});

test("renders nested work-step rows with labels and compact evidence", () => {
  const value = [{
    stepId: "step-1",
    order: 1,
    name: "자재 반입",
    hazard: "낙하",
    controls: ["통로 분리", "유도자 배치"],
    ppe: ["안전모"],
    evidence: [{ page: 1, elementId: "0" }],
  }];

  const display = formatExtractedFieldValue(value);

  assert.doesNotMatch(display, /\[object Object\]/);
  assert.match(display, /순서: 1/);
  assert.match(display, /작업: 자재 반입/);
  assert.match(display, /위험요인: 낙하/);
  assert.match(display, /저감조치: 통로 분리, 유도자 배치/);
  assert.match(display, /보호구: 안전모/);
  assert.match(display, /근거 1건/);
  assert.doesNotMatch(display, /elementId/);
});

test("compacts top-level evidence without leaking technical anchor fields", () => {
  const display = formatExtractedField("evidence", [
    { page: 1, responseId: "response-1", coordinates: [{ x: 0.1, y: 0.2 }] },
    { page: 2, responseId: "response-1", coordinates: [{ x: 0.3, y: 0.4 }] },
  ]);

  assert.equal(display, "근거 2건");
  assert.doesNotMatch(display, /\[object Object\]|page|responseId|coordinates/);
});

test("labels identifier fields without the ID wording", () => {
  assert.equal(필드이름("stepId"), "작업 단계");
  assert.equal(필드이름("itemId"), "평가 항목");
  assert.equal(필드이름("mitigationId"), "저감조치");
  assert.equal(필드이름("actionId"), "조치");
  for (const key of ["stepId", "itemId", "mitigationId", "actionId"]) {
    assert.doesNotMatch(필드이름(key), /ID/i);
  }
});

test("flags field keys that would print an english field name on screen", () => {
  assert.equal(알려진필드인가("hazard"), true);
  assert.equal(알려진필드인가("evidence"), true);
  assert.equal(알려진필드인가("업체명"), true);
  assert.equal(알려진필드인가("중점위험요인"), true);
  assert.equal(알려진필드인가("rawScore"), false);
  assert.equal(알려진필드인가("responseId"), false);
  assert.equal(필드이름("rawScore"), "rawScore");
});
