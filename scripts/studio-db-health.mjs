#!/usr/bin/env node
/**
 * 라이브 게이트가 요구하는 DB 정리 증명을 **관측해서** 만든다.
 *
 * `scripts/studio-provision.mjs` 의 `readiness` 는 `--db-health` JSON 을 그대로 받는다.
 * 그 파일 안의 `normalizeDbHealth()` 는 **형식만** 본다 — `ready: true` 라고 적혀 있으면
 * 그것이 사실인지 확인하지 않는다. 그 자리에 사람이 손으로 `true` 를 적으면 게이트는
 * 열리고, 그 게이트가 열어 주는 것은 **하도급 계약서 원본 바이트를 다루는 경로**다.
 *
 * 그래서 그 JSON 을 사람이 쓰지 못하게 한다. 이 스크립트가 관측한 것만 적고, 관측되지
 * 않으면 **무엇이 없는지 이름을 대고 실패한다.** 추측해서 채우지 않는다.
 *
 * 무엇을 관측하는가:
 *
 *   1. `ingest_jobs` 에 정리 제어 컬럼이 전부 있는가
 *      (`docs/tbm-check-studio-cleanup-contract.md:14-19` 가 요구한 것들)
 *   2. `studio_sweeper_health` 의 하트비트가 신선한가 (기본 15분 — 영수증 검사와 같은 창)
 *   3. **그 하트비트를 우리 회수기가 찍었는가** — `--owner` 로 넘긴 값과 대조한다.
 *      이 대조가 핵심이다. 공유 DB 에는 출처를 알 수 없는 회수기가 하나 더 돌고 있어서,
 *      행이 신선하다는 것만으로는 우리 정책이 돌았다는 뜻이 되지 않는다.
 *
 * 쓰는 법:
 *
 *   OWNER=$(curl -s -X POST -H "x-sweeper-token: $SWEEPER_TOKEN" \
 *     "http://localhost:3000/api/context/sweep" | jq -r .owner)
 *   node scripts/studio-db-health.mjs --owner "$OWNER" > .studio-provision/db-health.json
 *
 * DATABASE_URL 은 레포 루트의 .env.local 에서 읽는다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/** 계약(`docs/tbm-check-studio-cleanup-contract.md:14-19`)이 요구한 정리 제어 컬럼. */
const REQUIRED_COLUMNS = [
  "cleanup_status",
  "cleanup_deadline",
  "cleanup_attempts",
  "cleanup_error_code",
  "lease_owner",
  "lease_expires_at",
  "lease_fence",
  "state_version",
  "bytes_scrubbed_at",
  "studio_file_id",
  "studio_response_id",
  "studio_manifest_sha",
  "studio_agent_id",
  "studio_config_id",
  "studio_config_fingerprint",
  "studio_served_identity",
];

const RECOVERY_POLICY = "cleanup-only-v1";
const DEFAULT_FRESHNESS_MS = 15 * 60_000;

function fail(message) {
  console.error(`db-health 증명을 만들지 못했습니다: ${message}`);
  process.exitCode = 1;
  return null;
}

