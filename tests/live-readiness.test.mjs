import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createReadinessReceipt } from "../scripts/studio-provision.mjs";
import {
  getStudioIdentityFromReceipt,
  getStudioLiveReadiness,
  parseStudioLiveReadinessReceipt,
} from "../tmp/test-dist/lib/context/live-readiness.js";
import { STUDIO_MANIFEST_SHA } from "../tmp/test-dist/lib/context/studio-manifest.js";
import { deriveIngestDeadlines } from "../tmp/test-dist/lib/context/ingest-execution.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const KEY = "test-upstage-key";
const KEY_FINGERPRINT = `sha256:${createHash("sha256").update(KEY).digest("hex")}`;

function receipt(overrides = {}) {
  const workflow = {
    agentId: "agent-1",
    configId: "config-1",
    configFingerprint: "config-sha",
    servedIdentity: "agent-1",
    servedIdentityField: "model",
    requestFields: { config_id: "config-1" },
  };
  return {
    schemaVersion: 3,
    receiptId: "capability-receipt-1",
    issuedAt: "2026-08-22T11:00:00.000Z",
    expiresAt: "2026-08-22T13:00:00.000Z",
    scope: "localhost-development",
    accountId: "localhost-development",
    credentialScope: { scheme: "credential-scope/v1", keyFingerprint: KEY_FINGERPRINT, inventoryDigest: `sha256:${"b".repeat(64)}`, endpoint: "https://api.upstage.ai/v2/agents", observedAt: "2026-08-22T11:55:00.000Z" },
    topology: "per-kind-agent",
    physicalStudioSteps: ["document-parse", "information-extract"],
    runtimeOwnership: { studio: ["document-parse", "information-extract"], application: ["validation", "review"] },
    configPinProof: "documented-explicit-config-pin/v1",
    configPinEvidence: {
      officialDocs: { url: "https://console.upstage.ai/docs/studio/deployment.md", sha256: `sha256:${"c".repeat(64)}`, retrievedAt: "2026-08-22T10:54:00.000Z" },
      spike: {
        scheme: "sacrificial-differential-config-pin/v1", configAId: "config-a", configBId: "config-b", configCId: "config-c", preConfigFingerprint: "fingerprint", postConfigFingerprint: "fingerprint",
        aResponse: { agentId: "agent-1", initialStatus: "queued", stepNames: ["parse", "extract_기타"], status: "completed" },
        bDefaultMutation: { scheme: "config-create-default-observation/v1", beforeDefaultConfigId: "config-a", afterDefaultConfigId: "config-b", observedVia: "authenticated-agent-get/v1" }, cDefaultMutation: { scheme: "config-create-default-observation/v1", beforeDefaultConfigId: "config-b", afterDefaultConfigId: "config-c", responseStatusBeforeMutation: "queued", observedVia: "authenticated-agent-get/v1" }, cleanup: { status: "deleted" }, rollback: { status: "restored" },
      },
    },
    servedConfigEchoVerified: false,
    servedAgentVerified: true,
    manifestSha: STUDIO_MANIFEST_SHA,
    outputEnvelopeVersion: "studio-document-envelope/v1",
    responseParserVersion: "studio-response-parser/v2",
    cleanupMigrationVersion: "studio-cleanup-control-v1",
    cleanupMigrationVerified: true,
    sweeper: { healthy: true, checkedAt: "2026-08-22T11:55:00.000Z", recoveryPolicy: "cleanup-only-v1" },
    platformBudget: {
      maxDurationMs: 90_000,
      processingDeadlineMs: 60_000,
      cleanupReserveMs: 20_000,
      responseMarginMs: 10_000,
    },
    workflows: {
      하도급계약서: workflow,
      위험성평가표: workflow,
      TBM회의록: workflow,
      작업표준: workflow,
      순회점검일지: workflow,
      기타: workflow,
    },
    ...overrides,
  };
}

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("live remains disabled when the flag is absent even with a valid receipt", () => {
  withEnv(
    {
      STUDIO_LIVE_INGEST_ENABLED: undefined,
      STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt()),
      STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
      STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true",
      NODE_ENV: "development",
      UPSTAGE_API_KEY: KEY,
    },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, false),
  );
});

test("an environment flag alone never enables live ingestion", () => {
  withEnv(
    {
      STUDIO_LIVE_INGEST_ENABLED: "true",
      STUDIO_LIVE_READINESS_RECEIPT_JSON: undefined,
      STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
      STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true",
      NODE_ENV: "development",
      UPSTAGE_API_KEY: KEY,
    },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, false),
  );
});

