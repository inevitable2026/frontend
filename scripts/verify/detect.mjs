// 감지 엔진 동작 검증기.
//
// lib/detect 는 TypeScript 라 node 가 바로 못 읽는다. 그래서 이 스크립트가 직접
// `npx tsc` 로 임시 디렉터리에 CommonJS 로 컴파일하고, "@/..." 경로 별칭을 상대
// 경로로 바꾼 뒤 require 한다. 레포의 어떤 파일도 고치지 않는다.
//
//   node scripts/verify/detect.mjs
//
// 확인하는 것
//   1. 시드 사실로 규칙 여덟 개가 각각 발화하는가
//   2. 델타가 없을 때 발화하는 규칙이 있는가 (오탐)
//   3. 브리핑 숫자가 실제 데이터에서 세어지는가

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SITE = "site_gimpo_gochon_01";
const NOW = process.env.VERIFY_NOW ?? "2026-08-19T09:00:00+09:00";

/* ---------------------------------------------------------------- 컴파일 */

const work = mkdtempSync(path.join(tmpdir(), "verify-detect-"));
const outDir = path.join(work, "build");

const entries = [
  "lib/detect/rules/index.ts",
  "lib/detect/engine.ts",
  "lib/detect/delta.ts",
  "lib/board/briefing.ts",
  "lib/board/types.ts",
].map((rel) => path.join(ROOT, rel));

const tsconfig = path.join(work, "tsconfig.json");
writeFileSync(
  tsconfig,
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["esnext"],
        module: "commonjs",
        moduleResolution: "node",
        strict: false,
        skipLibCheck: true,
        noEmit: false,
        esModuleInterop: true,
        outDir,
        rootDir: ROOT,
        baseUrl: ROOT,
        paths: { "@/*": ["./*"] },
      },
      files: entries,
    },
    null,
    2,
  ),
);

execFileSync("npx", ["tsc", "-p", tsconfig], { cwd: ROOT, stdio: "inherit" });

// tsc 는 경로 별칭을 출력에 남긴다. node 가 읽을 수 있게 상대 경로로 바꾼다.
function rewriteAliases(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      rewriteAliases(full);
      continue;
    }
    if (!full.endsWith(".js")) continue;
    const before = readFileSync(full, "utf8");
    const after = before.replace(/require\("@\/([^"]*)"\)/g, (_m, rel) => {
      let r = path.relative(path.dirname(full), path.join(outDir, rel)).replace(/\\/g, "/");
      if (!r.startsWith(".")) r = `./${r}`;
      return `require("${r}")`;
    });
    if (after !== before) writeFileSync(full, after);
  }
}
rewriteAliases(outDir);

const req = createRequire(path.join(outDir, "noop.cjs"));
const { triggerRules } = req(path.join(outDir, "lib/detect/rules/index.js"));
const { computeDeltas, latestFacts } = req(path.join(outDir, "lib/detect/delta.js"));
const { runDetect, runRules } = req(path.join(outDir, "lib/detect/engine.js"));
const { buildBriefing } = req(path.join(outDir, "lib/board/briefing.js"));

/* ------------------------------------------------------------------ 시드 */

const seedRaw = JSON.parse(readFileSync(path.join(ROOT, "data/board/seed-facts.json"), "utf8"));
const facts = Array.isArray(seedRaw) ? seedRaw : (seedRaw.facts ?? []);

console.log(`시드 사실 ${facts.length}건 · 규칙 ${triggerRules.length}개 · now=${NOW}`);

/* ------------------------------------------------- 1. 여덟 규칙 발화 확인 */

const deltas = computeDeltas(facts, { siteId: SITE });
console.log(`\n[델타] ${deltas.length}건`);
for (const d of deltas) console.log(`  ${d.factType} :: ${d.key} @ ${d.observedAt}`);

const run = runDetect({ siteId: SITE, now: NOW, facts, rules: triggerRules });

const byRule = new Map();
for (const d of run.detections) {
  if (!byRule.has(d.ruleId)) byRule.set(d.ruleId, []);
  byRule.get(d.ruleId).push(d);
}

