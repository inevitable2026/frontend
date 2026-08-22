import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  미확인행,
  불일치행,
  위험도표시,
  이행상태읽기,
  최신만,
  행정렬,
  회사표시,
} from "../tmp/test-dist/lib/risk/rows.js";

/**
 * 여기 있는 시험은 전부 **실제로 한 번씩 틀렸던 것**이다. 지어낸 경우를 늘리지 않고,
 * 화면에서 잘못 나왔던 값을 그대로 고정한다.
 *
 * 시드를 픽스처로 쓴다. 손으로 쓴 가짜 행으로는 오늘 겪은 두 가지를 못 잡는다 —
 * 이행확인이 문자열 "불일치" 로 들어 있는 행과, 같은 key 가 두 번 기록된 이력.
 */
const 시드 = JSON.parse(
  readFileSync(path.join(process.cwd(), "data/board/seed-facts.json"), "utf8"),
);
const 팔월 = 시드.facts.filter(
  (f) => f.factType === "riskAssessmentRow" && f.key.startsWith("ra_2026_08_regular#"),
);

test("이행확인은 상태가 셋이고 \"불일치\" 는 확인이 아니다", () => {
  const 행 = (이행확인) => ({ 회의록: "d", 행id: "1", 단위작업: "a", 이행확인 });
  assert.equal(이행상태읽기(행(true)), "확인");
  assert.equal(이행상태읽기(행(undefined)), "빈칸");
  assert.equal(이행상태읽기(행(false)), "빈칸");
  // `!"불일치"` 가 false 라 이 행이 "확인 완료" 로 세어졌다. 위조로 판정된 행이
  // 화면에서 사라지던 자리다.
  assert.equal(이행상태읽기(행("불일치")), "불일치");
});

test("미확인행은 빈칸과 불일치를 함께 담는다", () => {
  const 행들 = [
    { 회의록: "d", 행id: "A", 단위작업: "a", 이행확인: true },
    { 회의록: "d", 행id: "B", 단위작업: "b" },
    { 회의록: "d", 행id: "C", 단위작업: "c", 이행확인: "불일치" },
  ];
  assert.deepEqual(미확인행(행들).map((r) => r.행id), ["B", "C"]);
  assert.deepEqual(불일치행(행들).map((r) => r.행id), ["C"]);
});

test("시드의 8월 회의록은 접으면 21행이고 확인 안 된 행이 10행이다", () => {
  const 행들 = 행정렬(최신만(팔월));

  // 접기 전 23건 → 접은 뒤 21행. RI-04·RI-11 이 이력 두 벌이다.
  assert.equal(팔월.length, 23);
  assert.equal(행들.length, 21);

  // 카드는 "이행확인이 비어 있는 행이 9건" 이라고 말한다. 거기에 위조 판정 1행을
  // 더한 10행이 "확인 안 된 행" 이다. 예전 화면은 9도 10도 아닌 12/21 을 적었다.
  assert.equal(불일치행(행들).length, 1);
  assert.equal(미확인행(행들).length, 10);
  assert.equal(미확인행(행들).length - 불일치행(행들).length, 9);
});

test("위조로 판정된 행은 RI-04 이고 표시와 실제가 어긋나 있다", () => {
  const [위조] = 불일치행(행정렬(최신만(팔월)));
  assert.equal(위조.행id, "RI-04");
  assert.equal(위조.표시값, true);
  assert.equal(위조.실제실행, false);
  // 근거가 있어야 위조라고 말할 수 있다. 없으면 그냥 주장이다.
  assert.equal(위조.근거, "nm_20260818_01");
});

test("최신만은 같은 key 를 나중 것으로 접는다", () => {
  const 접힘 = 최신만([
    { key: "k", observedAt: "2026-08-01T00:00:00+09:00", 값: "이전" },
    { key: "k", observedAt: "2026-08-19T00:00:00+09:00", 값: "나중" },
    { key: "다른", observedAt: "2026-08-01T00:00:00+09:00", 값: "그대로" },
  ]);
  assert.equal(접힘.length, 2);
  assert.equal(접힘.find((f) => f.key === "k").값, "나중");
});

test("행정렬은 행id 가 없는 팩트를 버리고 숫자 순으로 세운다", () => {
  // ra_2026_07_regular#전제 처럼 행이 아닌 팩트가 섞여 있다. 그대로 두면
  // 화면이 "행" 이라고 부르며 빈 칸을 그린다.
  const 세운것 = 행정렬([
    { value: { 회의록: "d", 행id: "RI-10", 단위작업: "십" } },
    { value: { 회의록: "d", 단위작업: "전제라 행id 가 없다" } },
    { value: { 회의록: "d", 행id: "RI-02", 단위작업: "이" } },
  ]);
  assert.deepEqual(세운것.map((r) => r.행id), ["RI-02", "RI-10"]);
});

test("위험도는 등급을 지어내지 않고 빈도 × 강도 를 그대로 보인다", () => {
  // 팩트에 매트릭스가 없고 시나리오가 4×3 과 5×4 를 섞어 쓴다. 같은 12 가 행마다
  // 등급이 달라서, 화면이 "높음" 이라고 단정하면 거짓말이 된다.
  assert.equal(위험도표시({ 빈도: 3, 강도: 4, 위험도: 12 }), "빈도 3 × 강도 4 = 12");
  assert.equal(위험도표시(undefined), "미기재");
});

test("회사 코드는 이름으로 바뀌고 모르는 코드는 코드 그대로 남는다", () => {
  assert.equal(회사표시("sub_seojin"), "서진건설");
  assert.equal(회사표시(undefined), "미지정");
  // 지어내지 않는다. 모르면 코드가 보이는 편이 낫다.
  assert.equal(회사표시("sub_unknown"), "sub_unknown");
});
