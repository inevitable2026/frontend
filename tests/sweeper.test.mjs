import assert from "node:assert/strict";
import test from "node:test";
import { sweep, SWEEPER_RECOVERY_POLICY } from "../tmp/test-dist/lib/context/sweeper.js";

/**
 * 회수기는 **지우는 코드**다. 그래서 여기 적는 것은 "잘 도는가" 가 아니라 **지우면 안 되는
 * 때 지우지 않는가** 다. 라이브 게이트가 이 회수기의 정책(`cleanup-only-v1`)을 근거로 열리므로,
 * 그 정책이 코드에서 실제로 지켜지는지를 시험이 붙잡고 있어야 한다.
 */

function 잡(덮어쓰기 = {}) {
  return {
    id: "job-1",
    studioFileId: "file-1",
    cleanupStatus: "pending",
    bytesScrubbed: false,
    cleanupAttempts: 0,
    stateVersion: 3,
    ...덮어쓰기,
  };
}

/** 호출을 그대로 적어 두는 가짜 저장소. 이긴/진 경쟁을 `claim` 반환으로 정한다. */
function 가짜(설정 = {}) {
  const 기록 = { claim: [], scrub: [], markDeleted: [], markFailed: [], health: [] };
  const 잡음 = { id: "job-1", owner: "sweeper-1", fence: 9, stateVersion: 4 };
  return {
    기록,
    port: {
      async listStale() {
        return 설정.stale ?? [잡()];
      },
      async claim(job, owner, leaseMs) {
        기록.claim.push({ job, owner, leaseMs });
        return 설정.claimFails ? null : { ...잡음, id: job.id, owner };
      },
      async scrub(claim) {
        기록.scrub.push(claim);
        return 설정.scrubFails ? null : { ...claim, stateVersion: claim.stateVersion + 1 };
      },
      async markDeleted(claim, attempts) {
        기록.markDeleted.push({ claim, attempts });
        return 설정.markDeletedFails ? null : claim;
      },
      async markFailed(claim, attempts, errorCode) {
        기록.markFailed.push({ claim, attempts, errorCode });
        return claim;
      },
      async recordHealth(owner, result) {
        기록.health.push({ owner, result });
      },
    },
  };
}

test("fence 경쟁에서 진 회수기는 원격을 건드리지 않고 멈춘다", async () => {
  // 계약이 요구하는 동작이다 — 두 회수기가 한 잡을 집으면 하나만 이기고 진 쪽은 멈춘다.
  // 진 쪽이 그래도 DELETE 를 쏘면, 이긴 쪽이 다시 쓰고 있는 잡의 파일을 지우게 된다.
  const { port, 기록 } = 가짜({ claimFails: true });
  const 원격 = [];
  const result = await sweep(port, {
    owner: "sweeper-loser",
    deleteRemote: async (id) => {
      원격.push(id);
      return { status: "deleted", attempts: 1 };
    },
  });

  assert.equal(원격.length, 0, "진 쪽이 원격 삭제를 불렀다");
  assert.equal(기록.scrub.length, 0);
  assert.equal(기록.markDeleted.length, 0);
  assert.deepEqual(result, { stale: 1, claimed: 0, cleaned: 0, failed: 0 });
});

test("원격 삭제가 실패하면 로컬 바이트를 지우지 않는다", async () => {
  // 여기가 가장 중요하다. 원격에 파일이 남았는데 로컬만 지우면 **지울 단서를 잃는다** —
  // `studio_file_id` 로 다시 찾을 수는 있지만, 성공으로 세어 버리면 아무도 다시 오지 않는다.
  const { port, 기록 } = 가짜();
  const result = await sweep(port, {
    owner: "sweeper-1",
    deleteRemote: async () => ({ status: "failed", attempts: 2 }),
  });

  assert.equal(기록.scrub.length, 0, "원격이 남았는데 로컬을 지웠다");
  assert.equal(기록.markDeleted.length, 0);
  assert.equal(기록.markFailed.length, 1);
  assert.equal(기록.markFailed[0].errorCode, "remote_failed");
  assert.equal(기록.markFailed[0].attempts, 2);
  assert.deepEqual(result, { stale: 1, claimed: 1, cleaned: 0, failed: 1 });
});

test("이미 지워진 원격 파일은 다시 부르지 않고 바이트만 지운다", async () => {
  const { port, 기록 } = 가짜({ stale: [잡({ cleanupStatus: "deleted", bytesScrubbed: false })] });
  const 원격 = [];
  const result = await sweep(port, {
    owner: "sweeper-1",
    deleteRemote: async (id) => {
      원격.push(id);
      return { status: "deleted", attempts: 1 };
    },
  });

  assert.equal(원격.length, 0);
  assert.equal(기록.scrub.length, 1);
  assert.deepEqual(result, { stale: 1, claimed: 1, cleaned: 1, failed: 0 });
});

test("바이트를 지우는 도중 소유권을 잃으면 성공으로 세지 않는다", async () => {
  const { port, 기록 } = 가짜({ scrubFails: true });
  const result = await sweep(port, {
    owner: "sweeper-1",
    deleteRemote: async () => ({ status: "deleted", attempts: 1 }),
  });

  assert.equal(기록.markDeleted.length, 0);
  assert.deepEqual(result, { stale: 1, claimed: 1, cleaned: 0, failed: 1 });
});

test("끝맺음 쓰기가 0행이면 지웠다고 세지 않는다", async () => {
  const { port } = 가짜({ markDeletedFails: true });
  const result = await sweep(port, {
    owner: "sweeper-1",
    deleteRemote: async () => ({ status: "deleted", attempts: 1 }),
  });

  assert.deepEqual(result, { stale: 1, claimed: 1, cleaned: 0, failed: 1 });
});

test("dryRun 은 세기만 하고 아무것도 지우지 않는다", async () => {
  // 공유 운영 DB 에 처음 대볼 때 이 경로로 먼저 본다. 이게 뭘 지워 버리면 쓸 수 없다.
  const { port, 기록 } = 가짜({ stale: [잡(), 잡({ id: "job-2" })] });
  const 원격 = [];
  const result = await sweep(port, {
    owner: "sweeper-1",
    dryRun: true,
    deleteRemote: async (id) => {
      원격.push(id);
      return { status: "deleted", attempts: 1 };
    },
  });

  assert.equal(원격.length, 0);
  assert.equal(기록.claim.length, 0, "dryRun 이 소유권을 잡았다");
  assert.equal(기록.scrub.length, 0);
  assert.equal(기록.health.length, 0, "dryRun 이 건강 기록을 덮었다");
  assert.deepEqual(result, { stale: 2, claimed: 0, cleaned: 0, failed: 0 });
});

test("한 회차의 실측치를 건강 기록에 그대로 남긴다", async () => {
  const { port, 기록 } = 가짜({ stale: [잡(), 잡({ id: "job-2" })] });
  const result = await sweep(port, {
    owner: "sweeper-1",
    deleteRemote: async () => ({ status: "deleted", attempts: 1 }),
  });

  assert.equal(기록.health.length, 1);
  assert.equal(기록.health[0].owner, "sweeper-1");
  assert.deepEqual(기록.health[0].result, result);
  assert.deepEqual(result, { stale: 2, claimed: 2, cleaned: 2, failed: 0 });
});

test("정책 이름은 영수증이 검사하는 문자열과 같아야 한다", () => {
  // `lib/context/live-readiness.ts:219` 가 이 문자열을 그대로 대조한다. 여기서 바꾸면
  // 라이브 게이트가 조용히 닫힌다.
  assert.equal(SWEEPER_RECOVERY_POLICY, "cleanup-only-v1");
});
