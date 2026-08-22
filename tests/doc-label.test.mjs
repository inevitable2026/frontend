import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { 문서이름, 문서이름확정, 문서키툴팁, 문서표시 } from "../tmp/test-dist/lib/risk/doc-label.js";

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

test("접두사로 알 수 있는 종류는 그 종류로 부른다", () => {
  // 이 화면에 실제로 들어오는 docId 다 (data/board/seed-items.json).
  assert.equal(문서이름("tbm_20260818_pour"), "8월 18일 TBM 기록");
  assert.equal(문서이름("council_20260819"), "8월 19일 안전보건협의체 회의록");
  assert.equal(문서이름("nm_20260818_01"), "8월 18일 아차사고 보고");
  assert.equal(문서이름("notice_20260818_molab"), "8월 18일 공문");
  assert.equal(문서이름("rev_gamri"), "외부 검토 의견");
  assert.equal(문서이름("doc_2_k3f9x1qm"), "업로드한 문서");
});

test("종류를 모르면 종류를 지어내지 않는다", () => {
  // 예전에는 규칙에 안 맞는 키를 전부 "위험성평가 회의록" 이라 불렀다. 그러면
  // 업로드 문서와 TBM 기록이 위험성평가 회의록으로 둔갑한다.
  for (const 키 of ["zzz_9", "ra_something", "", null, undefined]) {
    const 이름 = 문서이름(키);
    assert.equal(이름, "문서");
    assert.equal(이름.includes("위험성평가"), false);
    if (키) assert.equal(이름.includes(키), false);
  }
});

test("저장용 이름은 확실할 때만 나온다", () => {
  // 화면은 총칭을 써도 되지만, 팩트에 적히면 다음에 읽는 사람에게 사실로 보인다.
  assert.equal(문서이름확정("ra_2026_08_regular"), "2026년 8월 정기 위험성평가 회의록");
  assert.equal(문서이름확정("tbm_20260818_pour"), "8월 18일 TBM 기록");
  assert.equal(문서이름확정("zzz_9"), null);
  assert.equal(문서이름확정(null), null);
});

test("표시는 「 」 로 감싸고 키는 title 로만 나간다", () => {
  assert.equal(문서표시("ra_2026_07_regular"), "「2026년 7월 정기 위험성평가 회의록」");
  assert.equal(문서키툴팁("ra_2026_07_regular"), "문서 키: ra_2026_07_regular");
  assert.equal(문서키툴팁(null), undefined);
});

test("재평가 카드가 새로 가리키는 문서 세 건도 사람 이름으로 읽힌다", () => {
  // 이행확인이 남아 있는 건을 만들려고 새로 넣은 문서다. 키 규칙에 걸리지 않으면
  // 서랍 제목이 총칭 "문서" 로 떨어져 어느 평가서를 여는지 알 수 없게 된다.
  assert.equal(문서이름("ra_2026_09_occasional"), "2026년 9월 수시 위험성평가 회의록");
  assert.equal(문서이름("ra_2026_08_monthly"), "2026년 8월 월례 위험성평가 회의록");
  assert.equal(문서이름("tbm_20260821_night"), "8월 21일 TBM 기록");
  // 저장용 이름도 나와야 한다. null 이면 팩트에 이름을 적지 못한다.
  assert.equal(문서이름확정("ra_2026_09_occasional"), "2026년 9월 수시 위험성평가 회의록");
  assert.equal(문서이름확정("tbm_20260821_night"), "8월 21일 TBM 기록");
});

test("시드 카드가 여는 문서는 하나도 총칭으로 떨어지지 않는다", () => {
  // 카드를 늘릴 때마다 손으로 시험을 늘리지 않아도 되도록 시드에서 직접 모은다.
  // 서랍이 여는 문서는 produces.into 가 먼저이고 없으면 invalidates 다
  // (components/risk/risk-doc-panel.tsx 의 `대상문서`).
  const 시드 = JSON.parse(readFileSync(path.resolve("data/board/seed-items.json"), "utf8"));
  const 문서들 = new Set();
  for (const 카드 of 시드.items) {
    for (const p of 카드.produces ?? []) if (p.into) 문서들.add(p.into);
    for (const v of 카드.invalidates ?? []) if (v.docId) 문서들.add(v.docId);
  }
  assert.ok(문서들.size > 0);
  for (const docId of 문서들) {
    assert.notEqual(문서이름확정(docId), null, `${docId} 를 사람 이름으로 읽지 못합니다`);
  }
});

test("시드의 결재 팩트는 모두 키가 아닌 이름을 들고 있다", () => {
  const seed = JSON.parse(readFileSync(path.resolve("data/board/seed-facts.json"), "utf8"));
  const 결재들 = seed.facts.filter((f) => f.factType === "documentApprovalState");
  assert.ok(결재들.length > 0);
  for (const f of 결재들) {
    assert.notEqual(f.value.문서, f.key, `${f.key} 의 문서 칸이 키 그대로입니다`);
  }
});
