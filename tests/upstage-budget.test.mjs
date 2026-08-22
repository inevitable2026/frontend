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
    (error) =>
      error instanceof UpstageError &&
      // 예산 소진이라는 사실은 말하되, 관리자 화면에 그대로 실리는 문장이라
      // 내부 용어(Upstage · 예산)는 새지 않아야 한다. pipeline.ts:278·298 이 이 문장을
      // 그대로 `사유` 로 흘려보낸다.
      /시간이 다 됐습니다/.test(error.message) &&
      !/Upstage|예산/.test(error.message),
  );
});
