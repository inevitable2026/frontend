import assert from "node:assert/strict";
import test from "node:test";

import { planTransition, TransitionError } from "../tmp/test-dist/lib/board/transition.js";

function item(overrides = {}) {
  return {
    itemId: "card-1",
    siteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae",
    timing: "trigger",
    status: "approval",
    origin: "machine",
    title: "카드",
    summary: null,
    trigger: null,
    invalidates: [],
    produces: [],
    draft: null,
    confirmedBy: null,
    confirmedAt: null,
    dueBy: null,
    estimatedMinutes: null,
    assignee: null,
    delegable: true,
    blockedBy: [],
    laneOrder: 1,
    createdAt: "2026-08-23T09:00:00+09:00",
    updatedAt: "2026-08-23T09:00:00+09:00",
    ...overrides,
  };
}

test("generic completion rejects meeting drafts before card confirmation", () => {
  assert.throws(
    () => planTransition(item({ draft: { form: "회의록", 제목: "위험성평가", supersedes: null, rows: [] } }), { status: "done", confirmedBy: "검토자" }),
    (error) => error instanceof TransitionError
      && error.code === "meetingDraftRequiresRowApproval"
      && error.status === 409
      && error.message.includes("행별 승인 적용"),
  );
});

test("generic completion remains available to non-meeting cards", () => {
  const plan = planTransition(item({ draft: { form: "기록", 제목: "작업 기록", 본문: "확인" } }), { status: "done", confirmedBy: "검토자" });

  assert.equal(plan.kind, "confirm");
  assert.equal(plan.to, "done");
});

test("Postgres detector upsert preserves a confirmed draft", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lib/board/store-pg.ts", import.meta.url), "utf8"));

  assert.match(
    source,
    /draft\s*=\s*case\s+when board\.work_items\.confirmed_at is null then excluded\.draft\s+else board\.work_items\.draft\s+end/s,
  );
});
