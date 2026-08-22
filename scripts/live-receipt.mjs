#!/usr/bin/env node
/**
 * 라이브 적재 영수증을 **다시 발급한다.**
 *
 * **왜 다시 발급해야 하는가.** 영수증에는 두 개의 시계가 달려 있다 —
 * 전체 유효기간 1시간, 그리고 **회수기 하트비트 15분**
 * (`lib/context/live-readiness.ts:326-337`). 발급해 두고 몇 시간 뒤에 시연하면
 * 라이브가 다시 막힌다. 이건 결함이 아니라 설계다: "정리기가 지금 살아 있다" 는 주장은
 * 오래 유지될 수 없는 종류의 주장이다.
 *
 * 그래서 데모 직전에 이 한 줄을 돌린다:
 *
 *   npm run live:receipt
 *
 * 무엇을 하는가 — **순서가 곧 증명 사슬이다**:
 *
 *   1. 회수기를 실제로 돌린다 → 응답에서 `owner` 를 받는다
 *   2. `studio-db-health.mjs --owner` 로 그 회수기가 찍은 하트비트를 확인한다
 *   3. 그 증명으로 영수증을 발급한다
 *   4. `.env.local` 의 `STUDIO_LIVE_READINESS_RECEIPT_JSON` 을 덮는다
 *
 * 1→2 를 붙여 두는 것이 요점이다. 떼어 놓으면 남이 4분 뒤에 찍은 하트비트로 서명하게 된다.
 *
 * **이미 있어야 하는 것** (한 번만 만들면 되고, 유효기간이 없다):
 *   `.studio-provision/pins.json` · `scope.json` · `evidence.json` · `smoke.json`
 * 없으면 무엇이 없는지 이름을 대고 멈춘다. 이 스크립트는 Upstage 에 새 자원을 만들지
 * 않는다 — 그건 `studio-provision.mjs --apply`/`spike`/`smoke` 의 일이다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = ".studio-provision";
const NEEDED = {
  "pins.json": "node scripts/studio-provision.mjs --apply",
  "scope.json": "node scripts/studio-provision.mjs scope --receipt .studio-provision/scope.json",
  "evidence.json": "node scripts/studio-provision.mjs evidence --official-docs … --spike …",
  "smoke.json": "node scripts/studio-provision.mjs smoke --pdf … --receipt .studio-provision/smoke.json",
};

export function parseArgs(argv) {
  const options = { baseUrl: process.env.BASE ?? "http://localhost:3000", write: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") options.baseUrl = argv[++index];
    else if (arg === "--no-write") options.write = false;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function env(name) {
  const line = readFileSync(".env.local", "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  return line ? line[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** `.env.local` 의 한 줄만 갈아 끼운다. 나머지 줄은 손대지 않는다. */
export function replaceEnvLine(text, key, value) {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
    return lines.join("\n");
  }
  return `${text.replace(/\n*$/, "\n")}${key}=${value}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run live:receipt -- [--base-url http://localhost:3000] [--no-write]");
    return;
  }

  const missing = Object.keys(NEEDED).filter((name) => !existsSync(`${DIR}/${name}`));
  if (missing.length > 0) {
    console.error(`영수증을 발급하지 못했습니다. 먼저 만들어야 하는 증명이 없습니다:`);
    for (const name of missing) console.error(`  ${DIR}/${name}  ←  ${NEEDED[name]}`);
    process.exitCode = 1;
    return;
  }

  const token = env("SWEEPER_TOKEN");
  if (!token) {
    console.error("SWEEPER_TOKEN 이 .env.local 에 없습니다. 회수기를 부를 수 없습니다.");
    process.exitCode = 1;
    return;
  }

  // ① 회수기를 실제로 돌린다. 서버가 떠 있어야 한다 — 라우트가 앱의 DB 연결을 쓴다.
  const response = await fetch(new URL("/api/context/sweep", options.baseUrl), {
    method: "POST",
    headers: { "x-sweeper-token": token },
  });
  if (!response.ok) {
    console.error(`회수기 호출이 실패했습니다 (HTTP ${response.status}). 개발 서버가 떠 있는지 확인하세요: ${options.baseUrl}`);
    process.exitCode = 1;
    return;
  }
  const swept = await response.json();
  console.error(`회수: 대상 ${swept.stale} · 잡음 ${swept.claimed} · 지움 ${swept.cleaned} · 실패 ${swept.failed}`);

  // ② 그 회수기가 찍은 하트비트인지 대조해서 증명을 만든다.
  const health = execFileSync("node", ["scripts/studio-db-health.mjs", "--owner", swept.owner], { encoding: "utf8" });
  writeFileSync(`${DIR}/db-health.json`, health);

  // ③ 영수증 발급.
  execFileSync("node", [
    "scripts/studio-provision.mjs", "readiness",
    "--smoke", `${DIR}/smoke.json`,
    "--db-health", `${DIR}/db-health.json`,
    "--credential-scope", `${DIR}/scope.json`,
    "--config-pin-evidence", `${DIR}/evidence.json`,
    "--receipt", `${DIR}/readiness.json`,
  ], { encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });

  const receipt = JSON.parse(readFileSync(`${DIR}/readiness.json`, "utf8"));
  const oneLine = JSON.stringify(receipt);
  if (oneLine.includes("'")) throw new Error("영수증에 작은따옴표가 있어 .env.local 인용이 깨집니다.");

  if (options.write) {
    // ④ .env.local 을 덮는다. 이 파일은 gitignore 된다 — 영수증에는 키 지문과 config id 가 있다.
    let text = readFileSync(".env.local", "utf8");
    text = replaceEnvLine(text, "STUDIO_LIVE_READINESS_RECEIPT_JSON", `'${oneLine}'`);
    text = replaceEnvLine(text, "STUDIO_LIVE_INGEST_ENABLED", "true");
    text = replaceEnvLine(text, "STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED", "true");
    text = replaceEnvLine(text, "STUDIO_REQUIRED_CLEANUP_MIGRATION", receipt.cleanupMigrationVersion);
    writeFileSync(".env.local", text);
  }

  // 영수증 본문은 찍지 않는다. 유효 시각만 알린다 — 언제까지 쓸 수 있는지가 필요한 전부다.
  console.log(JSON.stringify({
    scope: receipt.scope,
    expiresAt: receipt.expiresAt,
    sweeperCheckedAt: receipt.sweeper.checkedAt,
    cleanupMigrationVersion: receipt.cleanupMigrationVersion,
    workflows: Object.keys(receipt.workflows).length,
    wroteEnvLocal: options.write,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`영수증 재발급에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