export function parseArgs(argv) {
  const options = { owner: undefined, freshnessMs: DEFAULT_FRESHNESS_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--owner") options.owner = argv[++index];
    else if (arg === "--freshness-ms") options.freshnessMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    const match = env.match(/^DATABASE_URL=(.*)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    // .env.local 이 없을 수 있다. 아래에서 이름을 대고 실패한다.
  }
  return null;
}

/**
 * 관측 결과를 그대로 담은 증명을 만든다. 관측되지 않으면 `null` 을 준다.
 *
 * DB 접근을 매개변수로 받는다 — 시험이 실제 Postgres 없이 각 실패 경로를 밟을 수 있어야
 * 한다. 이 스크립트의 값어치는 **실패할 때 실패하는 것**에 있으므로 그 경로가 시험된다.
 */
export async function buildDbHealth({
  columns,
  health,
  migrationVersion,
  now,
  owner,
  freshnessMs = DEFAULT_FRESHNESS_MS,
}) {
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    return { ok: false, reason: `ingest_jobs 에 정리 제어 컬럼이 없습니다: ${missing.join(", ")}` };
  }
  /*
   * 마이그레이션 버전은 **DB 가 말하게 한다.**
   *
   * `studio_cleanup_migration_version()` 함수가 그 값을 돌려준다. 함수 본문은 DDL 로만
   * 바뀌므로 **함수가 있다 = 마이그레이션이 적용됐다** 가 같은 사실이 된다. 표의 행으로
   * 두면 seed 를 빠뜨리거나 UPDATE 한 줄이 흘러도 조용히 갈라진다.
   *
   * 그래서 여기서 이름을 상수로 적어 두지 않는다. 적어 두면 그 순간부터 그것은 관측이
   * 아니라 우리가 믿고 싶은 값이 된다.
   */
  if (!migrationVersion) {
    return {
      ok: false,
      reason:
        "studio_cleanup_migration_version() 이 없습니다. 정리 마이그레이션(0006)이 이 DB 에 적용되지 않았습니다.",
    };
  }
  if (!health) {
    return { ok: false, reason: "studio_sweeper_health 에 행이 없습니다. 회수기가 한 번도 돌지 않았습니다." };
  }
  /*
   * **누가 찍은 하트비트인가.**
   *
   * `last_owner` 만으로는 못 가른다 — 공유 DB 에서 도는 출처 불명의 회수기가 매 사이클
   * 새 uuid 를 쓴다. 그래서 두 가지를 함께 본다:
   *
   *   ① `recovery_policy` 가 우리 표식인가 — 우리 구현만 이 칸을 쓴다
   *   ② `last_owner` 가 방금 우리가 돌린 그 회수기인가 — 우리 uuid 는 남이 못 만든다
   *
   * ①만 보면 우리가 어제 찍은 것으로도 통과하고, ②만 보면 남이 4분 뒤에 덮어써도
   * 모른다. 둘을 함께 봐야 "우리 정책이 방금 돌았다" 가 된다.
   */
  if (health.recovery_policy !== RECOVERY_POLICY) {
    return {
      ok: false,
      reason:
        `하트비트에 회수 정책 표식이 없습니다 (기대 ${RECOVERY_POLICY}, 실제 ${health.recovery_policy ?? "없음"}). ` +
        "이 레포의 회수기가 아니라 다른 것이 마지막으로 썼습니다.",
    };
  }
  if (!owner) {
    return { ok: false, reason: "--owner 가 없습니다. 어느 회수기가 찍은 하트비트인지 대조할 수 없습니다." };
  }
  if (health.last_owner !== owner) {
    return {
      ok: false,
      reason:
        `하트비트를 찍은 회수기가 우리 것이 아닙니다 (기대 ${owner}, 실제 ${health.last_owner ?? "없음"}). ` +
        "회수기를 먼저 돌리고 그 응답의 owner 를 넘기세요.",
    };
  }
  const checkedAtMs = Date.parse(health.last_success_at);
  if (!Number.isFinite(checkedAtMs)) {
    return { ok: false, reason: "studio_sweeper_health.last_success_at 을 읽지 못했습니다." };
  }
  const age = now - checkedAtMs;
  if (age > freshnessMs) {
    return { ok: false, reason: `회수기 하트비트가 ${Math.round(age / 1000)}초 전입니다. ${Math.round(freshnessMs / 1000)}초 이내여야 합니다.` };
  }
  return {
    ok: true,
    // `normalizeDbHealth()` 가 받는 정확히 네 필드. 더 넣으면 exactRecord 검사에서 거절된다.
    proof: {
      ready: true,
      recoveryPolicy: RECOVERY_POLICY,
      cleanupMigrationVersion: migrationVersion,
      checkedAt: new Date(checkedAtMs).toISOString(),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/studio-db-health.mjs --owner <sweep-owner-uuid> [--freshness-ms 900000]");
    return;
  }
  const url = databaseUrl();
  if (!url) return fail("DATABASE_URL 이 없습니다. .env.local 에 넣으세요.");

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const columnRows = await sql`
      select column_name from information_schema.columns where table_name = 'ingest_jobs'
    `;
    const healthColumns = await sql`
      select column_name from information_schema.columns where table_name = 'studio_sweeper_health'
    `;
    const hasPolicy = healthColumns.some((row) => row.column_name === "recovery_policy");
    const healthRows = hasPolicy
      ? await sql`
          select last_success_at, last_owner, last_result, recovery_policy, state_version
            from studio_sweeper_health order by id limit 1
        `
      : await sql`
          select last_success_at, last_owner, last_result, null::text as recovery_policy, state_version
            from studio_sweeper_health order by id limit 1
        `;

    // 함수가 없으면 예외가 난다 — 그것이 곧 "마이그레이션 미적용" 이라는 관측이다.
    let migrationVersion = null;
    try {
      const [probe] = await sql`select studio_cleanup_migration_version() as version`;
      migrationVersion = probe?.version ?? null;
    } catch {
      migrationVersion = null;
    }

    const outcome = await buildDbHealth({
      columns: columnRows.map((row) => row.column_name),
      health: healthRows[0] ?? null,
      migrationVersion,
      now: Date.now(),
      owner: options.owner,
      freshnessMs: options.freshnessMs,
    });
    if (!outcome.ok) return fail(outcome.reason);
    // 표준출력에는 증명만 나간다. 리다이렉트해서 파일로 받는다.
    console.log(JSON.stringify(outcome.proof, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
