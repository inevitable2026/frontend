import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const chunkModule = new URL("../tmp/test-dist/lib/context/chunk.js", import.meta.url).href;
const { chunkElements } = await import(chunkModule);

test("makes progress when a chunk boundary is at the start of the buffer", () => {
  const source = `import(${JSON.stringify(chunkModule)}).then(({ chunkElements }) => {
    chunkElements([{ id: 1, page: 1, category: "paragraph", content: { text: ". ${"x".repeat(900)}" } }]);
  });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 250,
  });

  assert.equal(result.signal, null, `chunking timed out: ${result.error?.message ?? result.stderr}`);
  assert.equal(result.status, 0, result.stderr);
});

test("retains the most recent heading in body chunks", () => {
  const chunks = chunkElements([
    { id: 1, page: 1, category: "heading1", content: { text: "# 작업 전 점검" } },
    { id: 2, page: 1, category: "paragraph", content: { text: "안전모와 안전화를 확인한다." } },
  ]);

  assert.deepEqual(chunks.map((chunk) => chunk.text), ["작업 전 점검\n안전모와 안전화를 확인한다."]);
});
