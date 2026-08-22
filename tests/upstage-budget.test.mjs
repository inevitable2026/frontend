import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetTimeoutMs,
  UpstageError,
} from "../tmp/test-dist/lib/context/upstage-doc.js";

test("never extends an embedding request past the absolute processing deadline", () => {
  assert.equal(
    budgetTimeoutMs({ limitMs: 15_000, deadline: 10_750 }, 10_000),
    750,
  );
  assert.equal(
    budgetTimeoutMs({ limitMs: 15_000, deadline: 10_001 }, 10_000),
    1,
  );
});

test("fails before an Upstage call once the absolute budget is exhausted", () => {
  assert.throws(
    () => budgetTimeoutMs({ limitMs: 15_000, deadline: 10_000 }, 10_000),
    (error) => error instanceof UpstageError && /만료/.test(error.message),
  );
});
