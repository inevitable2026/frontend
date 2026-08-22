import assert from "node:assert/strict";
import test from "node:test";
import { canSaveStudioJob } from "../tmp/test-dist/lib/context/job-save-policy.js";

const stage = (execution) => ({
  이름: "레이아웃분석",
  상태: "완료",
  시작: null,
  소요ms: 1,
  산출: { execution },
});

test("save policy requires successful Studio execution, cleanup, and an active human-save window", () => {
  assert.equal(canSaveStudioJob({ mode: "live", status: "done", steps: [stage({ mode: "studio", cleanup: "deleted" })], cleanupDeadline: new Date(Date.now() + 1_000) }).allowed, true);
  assert.equal(canSaveStudioJob({ mode: "live", status: "done", steps: [stage({ mode: "studio", cleanup: "deleted" })] }).allowed, false);
  assert.equal(canSaveStudioJob({ mode: "live", status: "done", steps: [stage({ mode: "studio", cleanup: "failed" })], cleanupDeadline: new Date(Date.now() + 1_000) }).allowed, false);
  assert.equal(canSaveStudioJob({ mode: "live", status: "done", steps: null }).allowed, false);
  assert.equal(canSaveStudioJob({ mode: "demo", status: "done", steps: [stage({ mode: "studio", cleanup: "deleted" })], cleanupDeadline: new Date(Date.now() + 1_000) }).allowed, false);
  assert.equal(
    canSaveStudioJob({
      mode: "live",
      status: "done",
      steps: [stage({ mode: "studio", cleanup: "deleted" })],
      cleanupDeadline: new Date(1_000),
      now: 1_000,
    }).allowed,
    false,
  );
});
