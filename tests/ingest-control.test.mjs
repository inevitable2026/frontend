import assert from "node:assert/strict";
import test from "node:test";
import {
  heartbeatIngestLease,
  IngestLeaseLostError,
  matchesStudioIngestProvenance,
  persistStudioFile,
  persistStudioProvenance,
  persistStudioResponse,
  persistStudioServedIdentity,
} from "../tmp/test-dist/lib/context/ingest-control.js";

test("heartbeat extends only lease expiry and leaves pipeline CAS state untouched", async () => {
  const previous = globalThis.__contextSql;
  let query;
  globalThis.__contextSql = async (strings, ...values) => {
    query = { text: strings.join("?"), values };
    return [{ id: "job-1" }];
  };

  try {
    const lease = { jobId: "job-1", owner: "runner-1", fence: 7, stateVersion: 987_654 };
    assert.equal(await heartbeatIngestLease(lease, 12_345), true);
    assert.match(query.text, /set lease_expires_at/);
    assert.match(query.text, /lease_owner/);
    assert.match(query.text, /lease_fence/);
    assert.doesNotMatch(query.text, /state_version\s*=/);
    assert.deepEqual(query.values, [12_345, "job-1", "runner-1", 7]);
    assert.ok(!query.values.includes(lease.stateVersion));
  } finally {
    globalThis.__contextSql = previous;
  }
});

test("Studio provenance comparison rejects incomplete and mismatched recovery rows", () => {
  const expected = {
    manifestSha: "manifest-sha", accountId: "account-1", agentId: "agent-1",
    configId: "config-1", configFingerprint: "config-sha",
  };
  assert.equal(matchesStudioIngestProvenance(expected, expected), true);
  assert.equal(matchesStudioIngestProvenance({ ...expected, agentId: "agent-other" }, expected), false);
  assert.equal(matchesStudioIngestProvenance({ ...expected, manifestSha: "" }, expected), false);
});

test("persists the complete immutable Studio identity under the fenced lease", async () => {
  const previous = globalThis.__contextSql;
  let query;
  globalThis.__contextSql = async (strings, ...values) => {
    query = { text: strings.join("?"), values };
    return [{ lease_fence: 7, state_version: 13 }];
  };

  try {
    const next = await persistStudioProvenance(
      { jobId: "job-3", owner: "runner-3", fence: 7, stateVersion: 12 },
      {
        manifestSha: "manifest-sha",
        accountId: "account-1",
        agentId: "agent-1",
        configId: "config-1",
        configFingerprint: "config-sha",
      },
    );
    assert.equal(next.stateVersion, 13);
    assert.match(query.text, /studio_manifest_sha/);
    assert.match(query.text, /studio_account_id/);
    assert.match(query.text, /studio_agent_id/);
    assert.match(query.text, /studio_config_id/);
    assert.match(query.text, /studio_config_fingerprint/);
    assert.doesNotMatch(query.text, /studio_served_identity/);
    assert.match(query.text, /state_version = state_version \+ 1/);
    assert.match(query.text, /is not distinct from/);
    assert.deepEqual(query.values, [
      "manifest-sha", "account-1", "agent-1", "config-1", "config-sha",
      "job-3", "runner-3", 7, 12,
      "manifest-sha", "account-1", "agent-1", "config-1", "config-sha",
    ]);
  } finally {
    globalThis.__contextSql = previous;
  }
});

test("refuses a stale or mismatched Studio provenance checkpoint", async () => {
  const previous = globalThis.__contextSql;
  globalThis.__contextSql = async () => [];

  try {
    await assert.rejects(
      persistStudioProvenance(
        { jobId: "job-4", owner: "runner-4", fence: 2, stateVersion: 3 },
        {
          manifestSha: "manifest-sha", accountId: "account-1", agentId: "agent-1",
          configId: null, configFingerprint: "config-sha",
        },
      ),
      IngestLeaseLostError,
    );
  } finally {
    globalThis.__contextSql = previous;
  }
});

test("persists an observed served identity only after response validation", async () => {
  const previous = globalThis.__contextSql;
  let query;
  globalThis.__contextSql = async (strings, ...values) => {
    query = { text: strings.join("?"), values };
    return [{ lease_fence: 2, state_version: 4 }];
  };
  try {
    await persistStudioServedIdentity({ jobId: "job-5", owner: "runner-5", fence: 2, stateVersion: 3 }, "served-config-1");
    assert.match(query.text, /studio_served_identity/);
    assert.match(query.text, /studio_served_identity is null or studio_served_identity is not distinct from/);
    assert.deepEqual(query.values, ["served-config-1", "job-5", "runner-5", 2, 3, "served-config-1"]);
  } finally {
    globalThis.__contextSql = previous;
  }
});

test("Studio remote IDs are immutable first-write checkpoints", async () => {
  const previous = globalThis.__contextSql;
  const queries = [];
  globalThis.__contextSql = async (strings, ...values) => {
    queries.push({ text: strings.join("?"), values });
    return [{ lease_fence: 3, state_version: queries.length + 5 }];
  };
  try {
    const lease = { jobId: "job-6", owner: "runner-6", fence: 3, stateVersion: 5 };
    const afterFile = await persistStudioFile(lease, "file-1");
    await persistStudioResponse(afterFile, "response-1");
    assert.match(queries[0].text, /studio_file_id is null or studio_file_id is not distinct from/);
    assert.equal(queries[0].values.at(-1), "file-1");
    assert.match(queries[1].text, /studio_response_id is null or studio_response_id is not distinct from/);
    assert.equal(queries[1].values.at(-1), "response-1");
  } finally {
    globalThis.__contextSql = previous;
  }
});

test("heartbeat reports a reclaimed or terminal lease without mutating the local fence", async () => {
  const previous = globalThis.__contextSql;
  globalThis.__contextSql = async () => [];

  try {
    assert.equal(
      await heartbeatIngestLease({ jobId: "job-2", owner: "runner-2", fence: 8, stateVersion: 21 }),
      false,
    );
  } finally {
    globalThis.__contextSql = previous;
  }
});
