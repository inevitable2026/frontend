import assert from "node:assert/strict";
import test from "node:test";
import { replayDemo } from "../tmp/test-dist/lib/context/demo.js";

test("demo emits kind-local synthetic provenance with zero calls and no legacy live completion", async () => {
  const events = [];
  for await (const event of replayDemo("job-1", "기타", "local.pdf", 1234, async () => {})) events.push(event);
  const completed = events.filter((event) => event.종류 === "완료");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].upstageCalls, 0);
  assert.equal(completed[0].execution.mode, "demo");
  assert.equal(completed[0].execution.selectedKind, "기타");
  assert.equal(completed[0].execution.cleanup, "not_applicable");
});

test("explains a missing demo in field words and says what to do next", async () => {
  const events = [];
  for await (const event of replayDemo("job-2", "메일", "local.pdf", 1234, async () => {})) events.push(event);
  const failed = events.filter((event) => event.종류 === "실패");
  assert.equal(failed.length, 1);
  assert.doesNotMatch(failed[0].사유, /픽스처|재생/);
  assert.match(failed[0].사유, /메일/);
  assert.match(failed[0].사유, /골라 주세요/);
});
