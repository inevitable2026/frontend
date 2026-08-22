import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyProvision, createReadinessReceipt, makeApi, normalizeDbHealth, planProvision, rollbackProvision, smokeProvision, spikeExplicitConfigPin } from "../scripts/studio-provision.mjs";

const manifest = JSON.parse(readFileSync(new URL("../lib/context/studio-manifest.json", import.meta.url), "utf8"));

function fakeStudio() {
  const calls = []; const agents = new Map(); const files = new Map(); const configsById = new Map(); let next = 1; let responseModel = null; let responseConfigId = null;
  const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: body === null ? {} : { "content-type": "application/json" } });
  const fetch = async (input, init = {}) => {
    const url = new URL(input); const method = init.method ?? "GET"; calls.push({ method, path: url.pathname, body: init.body });
    if (method === "GET" && url.pathname === "/v2/agents") return json({ data: [...agents.values()] });
    if (method === "POST" && url.pathname === "/v2/agents") { const id = `agent-${next++}`; agents.set(id, { id, name: null }); return json({ id }); }
    const agent = url.pathname.match(/^\/v2\/agents\/([^/]+)$/);
    if (agent && method === "PATCH") { const current = agents.get(agent[1]); const patch = JSON.parse(init.body); const updated = { ...current, ...patch }; agents.set(agent[1], updated); return json(updated); }
    if (agent && method === "GET") return json(agents.get(agent[1]) ?? { error: "missing" }, agents.has(agent[1]) ? 200 : 404);
    if (agent && method === "DELETE") { agents.delete(agent[1]); return json(null, 204); }
    const configs = url.pathname.match(/^\/v2\/agents\/([^/]+)\/configs$/);
    if (configs && method === "POST") {
      const steps = JSON.parse(init.body).steps;
      const id = `config-${next++}`;
      const config = { id, agent_id: configs[1], external_id: `external-${id}`, steps: steps.map((step, index) => ({ ...step, id: `step-${id}-${index}` })) };
      configsById.set(id, config);
      agents.set(configs[1], { ...agents.get(configs[1]), default_config_id: id, default_config_external_id: config.external_id });
      return json(config);
    }
    const configList = url.pathname.match(/^\/v2\/agents\/([^/]+)\/configs$/);
    if (configList && method === "GET") return json({ data: [...configsById.values()].filter((config) => config.agent_id === configList[1]) });
    if (method === "POST" && url.pathname === "/v2/files") { const id = `file-${next++}`; files.set(id, false); return json({ id }); }
    const file = url.pathname.match(/^\/v2\/files\/([^/]+)$/);
    if (file && method === "DELETE") { files.set(file[1], true); return json(null, 204); }
    if (method === "POST" && url.pathname === "/v2/responses") { const body = JSON.parse(init.body); responseModel = body.model; responseConfigId = body.config_id; return json({ id: "response-1", status: "queued", model: body.model }); }
    if (method === "GET" && url.pathname === "/v2/responses/response-1") {
      const steps = configsById.get(responseConfigId)?.steps ?? [];
      return json({ id: "response-1", status: "completed", model: responseModel, config_id: responseConfigId, output: steps.map((step) => ({ model: step.name, content: [] })) });
    }
    return json({ error: "unexpected" }, 500);
  };
  return { fetch, calls, agents, files };
}

const SHA = (letter) => `sha256:${letter.repeat(64)}`;
function localhostScope() {
  return { scheme: "credential-scope/v1", keyFingerprint: SHA("a"), inventoryDigest: SHA("b"), endpoint: "https://api.upstage.ai/v2/agents", observedAt: "2026-08-22T11:55:00.000Z" };
}
function configPinEvidence(artifact) {
  const pin = artifact.created[0];
  return {
    officialDocs: { url: "https://console.upstage.ai/docs/studio/deployment.md", sha256: SHA("c"), retrievedAt: "2026-08-22T11:54:00.000Z" },
    spike: {
      scheme: "sacrificial-differential-config-pin/v1", configAId: pin.configId, configBId: `${pin.configId}-b`, configCId: `${pin.configId}-c`, preConfigFingerprint: pin.configFingerprint, postConfigFingerprint: pin.configFingerprint,
      aResponse: { agentId: pin.agentId, initialStatus: "queued", stepNames: ["parse", `extract_${pin.kind}`], status: "completed" },
      bDefaultMutation: { scheme: "config-create-default-observation/v1", beforeDefaultConfigId: pin.configId, afterDefaultConfigId: `${pin.configId}-b`, observedVia: "authenticated-agent-get/v1" }, cDefaultMutation: { scheme: "config-create-default-observation/v1", beforeDefaultConfigId: `${pin.configId}-b`, afterDefaultConfigId: `${pin.configId}-c`, responseStatusBeforeMutation: "queued", observedVia: "authenticated-agent-get/v1" }, cleanup: { status: "deleted" }, rollback: { status: "restored" },
    },
  };
}