test("validates every local readiness dimension before exposing pinned identity", () => {
  withEnv(
    {
      STUDIO_LIVE_INGEST_ENABLED: "true",
      STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt()),
      STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
      STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true",
      NODE_ENV: "development",
      UPSTAGE_API_KEY: KEY,
    },
    () => {
      const readiness = getStudioLiveReadiness(NOW);
      assert.equal(readiness.enabled, true);
      if (!readiness.enabled) return;
      assert.deepEqual(getStudioIdentityFromReceipt(readiness.receipt, "기타"), {
        agentId: "agent-1",
        agentName: undefined,
        role: undefined,
        capabilityReceiptId: "capability-receipt-1",
        manifestSha: STUDIO_MANIFEST_SHA,
        configFingerprint: "config-sha",
        configId: "config-1",
        servedIdentity: "agent-1",
        servedIdentityField: "model",
        requestFields: { config_id: "config-1" },
      });
    },
  );
});

test("localhost scope is bound to the active key and fails closed on absence, mismatch, or rotation", () => {
  const enabled = (key) => withEnv(
    {
      STUDIO_LIVE_INGEST_ENABLED: "true",
      STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt()),
      STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
      STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true",
      NODE_ENV: "development",
      UPSTAGE_API_KEY: key,
    },
    () => getStudioLiveReadiness(NOW).enabled,
  );
  assert.equal(enabled(KEY), true);
  assert.equal(enabled(undefined), false);
  assert.equal(enabled("rotated-upstage-key"), false);
  const mismatched = receipt();
  mismatched.credentialScope.keyFingerprint = `sha256:${"d".repeat(64)}`;
  withEnv(
    { STUDIO_LIVE_INGEST_ENABLED: "true", STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(mismatched), STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1", STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true", NODE_ENV: "development", UPSTAGE_API_KEY: KEY },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, false),
  );
});

test("accepts only fresh canonical Upstage deployment documentation evidence", () => {
  const wrongDocument = receipt();
  wrongDocument.configPinEvidence.officialDocs.url = "https://console.upstage.ai/docs/studio/other.md";
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(wrongDocument)), null);
  const wrongOrigin = receipt();
  wrongOrigin.configPinEvidence.officialDocs.url = "https://developers.upstage.ai/docs/studio/deployment.md";
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(wrongOrigin)), null);
  const future = receipt();
  future.configPinEvidence.officialDocs.retrievedAt = "2026-08-22T11:01:00.000Z";
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(future)), null);
  const stale = receipt();
  stale.configPinEvidence.officialDocs.retrievedAt = "2026-08-21T10:59:59.000Z";
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(stale)), null);
});

test("producer readiness receipts round-trip through the runtime parser", () => {
  const manifest = JSON.parse(readFileSync(new URL("../lib/context/studio-manifest.json", import.meta.url), "utf8"));
  const created = manifest.contracts.map((contract, index) => ({ kind: contract.kind, agentId: `agent-${index}`, configId: `config-${index}`, configFingerprint: `fingerprint-${index}` }));
  const artifact = { mode: "apply", manifestSha: manifest.fingerprint, runId: "roundtrip", created };
  const smoke = {
    mode: "smoke", manifestSha: manifest.fingerprint,
    proofs: Object.fromEntries(manifest.contracts.map((contract, index) => [contract.kind, {
      status: "completed", cleanup: "deleted", agentId: `agent-${index}`, configId: `config-${index}`, createdConfigFingerprint: `fingerprint-${index}`,
      servedIdentity: `agent-${index}`, servedIdentityField: "model", requestFields: { config_id: `config-${index}` }, remoteStepNames: contract.steps.map((step) => step.logicalName), outputsRetrieved: contract.steps.length,
    }])),
  };
  const evidence = {
    officialDocs: { url: "https://console.upstage.ai/docs/studio/deployment.md", sha256: `sha256:${"c".repeat(64)}`, retrievedAt: "2026-08-22T10:54:00.000Z" },
    spike: structuredClone(receipt().configPinEvidence.spike),
  };
  const generated = createReadinessReceipt({
    manifest, artifact, smoke,
    dbHealth: { ready: true, recoveryPolicy: "cleanup-only-v1", cleanupMigrationVersion: "studio-cleanup-control-v1", checkedAt: "2026-08-22T11:55:00.000Z" },
    credentialScope: receipt().credentialScope, configPinEvidence: evidence, now: NOW,
  });
  assert.deepEqual(parseStudioLiveReadinessReceipt(JSON.stringify(generated)), JSON.parse(JSON.stringify(generated)));
});