console.log(`\n[감지] ${run.detections.length}건 · 카드 ${run.created.length}장`);
for (const rule of triggerRules) {
  const hits = byRule.get(rule.id) ?? [];
  const mark = hits.length > 0 ? "발화" : "침묵";
  console.log(`  ${rule.id} ${rule.label} — ${mark} (${hits.length}건)`);
  for (const h of hits) {
    console.log(`      요약: ${h.summary}`);
    console.log(
      `      근거: ${h.evidence.map((e) => `${e.factType}:${e.key}`).join(", ") || "(없음)"}`,
    );
    console.log(
      `      produces: ${h.produces.map((p) => p.form).join(", ") || "(없음)"} · invalidates: ${h.invalidates.length}`,
    );
  }
}

const silent = triggerRules.filter((r) => !byRule.has(r.id)).map((r) => r.id);

/* ---------------------------------------------- 2. 델타 없을 때 오탐 확인 */

// 같은 자리의 최신 사실을 두 번 넣으면 before === after 라 델타가 서지 않는다.
const flat = latestFacts(facts.filter((f) => f.siteId === SITE));
const doubled = [...flat, ...flat.map((f) => ({ ...f }))];
const noDeltas = computeDeltas(doubled, { siteId: SITE });

const quiet = runRules({
  siteId: SITE,
  now: NOW,
  facts: doubled,
  deltas: noDeltas,
  rules: triggerRules,
});

console.log(`\n[오탐 검사] 계산된 델타 ${noDeltas.length}건 → 감지 ${quiet.length}건`);
for (const d of quiet) console.log(`  오탐? ${d.ruleId} — ${d.summary}`);

// 델타를 아예 비워 넘긴 경우도 본다.
const forced = runRules({ siteId: SITE, now: NOW, facts, deltas: [], rules: triggerRules });
console.log(`[오탐 검사·강제] deltas=[] → 감지 ${forced.length}건`);
for (const d of forced) console.log(`  오탐? ${d.ruleId} — ${d.summary}`);

/* ------------------------------------------------------- 3. 브리핑 숫자 */

const brief = buildBriefing({
  siteId: SITE,
  at: NOW,
  windowHours: 24,
  detections: run.detections,
  items: run.created,
});
console.log(
  `\n[브리핑] conditionCount=${brief.conditionCount} createdCount=${brief.createdCount} draftedCount=${brief.draftedCount} entries=${brief.entries.length}`,
);
console.log(
  `  실측: 창내감지=${run.detections.filter((d) => { const t = Date.parse(d.detectedAt); return t >= Date.parse(NOW) - 86400000 && t <= Date.parse(NOW); }).length} 창내카드=${run.created.filter((i) => { const t = Date.parse(i.createdAt); return t >= Date.parse(NOW) - 86400000 && t <= Date.parse(NOW); }).length} 초안붙은카드=${run.created.filter((i) => i.draft !== null).length}`,
);
for (const p of brief.paragraphs) console.log(`  | ${p}`);

// 합성 입력으로 숫자가 따라 움직이는지 본다. 박아 넣은 값이면 입력을 바꿔도 안 변한다.
function 합성감지(n) {
  return Array.from({ length: n }, (_, i) => ({
    ruleId: "T-01",
    siteId: SITE,
    detectedAt: "2026-08-19T08:00:00+09:00",
    confidence: 0.9,
    evidence: [],
    invalidates: [],
    produces: [],
    summary: `요약${i}`,
  }));
}
function 합성카드(n, 초안) {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `i${i}`,
    siteId: SITE,
    timing: "trigger",
    status: "todo",
    origin: "machine",
    title: `t${i}`,
    summary: null,
    trigger: {
      ruleId: "T-01",
      condition: `요약${i}`,
      sourceDocRefs: [],
      confidence: 0.9,
      requiresHumanConfirmation: true,
    },
    invalidates: [],
    produces: [],
    draft: 초안 ? { form: "기록", 제목: "x", 본문: "y" } : null,
    confirmedBy: null,
    confirmedAt: null,
    dueBy: null,
    estimatedMinutes: null,
    assignee: null,
    delegable: true,
    blockedBy: [],
    laneOrder: 0,
    createdAt: "2026-08-19T08:30:00+09:00",
    updatedAt: "2026-08-19T08:30:00+09:00",
  }));
}
let 브리핑고정 = false;
for (const [d, c, dr] of [
  [0, 0, false],
  [1, 1, false],
  [3, 7, true],
  [5, 2, false],
]) {
  const b = buildBriefing({ siteId: SITE, at: NOW, detections: 합성감지(d), items: 합성카드(c, dr) });
  const 맞음 = b.conditionCount === d && b.createdCount === c && b.draftedCount === (dr ? c : 0);
  if (!맞음) 브리핑고정 = true;
  console.log(
    `  합성 감지=${d} 카드=${c} 초안=${dr} → ${b.conditionCount}/${b.createdCount}/${b.draftedCount} ${맞음 ? "일치" : "불일치(값이 박혀 있음)"}`,
  );
}

