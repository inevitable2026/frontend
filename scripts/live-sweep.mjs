#!/usr/bin/env node
/**
 * 버려진 문서 적재 잡을 회수한다 — 손으로 한 번 돌릴 때 쓴다.
 *
 *   npm run live:sweep -- --dry-run     무엇이 걸리는지만 센다
 *   npm run live:sweep                  실제로 회수한다
 *
 * 실제 로직은 `lib/context/sweeper.ts` 에 있고 `app/api/context/sweep` 라우트가 그것을
 * 부른다. 여기서 DB 에 직접 붙지 않는 이유는, 회수기가 앱과 **같은 연결·같은 코드**로
 * 돌아야 하기 때문이다. 스크립트가 자기만의 경로를 따로 가지면 그 경로만 어긋난다.
 *
 * 프로덕션에서는 사람이 아니라 크론이 이 라우트를 부른다(`vercel.json`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const options = { baseUrl: process.env.BASE ?? "http://localhost:3000", dryRun: false, limit: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--base-url") options.baseUrl = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run live:sweep -- [--dry-run] [--limit 25] [--base-url http://localhost:3000]");
    return;
  }

  const match = readFileSync(".env.local", "utf8").match(/^SWEEPER_TOKEN=(.*)$/m);
  const token = match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
  if (!token) throw new Error("SWEEPER_TOKEN 이 .env.local 에 없습니다.");

  const url = new URL("/api/context/sweep", options.baseUrl);
  if (options.dryRun) url.searchParams.set("dryRun", "true");
  if (options.limit) url.searchParams.set("limit", String(options.limit));

  const response = await fetch(url, { method: "POST", headers: { "x-sweeper-token": token } });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error ?? "알 수 없는 실패"}`);

  // 지어내지 않는다. 라우트가 준 실측치를 그대로 옮긴다.
  console.log(JSON.stringify(body, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`회수에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