test("rejects an unsafe host budget and stale sweeper receipt", () => {
  assert.equal(
    parseStudioLiveReadinessReceipt(
      JSON.stringify(receipt({
        platformBudget: {
          maxDurationMs: 60_000,
          processingDeadlineMs: 50_000,
          cleanupReserveMs: 5_000,
          responseMarginMs: 5_000,
        },
      })),
    ),
    null,
  );
  withEnv(
    {
      STUDIO_LIVE_INGEST_ENABLED: "true",
      STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt({
        sweeper: { healthy: true, checkedAt: "2026-08-22T11:00:00.000Z", recoveryPolicy: "cleanup-only-v1" },
      })),
      STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
      STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true",
      NODE_ENV: "development",
      UPSTAGE_API_KEY: KEY,
    },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, false),
  );
});

test("anchors processing, cleanup, and response margin once at stream entry", () => {
  const deadlines = deriveIngestDeadlines(receipt(), NOW);
  assert.deepEqual(deadlines, {
    hostDeadline: NOW + 90_000,
    processingDeadline: NOW + 60_000,
    cleanupDeadline: NOW + 80_000,
  });
  assert.equal(deadlines.cleanupDeadline - deadlines.processingDeadline, 20_000);
  assert.equal(deadlines.hostDeadline - deadlines.cleanupDeadline, 10_000);
});

test("requires all six kinds, an exact config request pin, and a served agent echo", () => {
  const missingKind = receipt();
  delete missingKind.workflows.기타;
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(missingKind)), null);

  const mismatchedBinding = receipt();
  mismatchedBinding.workflows.기타 = {
    ...mismatchedBinding.workflows.기타,
    requestFields: { config_id: "config-elsewhere" },
  };
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(mismatchedBinding)), null);
});

test("rejects legacy atomic-binding claims and requires explicit v3 proof semantics", () => {
  const legacy = receipt();
  legacy.schemaVersion = 2;
  legacy.atomicBindingVerified = true;
  delete legacy.configPinProof;
  delete legacy.configPinEvidence;
  delete legacy.servedConfigEchoVerified;
  delete legacy.servedAgentVerified;
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(legacy)), null);

  const noRequestPin = receipt({ configPinProof: "unverified" });
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(noRequestPin)), null);
  const noServedAgentProof = receipt({ servedAgentVerified: false });
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(noServedAgentProof)), null);
});

test("rejects config-pin evidence that does not prove an in-flight default mutation", () => {
  const afterCompletion = receipt();
  delete afterCompletion.configPinEvidence.spike.aResponse.initialStatus;
  delete afterCompletion.configPinEvidence.spike.cDefaultMutation.responseStatusBeforeMutation;
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(afterCompletion)), null);

  const mismatchedOrder = receipt();
  mismatchedOrder.configPinEvidence.spike.cDefaultMutation.responseStatusBeforeMutation = "in_progress";
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(mismatchedOrder)), null);
});

test("rejects reserved request fields that could replace the workflow payload", () => {
  const injected = receipt();
  injected.workflows.기타 = {
    ...injected.workflows.기타,
    requestFields: { config_id: "config-1", model: "attacker-agent" },
  };
  assert.equal(parseStudioLiveReadinessReceipt(JSON.stringify(injected)), null);
});

test("production rejects localhost credential scope; local scope needs its explicit development flag", () => {
  withEnv(
    {
      STUDIO_LIVE_INGEST_ENABLED: "true",
      STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt()),
      STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
      STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true",
      NODE_ENV: "production",
      UPSTAGE_API_KEY: KEY,
    },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, false),
  );
  withEnv(
    {
      STUDIO_LIVE_INGEST_ENABLED: "true",
      STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt()),
      STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
      STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: undefined,
      NODE_ENV: "development",
      UPSTAGE_API_KEY: KEY,
    },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, false),
  );
});