/* --------------------------------------------------- 4. 카드 중복 확인 */

const 제목들 = run.created.map((i) => `${i.trigger?.ruleId}|${i.title}`);
const 중복 = [...new Set(제목들.filter((t, i) => 제목들.indexOf(t) !== i))];
console.log(`\n[카드 중복] ${run.created.length}장 중 같은 규칙·같은 제목이 겹친 것: ${중복.length}종`);
for (const t of 중복) console.log(`  ${t} × ${제목들.filter((x) => x === t).length}`);

/* ------------------------------------- 5. 침묵 원인 가리기 (규칙 vs 시드) */

// 규칙이 읽는 필드명과 시드가 쓰는 필드명이 다를 뿐인지, 조건 자체가 없는지를 가른다.
// 시드 파일은 고치지 않는다. 메모리 안의 사본에만 별칭을 붙여 본다.
function 사본() {
  return JSON.parse(JSON.stringify(facts));
}
function 발화규칙(f) {
  const r = runDetect({ siteId: SITE, now: NOW, facts: f, rules: triggerRules });
  return [...new Set(r.detections.map((d) => d.ruleId))].sort();
}

console.log("\n[원인 가리기]");
console.log(`  원본 시드 → ${발화규칙(사본()).join(", ")}`);

const a = 사본();
for (const f of a) {
  if (f.factType === "riskAssessmentRow" && f.value?.회의록) f.value.assessmentId = f.value.회의록;
}
console.log(`  riskAssessmentRow.value 에 assessmentId=회의록 별칭 → ${발화규칙(a).join(", ")}`);

const b2 = 사본();
for (const f of b2) {
  if (f.factType === "externalReviewComment" && Array.isArray(f.value?.지적대상행)) {
    f.value.대상행 = f.value.지적대상행;
  }
}
console.log(`  externalReviewComment.value 에 대상행=지적대상행 별칭 → ${발화규칙(b2).join(", ")}`);

const c2 = 사본();
for (const f of c2) {
  if (f.factType === "tbmMinutesFeedback") f.value.항목id = f.key.split("#")[1];
}
console.log(`  tbmMinutesFeedback.value 에 항목id=key 뒷부분 → ${발화규칙(c2).join(", ")}`);

const d2 = 사본();
for (const f of d2) {
  if (f.factType === "tbmMinutesFeedback") {
    f.value.항목id = f.key.split("#")[1];
    if (f.key === "tbm_pour#fb_1" && f.value.회차 === "2026-08-19") f.value.내용 = "야간 작업 구간 조도 확보";
  }
}
console.log(`  위 + 08-19 제기 문구를 점검 항목 문구와 일치시킴 → ${발화규칙(d2).join(", ")}`);

/* --------------------------------------------------------------- 판정 */

const ok = silent.length === 0 && quiet.length === 0 && forced.length === 0 && !브리핑고정;
console.log(`\n=== 결과: ${ok ? "PASS" : "FAIL"} ===`);
if (silent.length > 0) console.log(`침묵한 규칙: ${silent.join(", ")}`);
if (quiet.length > 0 || forced.length > 0) {
  console.log(`델타 없이 발화한 규칙: ${[...new Set([...quiet, ...forced].map((d) => d.ruleId))].join(", ")}`);
}
if (브리핑고정) console.log("브리핑 숫자가 입력을 따라가지 않습니다.");
process.exitCode = ok ? 0 : 1;
