#!/usr/bin/env node
// 더미 문서 세트 빌드.
//
//   node scripts/make-docs/build.mjs                모든 문서를 HTML 과 PDF 로 뽑는다
//   node scripts/make-docs/build.mjs --html-only    PDF 변환을 건너뛴다
//   node scripts/make-docs/build.mjs --only tbm     id 에 문자열이 포함된 문서만 만든다
//   node scripts/make-docs/build.mjs --out <디렉터리> 산출 위치를 바꾼다
//   node scripts/make-docs/build.mjs --list         목록만 찍는다
//
// 의존성 없음. Node 표준 라이브러리와 시스템 Chrome 만 쓴다.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { 문서목록 } from "./documents/index.mjs";
import { 크롬찾기, htmlToPdf } from "./lib/pdf.mjs";

const 여기 = path.dirname(fileURLToPath(import.meta.url));

function 인자파싱(argv) {
  const o = { htmlOnly: false, only: null, out: path.join(여기, "out"), list: false, clean: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--html-only") o.htmlOnly = true;
    else if (a === "--list") o.list = true;
    else if (a === "--clean") o.clean = true;
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "-h" || a === "--help") o.help = true;
    else {
      console.error(`알 수 없는 인자: ${a}`);
      process.exit(2);
    }
  }
  return o;
}

const opt = 인자파싱(process.argv.slice(2));

if (opt.help) {
  console.log(`사용법: node scripts/make-docs/build.mjs [옵션]

  --html-only     PDF 변환을 건너뛰고 HTML 까지만 만든다
  --only <문자열>  id 에 그 문자열이 들어간 문서만 만든다
  --out <디렉터리> 산출 위치 (기본: scripts/make-docs/out)
  --list          문서 목록만 찍는다
  --clean         산출 디렉터리를 먼저 비운다
`);
  process.exit(0);
}

const 대상 = opt.only ? 문서목록.filter((d) => d.id.includes(opt.only)) : 문서목록;

if (opt.list) {
  console.log(`문서 ${문서목록.length}건\n`);
  for (const d of 문서목록) {
    console.log(`  ${d.id.padEnd(26)} ${d.kind.padEnd(10)} ${d.먹이는조건.join(",").padEnd(22)} ${d.파일명}`);
  }
  process.exit(0);
}

if (대상.length === 0) {
  console.error(`--only ${opt.only} 에 걸리는 문서가 없다.`);
  process.exit(1);
}

const htmlDir = path.join(opt.out, "html");
const pdfDir = path.join(opt.out, "pdf");

if (opt.clean) rmSync(opt.out, { recursive: true, force: true });
mkdirSync(htmlDir, { recursive: true });
if (!opt.htmlOnly) mkdirSync(pdfDir, { recursive: true });

const 크롬 = opt.htmlOnly ? null : 크롬찾기();
if (!opt.htmlOnly && !크롬) {
  console.error(
    "PDF 변환에 쓸 Chrome 을 찾지 못했다. HTML 까지만 만들려면 --html-only 를 붙여라.\n" +
      "CHROME_PATH 환경변수로 경로를 직접 줄 수도 있다.",
  );
  process.exit(1);
}

console.log(`문서 ${대상.length}건`);
console.log(`산출 ${opt.out}`);
if (크롬) console.log(`크롬 ${크롬}\n`);
else console.log("");

const 결과 = [];
let 실패 = 0;

for (const d of 대상) {
  const htmlPath = path.join(htmlDir, `${d.파일명}.html`);
  let html;
  try {
    html = d.html();
  } catch (e) {
    console.log(`  ✗ ${d.id.padEnd(26)} 렌더 실패: ${e.message}`);
    실패++;
    continue;
  }
  writeFileSync(htmlPath, html, "utf8");

  if (opt.htmlOnly) {
    결과.push({ id: d.id, html: htmlPath, pdf: null, bytes: Buffer.byteLength(html) });
    console.log(`  · ${d.id.padEnd(26)} html ${String(Buffer.byteLength(html)).padStart(7)}B`);
    continue;
  }

  const pdfPath = path.join(pdfDir, `${d.파일명}.pdf`);
  const r = htmlToPdf(크롬, htmlPath, pdfPath);
  if (!r.ok) {
    console.log(`  ✗ ${d.id.padEnd(26)} PDF 실패: ${r.사유}`);
    실패++;
    continue;
  }
  결과.push({ id: d.id, html: htmlPath, pdf: pdfPath, bytes: r.bytes });
  console.log(`  ✓ ${d.id.padEnd(26)} pdf  ${String(r.bytes).padStart(7)}B`);
}

console.log(`\n성공 ${결과.length}건 · 실패 ${실패}건`);
if (실패 > 0) process.exit(1);