test("plan is read-only and generated names never adopt canonical or existing names", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: fake.fetch, apiKey: "test-key" });
  const plan = await planProvision({ manifest, api, runId: "r1" });
  assert.equal(plan.mode, "plan");
  assert.equal(plan.operations.length, 6);
  assert.ok(plan.operations.every((item) => item.action === "create" && item.physicalName.includes("r1")));
  assert.deepEqual(fake.calls.map((call) => call.method), ["GET"]);
  fake.agents.set("existing", { id: "existing", name: plan.operations[0].physicalName });
  const collision = await planProvision({ manifest, api, runId: "r1" });
  assert.equal(collision.operations[0].action, "collision");
});

test("apply records physical IDs and fingerprints without rewriting the manifest", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: fake.fetch, apiKey: "test-key" });
  const receipt = await applyProvision({ manifest, api, runId: "r2" });
  assert.equal(receipt.created.length, 6);
  assert.equal("accountIdentity" in receipt, false);
  assert.ok(receipt.created.every((item) => item.agentName.includes("r2") && item.configId && item.configFingerprint.length === 64));
  assert.ok(receipt.created.every((item) => Object.keys(item.stepIds).length === 2));
  assert.equal(fake.calls.filter((call) => call.method === "POST" && /\/configs$/.test(call.path)).length, 6);
  assert.equal(manifest.contracts[0].expectedConfigFingerprint, null);
});

test("rollback deletes only agents asserted by its creation receipt", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: fake.fetch, apiKey: "test-key" });
  const receipt = await applyProvision({ manifest, api, runId: "r3" });
  const result = await rollbackProvision({ receipt, api });
  assert.equal(result.resources.length, 6);
  assert.equal(fake.agents.size, 0);
});

test("rollback refuses a receipt whose remote ownership marker was removed", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: fake.fetch, apiKey: "test-key" });
  const receipt = await applyProvision({ manifest, api, runId: "r4" });
  const target = receipt.created[0];
  fake.agents.set(target.agentId, { ...fake.agents.get(target.agentId), description: "unrelated" });
  await assert.rejects(rollbackProvision({ receipt, api }), /does not prove receipt ownership/);
  assert.ok(fake.agents.has(target.agentId));
});

test("smoke proves every exact pin, records real Studio model step names, and deletes every synthetic remote file", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: fake.fetch, apiKey: "test-key" });
  const artifact = await applyProvision({ manifest, api, runId: "smoke" });
  const receipt = await smokeProvision({ manifest, artifact, api, pdfBytes: new Uint8Array([37, 80, 68, 70]), pollLimit: 2, pollIntervalMs: 0, sleep: async () => {} });
  assert.equal(Object.keys(receipt.proofs).length, 6);
  assert.ok(Object.values(receipt.proofs).every((proof) => proof.status === "completed" && proof.outputsRetrieved === 2 && proof.cleanup === "deleted"));
  assert.ok(Object.values(receipt.proofs).every((proof) => proof.createdConfigFingerprint.length === 64 && JSON.stringify(proof.requestFields) === JSON.stringify({ config_id: proof.configId })));
  assert.ok(Object.values(receipt.proofs).every((proof) => proof.remoteStepNames[0] === "parse" && proof.remoteStepNames[1].startsWith("extract_")));
  assert.ok([...fake.files.values()].every(Boolean));
  const responseCall = fake.calls.find((call) => call.path === "/v2/responses");
  assert.match(String(responseCall.body), /"config_id":"config-/);
});

test("sacrificial spike observes create-driven defaults and rolls back its A/B/C resources", async () => {
  const fake = fakeStudio(); const api = makeApi({ fetch: fake.fetch, apiKey: "test-key" });
  const proof = await spikeExplicitConfigPin({ manifest, api, pdfBytes: new Uint8Array([37]), runId: "spike", pollIntervalMs: 0, sleep: async () => {} });
  assert.equal(proof.scheme, "sacrificial-differential-config-pin/v1");
  assert.equal(proof.cleanup.status, "deleted"); assert.equal(proof.rollback.status, "restored");
  assert.equal(proof.aResponse.initialStatus, "queued");
  assert.equal(proof.cDefaultMutation.responseStatusBeforeMutation, "queued");
  const responseIndex = fake.calls.findIndex((call) => call.method === "POST" && call.path === "/v2/responses");
  const cCreateIndex = fake.calls.findIndex((call, index) => index > responseIndex && call.method === "POST" && /\/configs$/.test(call.path));
  const completionPollIndex = fake.calls.findIndex((call) => call.method === "GET" && call.path === "/v2/responses/response-1");
  assert.ok(responseIndex >= 0 && cCreateIndex > responseIndex && completionPollIndex > cCreateIndex,
    "config C must become default after explicit A is accepted and before A is polled to completion");
  assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 1, "only the initial agent naming PATCH is allowed");
  assert.equal(fake.agents.size, 0); assert.ok([...fake.files.values()].every(Boolean));
});

