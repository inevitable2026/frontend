import assert from "node:assert/strict";
import test from "node:test";
import { buildDbHealth } from "../scripts/studio-db-health.mjs";

/**
 * 이 스크립트의 값어치는 **실패할 때 실패하는 것**에 있다.
 *
 * 이것이 만드는 JSON 은 `studio-provision.mjs` 의 `normalizeDbHealth()` 로 들어가는데,
 * 그 함수는 `ready: true` 인지만 보고 그것이 사실인지는 확인하지 않는다. 즉 여기서
 * 관대해지면 게이트 전체가 관대해지고, 그 게이트가 열어 주는 것은 하도급 계약서 원본
 * 바이트를 다루는 경로다. 그래서 성공 경로 하나보다 실패 경로들을 못박는다.
 */

const 모든컬럼 = [
  "cleanup_status", "cleanup_deadline", "cleanup_attempts", "cleanup_error_code",
  "lease_owner", "lease_expires_at", "lease_fence", "state_version", "bytes_scrubbed_at",
  "studio_file_id", "studio_response_id", "studio_manifest_sha",
  "studio_agent_id", "studio_config_id", "studio_config_fingerprint", "studio_served_identity",
];

const NOW = Date.parse("2026-08-23T06:00:00.000Z");
const OWNER = "11111111-2222-3333-4444-555555555555";
const VERSION = "studio-cleanup-control-v1";

function 건강행(덮어쓰기 = {}) {
  return {
    last_success_at: new Date(NOW - 60_000).toISOString(),
    last_owner: OWNER,
    last_result: { stale: 0, claimed: 0, cleaned: 0, failed: 0 },
    recovery_policy: "cleanup-only-v1",
    state_version: "35",
    ...덮어쓰기,
  };
}

test("컬럼이 하나라도 없으면 이름을 대고 실패한다", async () => {
  const 빠짐 = 모든컬럼.filter((name) => name !== "bytes_scrubbed_at");
  const outcome = await buildDbHealth({ columns: 빠짐, health: 건강행(), migrationVersion: VERSION, now: NOW, owner: OWNER });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /bytes_scrubbed_at/);
  assert.equal(outcome.proof, undefined);
});

test("버전 프로브가 없으면 이름을 지어내지 않고 실패한다", async () => {
  // 예전에는 이 자리에 "studio-cleanup-control-v1" 을 상수로 적어 두었다. 그러면 컬럼만
  // 있으면 어떤 DB 에서든 그 이름이 찍혀 나가는데, 그건 관측이 아니라 우리가 믿고 싶은
  // 값이다. 함수가 없으면 마이그레이션이 적용되지 않은 것이고, 그러면 증명이 없다.
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: 건강행(), migrationVersion: null, now: NOW, owner: OWNER });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /studio_cleanup_migration_version/);
  assert.equal(outcome.proof, undefined);
});

test("DB 가 말한 버전을 그대로 싣는다 — 우리가 고쳐 적지 않는다", async () => {
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: 건강행(), migrationVersion: "studio-cleanup-control-v2", now: NOW, owner: OWNER });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.proof.cleanupMigrationVersion, "studio-cleanup-control-v2");
  // 이 값이 `STUDIO_REQUIRED_CLEANUP_MIGRATION` 과 다르면 게이트가 거절한다
  // (`live-readiness.ts:320-325`). 여기서 맞춰 주지 않는 것이 요점이다.
});

test("회수 정책 표식이 없으면 남의 하트비트로 보고 거절한다", async () => {
  // `last_owner` 로는 못 가른다 — 공유 DB 의 정체불명 회수기가 매 사이클 새 uuid 를 쓴다.
  const 표식없음 = 건강행({ recovery_policy: null });
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: 표식없음, migrationVersion: VERSION, now: NOW, owner: OWNER });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /회수 정책 표식이 없습니다/);
});

test("회수기가 한 번도 돌지 않았으면 실패한다", async () => {
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: null, migrationVersion: VERSION, now: NOW, owner: OWNER });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /한 번도 돌지 않았습니다/);
});

test("남이 찍은 하트비트를 우리 것이라 서명하지 않는다", async () => {
  // 공유 DB 에는 출처를 알 수 없는 회수기가 하나 더 돈다. 행이 신선하다는 것만으로는
  // 우리 정책(cleanup-only-v1)이 돌았다는 뜻이 되지 않는다.
  const 남 = 건강행({ last_owner: "99999999-0000-0000-0000-000000000000" });
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: 남, migrationVersion: VERSION, now: NOW, owner: OWNER });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /우리 것이 아닙니다/);
});

test("owner 를 안 넘기면 대조를 건너뛰지 않고 실패한다", async () => {
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: 건강행(), migrationVersion: VERSION, now: NOW, owner: undefined });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /대조할 수 없습니다/);
});

test("하트비트가 오래되면 실패한다", async () => {
  const 낡음 = 건강행({ last_success_at: new Date(NOW - 16 * 60_000).toISOString() });
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: 낡음, migrationVersion: VERSION, now: NOW, owner: OWNER });

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /이내여야 합니다/);
});

test("전부 관측되면 normalizeDbHealth 가 받는 네 필드만 낸다", async () => {
  const outcome = await buildDbHealth({ columns: 모든컬럼, health: 건강행(), migrationVersion: VERSION, now: NOW, owner: OWNER });

  assert.equal(outcome.ok, true);
  // `normalizeDbHealth` 는 exactRecord 라 필드가 하나라도 더 붙으면 거절한다.
  assert.deepEqual(Object.keys(outcome.proof).sort(), ["checkedAt", "cleanupMigrationVersion", "ready", "recoveryPolicy"].sort());
  assert.equal(outcome.proof.ready, true);
  assert.equal(outcome.proof.recoveryPolicy, "cleanup-only-v1");
  // 상수가 아니라 DB 가 말한 값이 그대로 실려야 한다.
  assert.equal(outcome.proof.cleanupMigrationVersion, VERSION);
  // checkedAt 은 지금이 아니라 **관측된 하트비트 시각**이어야 한다. 지금으로 적으면
  // 신선도 검사가 언제나 통과해 버려서 검사가 사라진다.
  assert.equal(outcome.proof.checkedAt, new Date(NOW - 60_000).toISOString());
});
