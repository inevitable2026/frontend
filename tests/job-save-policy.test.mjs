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

// 거절 사유는 저장 버튼 옆 안내로 그대로 나간다. 원인마다 관리자가 할 일이 다르므로
// 문구를 하나로 합치면 안 되고, `pending`·`running` 같은 저장 값이 새어 나가면 안 된다.
test("each rejection keeps its own admin-readable reason", () => {
  const ok = { mode: "live", status: "done", steps: [stage({ mode: "studio", cleanup: "deleted" })], cleanupDeadline: new Date(Date.now() + 1_000) };
  const cases = [
    ["demo", { ...ok, mode: "demo" }],
    ["pending", { ...ok, status: "pending" }],
    ["running", { ...ok, status: "running" }],
    ["failed", { ...ok, status: "failed" }],
    ["no save window", { ...ok, cleanupDeadline: null }],
    ["save window closed", { ...ok, cleanupDeadline: new Date(1_000), now: 1_000 }],
    ["cleanup unconfirmed", { ...ok, steps: [stage({ mode: "studio", cleanup: "failed" })] }],
  ];

  const reasons = new Map();
  for (const [label, input] of cases) {
    const result = canSaveStudioJob(input);
    assert.equal(result.allowed, false, `${label} must stay blocked`);
    assert.doesNotMatch(result.reason, /[A-Za-z]/, `${label} leaks an internal value: ${result.reason}`);
    assert.match(result.reason, /(습니다|주세요)\.$/, `${label} is not 합쇼체: ${result.reason}`);
    assert.equal(reasons.has(result.reason), false, `${label} reuses the reason of ${reasons.get(result.reason)}`);
    reasons.set(result.reason, label);
  }
  assert.equal(reasons.size, cases.length);
});
