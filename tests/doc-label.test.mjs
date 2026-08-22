import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { 문서이름, 문서키툴팁, 문서표시 } from "../tmp/test-dist/lib/risk/doc-label.js";

test("저장된 문서 이름이 있으면 그것을 쓴다", () => {
  assert.equal(
    문서이름("ra_2026_08_regular", { 문서: "8월 정기 위험성평가 회의록", 상태: "결재대기", 제출가능: false }),
    "8월 정기 위험성평가 회의록",
  );
});

test("저장된 값이 키 그대로면 이름으로 쓰지 않는다", () => {
  // 새 결재 팩트를 만들 때 문서 칸에 키를 넣어 버린 적이 있다. 그걸 이름이라고 믿으면
  // 화면이 다시 ra_… 를 보여 준다.
  assert.equal(
    문서이름("ra_2026_08_regular", { 문서: "ra_2026_08_regular", 상태: "작성중", 제출가능: false }),
    "2026년 8월 정기 위험성평가 회의록",
  );
});

test("결재 기록이 없으면 키 규칙에서 이름을 만든다", () => {
  assert.equal(문서이름("ra_2026_07_regular"), "2026년 7월 정기 위험성평가 회의록");
  assert.equal(문서이름("ra_2026_08_monthly"), "2026년 8월 월례 위험성평가 회의록");
  assert.equal(문서이름("ra_20260819"), "8월 19일 위험성평가 회의록");
  assert.equal(문서이름("ra_draft_20260819"), "8월 19일 위험성평가 회의록 (초안)");
});

test("알 수 없는 키는 종류만 말하고 키를 노출하지 않는다", () => {
  for (const 키 of ["doc_2_k3f9x1qm", "ra_something", "", null, undefined]) {
    const 이름 = 문서이름(키);
    assert.equal(이름, "위험성평가 회의록");
    if (키) assert.equal(이름.includes(키), false);
  }
});

test("표시는 「 」 로 감싸고 키는 title 로만 나간다", () => {
  assert.equal(문서표시("ra_2026_07_regular"), "「2026년 7월 정기 위험성평가 회의록」");
  assert.equal(문서키툴팁("ra_2026_07_regular"), "문서 키: ra_2026_07_regular");
  assert.equal(문서키툴팁(null), undefined);
});

test("시드의 결재 팩트는 모두 키가 아닌 이름을 들고 있다", () => {
  const seed = JSON.parse(readFileSync(path.resolve("data/board/seed-facts.json"), "utf8"));
  const 결재들 = seed.facts.filter((f) => f.factType === "documentApprovalState");
  assert.ok(결재들.length > 0);
  for (const f of 결재들) {
    assert.notEqual(f.value.문서, f.key, `${f.key} 의 문서 칸이 키 그대로입니다`);
  }
});