test("production accepts only an independently identified api project", () => {
  const production = receipt({
    scope: "production-project",
    accountId: "project-1",
    credentialScope: undefined,
    projectIdentity: { scheme: "api-project-id/v1", projectId: "project-1", endpoint: "https://api.upstage.ai/v2/projects/me", observedAt: "2026-08-22T11:55:00.000Z", requestId: "request-1" },
  });
  withEnv(
    { STUDIO_LIVE_INGEST_ENABLED: "true", STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(production), STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1", STUDIO_EXPECTED_PROJECT_ID: "project-1", NODE_ENV: "production", STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: undefined },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, true),
  );
  withEnv(
    { STUDIO_LIVE_INGEST_ENABLED: "true", STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(production), STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1", STUDIO_EXPECTED_PROJECT_ID: "other-project", NODE_ENV: "production", STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: undefined },
    () => assert.equal(getStudioLiveReadiness(NOW).enabled, false),
  );
});

test("rejects a sweeper receipt that could resume persisted Studio responses", () => {
  assert.equal(
    parseStudioLiveReadinessReceipt(JSON.stringify(receipt({
      sweeper: { healthy: true, checkedAt: "2026-08-22T11:55:00.000Z", recoveryPolicy: "resume-response-v1" },
    }))),
    null,
  );
});

// 실패 사유는 관리자 화면에 그대로 렌더된다(`components/site-context-panel.tsx` 의
// `stage-error` · `context-message`). 열 가지 원인은 서로 다른 조치를 뜻하므로 문구를
// 하나로 뭉치면 안 되고, 내부 이름·환경변수·영문 코드는 `detail` 로만 나가야 한다.
test("every disabled reason is admin-readable, distinct, and keeps its cause in a separate field", () => {
  const LOCAL = {
    STUDIO_LIVE_INGEST_ENABLED: "true",
    STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt()),
    STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v1",
    STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: "true",
    STUDIO_EXPECTED_PROJECT_ID: undefined,
    NODE_ENV: "development",
    UPSTAGE_API_KEY: KEY,
  };
  const production = receipt({
    scope: "production-project",
    accountId: "project-1",
    credentialScope: undefined,
    projectIdentity: { scheme: "api-project-id/v1", projectId: "project-1", endpoint: "https://api.upstage.ai/v2/projects/me", observedAt: "2026-08-22T11:55:00.000Z" },
  });

  const causes = [
    ["flag off", { ...LOCAL, STUDIO_LIVE_INGEST_ENABLED: undefined }, NOW],
    ["receipt absent", { ...LOCAL, STUDIO_LIVE_READINESS_RECEIPT_JSON: undefined }, NOW],
    ["receipt unreadable", { ...LOCAL, STUDIO_LIVE_READINESS_RECEIPT_JSON: "{}" }, NOW],
    ["manifest mismatch", { ...LOCAL, STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(receipt({ manifestSha: "other-manifest" })) }, NOW],
    ["required migration unpinned", { ...LOCAL, STUDIO_REQUIRED_CLEANUP_MIGRATION: undefined }, NOW],
    ["project mismatch", { ...LOCAL, STUDIO_LIVE_READINESS_RECEIPT_JSON: JSON.stringify(production), STUDIO_EXPECTED_PROJECT_ID: "other-project", STUDIO_LOCAL_CREDENTIAL_SCOPE_ENABLED: undefined, NODE_ENV: "production" }, NOW],
    ["local scope in production", { ...LOCAL, NODE_ENV: "production" }, NOW],
    ["key fingerprint mismatch", { ...LOCAL, UPSTAGE_API_KEY: "rotated-upstage-key" }, NOW],
    ["cleanup migration mismatch", { ...LOCAL, STUDIO_REQUIRED_CLEANUP_MIGRATION: "studio-cleanup-control-v2" }, NOW],
    ["receipt expired", LOCAL, NOW + 3 * 60 * 60_000],
  ];

  const reasons = new Map();
  const details = new Map();
  for (const [label, env, at] of causes) {
    withEnv(env, () => {
      const readiness = getStudioLiveReadiness(at);
      assert.equal(readiness.enabled, false, `${label} should stay disabled`);
      if (readiness.enabled) return;

      // 관리자 문장에는 내부 이름·환경변수·영문 코드가 없다.
      assert.doesNotMatch(readiness.reason, /[A-Za-z]/, `${label} leaks an internal name`);
      assert.match(readiness.reason, /(습니다|주세요)\.$/, `${label} must end in 합쇼체`);
      // 개발자용 원인은 별도 필드에만 남는다.
      assert.match(readiness.detail, /[A-Za-z]/, `${label} must keep a developer detail`);

      assert.equal(reasons.has(readiness.reason), false, `${label} reuses the reason of ${reasons.get(readiness.reason)}`);
      assert.equal(details.has(readiness.detail), false, `${label} reuses the detail of ${details.get(readiness.detail)}`);
      reasons.set(readiness.reason, label);
      details.set(readiness.detail, label);
    });
  }
  assert.equal(reasons.size, causes.length);
});