test("sacrificial spike fails closed unless explicit A is active before mutating the default to C", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: async (input, init = {}) => {
    const url = new URL(input);
    if (init.method === "POST" && url.pathname === "/v2/responses") {
      await fake.fetch(input, init);
      return new Response(JSON.stringify({ id: "response-1", status: "completed", model: "agent-completed" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fake.fetch(input, init);
  }, apiKey: "test-key" });
  await assert.rejects(
    spikeExplicitConfigPin({ manifest, api, pdfBytes: new Uint8Array([37]), runId: "inactive", pollIntervalMs: 0, sleep: async () => {} }),
    /was not active before the default changed to C/,
  );
  assert.equal(fake.agents.size, 0); assert.ok([...fake.files.values()].every(Boolean));
});

test("sacrificial spike still deletes its agent when file deletion fails", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: async (input, init = {}) => {
    const url = new URL(input);
    if (init.method === "DELETE" && /^\/v2\/files\//.test(url.pathname)) return new Response(JSON.stringify({ error: "file cleanup failed" }), { status: 500, headers: { "content-type": "application/json" } });
    return fake.fetch(input, init);
  }, apiKey: "test-key" });
  await assert.rejects(
    spikeExplicitConfigPin({ manifest, api, pdfBytes: new Uint8Array([37]), runId: "file-delete-fails", pollIntervalMs: 0, sleep: async () => {} }),
    (error) => error instanceof AggregateError && error.cleanup.status === "delete_failed" && error.rollback.status === "restored" && /files\//.test(error.message),
  );
  assert.equal(fake.agents.size, 0);
  assert.ok(fake.calls.some((call) => call.method === "DELETE" && /^\/v2\/agents\//.test(call.path)));
});

test("sacrificial spike reports agent deletion failure after attempting file cleanup", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: async (input, init = {}) => {
    const url = new URL(input);
    if (init.method === "DELETE" && /^\/v2\/agents\//.test(url.pathname)) return new Response(JSON.stringify({ error: "agent rollback failed" }), { status: 500, headers: { "content-type": "application/json" } });
    return fake.fetch(input, init);
  }, apiKey: "test-key" });
  await assert.rejects(
    spikeExplicitConfigPin({ manifest, api, pdfBytes: new Uint8Array([37]), runId: "agent-delete-fails", pollIntervalMs: 0, sleep: async () => {} }),
    (error) => error instanceof AggregateError && error.cleanup.status === "deleted" && error.rollback.status === "delete_failed" && /agents\//.test(error.message),
  );
  assert.ok([...fake.files.values()].every(Boolean));
  assert.equal(fake.agents.size, 1);
});

