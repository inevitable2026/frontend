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

// 합성 데모는 녹화 계약서의 이벤트를 빌려 쓴다. 그 판정이 딸려 나오면 화면이 자기가 읽어낸
// 현장명과 다른 현장을 확신 100% 로 단정하므로, 재생 단계에서 잘리는지를 못박아 둔다.
test("synthetic demo replays carry no borrowed site verdict", async () => {
  for (const kind of ["위험성평가표", "TBM회의록", "작업표준", "순회점검일지", "기타"]) {
    const events = [];
    for await (const event of replayDemo("job-2", kind, "local.pdf", 1234, async () => {})) events.push(event);
    const verdicts = events.filter((event) => event.종류 === "단계" && event.단계.이름 === "프로젝트판정");
    assert.ok(verdicts.length > 0, `${kind}: 프로젝트판정 단계 자체는 남아 있어야 한다`);
    for (const event of verdicts) {
      assert.equal(event.단계.산출, undefined, `${kind}: 남의 현장 판정이 실려 나왔다`);
    }
  }
});

test("recorded demo keeps its own site verdict", async () => {
  const events = [];
  for await (const event of replayDemo("job-3", "하도급계약서", "local.pdf", 1234, async () => {})) events.push(event);
  const done = events.filter((event) => event.종류 === "단계" && event.단계.이름 === "프로젝트판정" && event.단계.산출);
  assert.ok(done.length > 0);
  const verdict = done.at(-1).단계.산출;
  const extracted = events
    .filter((event) => event.종류 === "단계" && event.단계.이름 === "필드추출" && event.단계.산출)
    .at(-1).단계.산출;
  assert.equal(verdict.name, extracted.현장명);
});
