import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_ISSUE_CARD_ID, 시연대상인가 } from "../tmp/test-dist/lib/board/demo.js";

/**
 * 시연 예외는 **좁아야 한다.**
 *
 * 이 예외가 하는 일은 처리된 카드를 계속 「처리할 이슈」로 보이게 하는 것이다. 그건
 * 평소에는 거짓말이다 — 오직 시연 중 그 한 건에서만, 화면이 시연임을 밝히면서 허용된다.
 *
 * 그래서 넓어지는 쪽으로 실수하면 안 된다. 여기 적는 것은 "잘 도는가" 가 아니라
 * **엉뚱한 데 걸리지 않는가** 다.
 */

test("플래그와 카드가 둘 다 맞아야 한다", () => {
  assert.equal(시연대상인가(true, DEMO_ISSUE_CARD_ID), true);

  // 플래그만 켜진 경우 — 다른 카드는 절대 걸리지 않는다.
  assert.equal(시연대상인가(true, "card_ra_draft_3rows"), false);
  assert.equal(시연대상인가(true, "card_reeval_july_carryover"), false);
  assert.equal(시연대상인가(true, "card_verify_9rows"), false);

  // 카드만 맞는 경우 — 플래그가 꺼져 있으면 평소 동작 그대로다.
  assert.equal(시연대상인가(false, DEMO_ISSUE_CARD_ID), false);
});

test("없는 값에 걸리지 않는다", () => {
  for (const 값 of [null, undefined, ""]) {
    assert.equal(시연대상인가(true, 값), false);
  }
});

test("불리언이 아닌 것으로 켜지지 않는다", () => {
  // `demo` 는 주소에서 오므로 문자열이 새어 들어올 수 있다. `"true"` 나 `1` 이
  // 켜진 것으로 읽히면 주소를 손으로 고쳐 시연 예외를 열 수 있게 된다.
  for (const 값 of ["true", "1", 1, {}, []]) {
    assert.equal(시연대상인가(값, DEMO_ISSUE_CARD_ID), false, String(값));
  }
});

test("대상 카드는 시드에 실재하는 카드다", async () => {
  // 상수가 오타이거나 시드에서 사라지면 시연이 조용히 죽는다 — 예외가 아무 카드에도
  // 안 걸려서 아무 일도 일어나지 않고, 그 사실을 알 방법이 없다.
  const { default: seed } = await import("../data/board/seed-items.json", { with: { type: "json" } });
  const 카드 = seed.items.find((item) => item.itemId === DEMO_ISSUE_CARD_ID);
  assert.ok(카드, `${DEMO_ISSUE_CARD_ID} 가 시드에 없다`);

  // 이슈 섹션이 요구하는 모양이어야 한다(`lib/board/risk-issue.ts` 의 `이슈카드인가`).
  assert.equal(카드.origin, "machine");
  assert.equal(카드.draft?.form, "회의록");
  assert.ok((카드.draft?.rows ?? []).length > 0);
  const 들어갈곳 = 카드.produces.find((p) => p.form === "회의록")?.into;
  assert.ok(들어갈곳, "회의록이 들어갈 문서가 없다");
  assert.ok(
    카드.invalidates.some((inv) => inv.docId === 들어갈곳),
    "자기가 무효화한 문서로 되돌아가는 초안이어야 한다",
  );
});