test("readiness receipt fails closed without all exact successful cleaned proofs and fresh DB health", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: fake.fetch, apiKey: "test-key" });
  const artifact = await applyProvision({ manifest, api, runId: "receipt" });
  const smoke = await smokeProvision({ manifest, artifact, api, pdfBytes: new Uint8Array([37, 80, 68, 70]), pollIntervalMs: 0, sleep: async () => {} });
  const dbHealth = { ready: true, recoveryPolicy: "cleanup-only-v1", cleanupMigrationVersion: "studio-cleanup-control-v1", checkedAt: "2026-08-22T11:55:00.000Z" };
  const evidence = configPinEvidence(artifact);
  const receipt = createReadinessReceipt({ manifest, artifact, smoke, dbHealth, credentialScope: localhostScope(), configPinEvidence: evidence, now: Date.parse("2026-08-22T12:00:00.000Z") });
  assert.equal(Object.keys(receipt.workflows).length, 6);
  assert.equal(receipt.workflows.기타.servedIdentityField, "model");
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.scope, "localhost-development");
  assert.equal(receipt.accountId, "localhost-development");
  assert.equal(receipt.configPinProof, "documented-explicit-config-pin/v1");
  assert.equal(receipt.servedConfigEchoVerified, false);
  assert.equal(receipt.servedAgentVerified, true);
  assert.equal(receipt.sweeper.recoveryPolicy, "cleanup-only-v1");
  const partial = structuredClone(smoke); delete partial.proofs.기타;
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke: partial, dbHealth, credentialScope: localhostScope(), configPinEvidence: evidence, now: Date.parse("2026-08-22T12:00:00.000Z") }), /successful, cleaned smoke proof/);
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke, dbHealth: { ...dbHealth, checkedAt: "2026-08-22T11:00:00.000Z" }, credentialScope: localhostScope(), configPinEvidence: evidence, now: Date.parse("2026-08-22T12:00:00.000Z") }), /fresh DB cleanup proof/);
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke, dbHealth: { ...dbHealth, recoveryPolicy: "resume-response-v1" }, credentialScope: localhostScope(), configPinEvidence: evidence, now: Date.parse("2026-08-22T12:00:00.000Z") }), /healthy DB cleanup proof/);
  const nonExactPin = structuredClone(smoke);
  nonExactPin.proofs.기타.requestFields = { config_id: artifact.created.find((pin) => pin.kind === "기타").configId, config_external_id: "unverified" };
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke: nonExactPin, dbHealth, credentialScope: localhostScope(), configPinEvidence: evidence, now: Date.parse("2026-08-22T12:00:00.000Z") }), /successful, cleaned smoke proof/);
  const missingCreationFingerprint = structuredClone(smoke);
  delete missingCreationFingerprint.proofs.기타.createdConfigFingerprint;
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke: missingCreationFingerprint, dbHealth, credentialScope: localhostScope(), configPinEvidence: evidence, now: Date.parse("2026-08-22T12:00:00.000Z") }), /successful, cleaned smoke proof/);
  const ignored = structuredClone(evidence); ignored.spike.aResponse.stepNames = ["parse", "extract_other", "ignored"];
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke, dbHealth, credentialScope: localhostScope(), configPinEvidence: ignored, now: Date.parse("2026-08-22T12:00:00.000Z") }), /differential config-pin spike/);
  const drifted = structuredClone(evidence); drifted.spike.postConfigFingerprint = SHA("d");
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke, dbHealth, credentialScope: localhostScope(), configPinEvidence: drifted, now: Date.parse("2026-08-22T12:00:00.000Z") }), /differential config-pin spike/);
  const wrongDocs = structuredClone(evidence); wrongDocs.officialDocs.url = "https://example.com/studio/deployment.md";
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke, dbHealth, credentialScope: localhostScope(), configPinEvidence: wrongDocs, now: Date.parse("2026-08-22T12:00:00.000Z") }), /official documented config_id evidence/);
  const staleDocs = structuredClone(evidence); staleDocs.officialDocs.retrievedAt = "2026-08-21T11:59:59.000Z";
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke, dbHealth, credentialScope: localhostScope(), configPinEvidence: staleDocs, now: Date.parse("2026-08-22T12:00:00.000Z") }), /official documented config_id evidence/);
  const futureDocs = structuredClone(evidence); futureDocs.officialDocs.retrievedAt = "2026-08-22T12:00:00.001Z";
  assert.throws(() => createReadinessReceipt({ manifest, artifact, smoke, dbHealth, credentialScope: localhostScope(), configPinEvidence: futureDocs, now: Date.parse("2026-08-22T12:00:00.000Z") }), /official documented config_id evidence/);
});

test("normalizes the strict tbm-check ready health payload into the internal health receipt", () => {
  const producerHealth = { ready: true, recoveryPolicy: "cleanup-only-v1", cleanupMigrationVersion: "studio-cleanup-control-v1", checkedAt: "2026-08-22T11:55:00.000Z" };
  assert.deepEqual(normalizeDbHealth(producerHealth), { healthy: true, recoveryPolicy: "cleanup-only-v1", cleanupMigrationVersion: "studio-cleanup-control-v1", checkedAt: "2026-08-22T11:55:00.000Z" });
  assert.equal(normalizeDbHealth({ ...producerHealth, healthy: true }), null);
  assert.equal(normalizeDbHealth({ ...producerHealth, ready: false }), null);
  assert.equal(normalizeDbHealth({ healthy: true, recoveryPolicy: "cleanup-only-v1", cleanupMigrationVersion: "studio-cleanup-control-v1", checkedAt: "2026-08-22T11:55:00.000Z" }), null);
});

test("unknown final config shape fails closed", async () => {
  const api = makeApi({ apiKey: "test-key", fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
  await assert.rejects(applyProvision({ manifest, api, runId: "bad" }), /unknown response shape|missing (a )?stable id/i);
});

test("partial receipt owns an agent even when its config creation fails", async () => {
  const fake = fakeStudio();
  const api = makeApi({ fetch: async (input, init = {}) => {
    const url = new URL(input);
    if (init.method === "POST" && /\/configs$/.test(url.pathname)) {
      return new Response(JSON.stringify({ error: "bad schema" }), { status: 400 });
    }
    return fake.fetch(input, init);
  }, apiKey: "test-key" });
  await assert.rejects(
    applyProvision({ manifest, api, runId: "partial" }),
    (error) => error?.receipt?.created?.length === 0 && error?.receipt?.rollback?.length === 1,
  );
});
