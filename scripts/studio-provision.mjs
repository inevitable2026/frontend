#!/usr/bin/env node
/**
 * Deliberately small Studio provisioning adapter.  It is a separate operational
 * tool: the application never imports it and the canonical manifest stays
 * immutable.  The API paths mirror lib/agent/upstage-agent.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_BASE_URL = "https://api.upstage.ai/v2";
const DEPLOYMENT_DOC_URL = "https://console.upstage.ai/docs/studio/deployment.md";
const MAX_DOCS_AGE_MS = 24 * 60 * 60_000;
const SENSITIVE_KEY = /(authorization|api[_-]?key|token|content|document|base64|text|filename)/i;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : isRecord(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]))
    : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
const redact = (value) => Array.isArray(value)
  ? value.map(redact)
  : isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_KEY.test(key)).map(([key, child]) => [key, redact(child)]))
    : value;

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} has an unknown response shape.`);
  return value;
}
function requireId(value, label) {
  const record = requireRecord(value, label);
  if (typeof record.id !== "string" || !record.id) throw new Error(`${label} is missing a stable id.`);
  return record;
}
function parseManifest(manifest) {
  if (!isRecord(manifest) || !Array.isArray(manifest.contracts) || !isRecord(manifest.ownership)) throw new Error("Manifest has an unknown shape.");
  if (manifest.ownership.noAdoption !== true || typeof manifest.ownership.prefix !== "string" || !manifest.ownership.prefix) throw new Error("Manifest must require no-adoption ownership.");
  if (typeof manifest.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(manifest.fingerprint)) throw new Error("Manifest fingerprint is invalid.");
  const unsigned = { ...manifest }; delete unsigned.fingerprint;
  if (hash(unsigned) !== manifest.fingerprint) throw new Error("Manifest fingerprint does not match contents.");
  for (const contract of manifest.contracts) {
    if (!isRecord(contract) || typeof contract.kind !== "string" || typeof contract.agentLogicalName !== "string" || !Array.isArray(contract.steps) || contract.steps.length !== 2) throw new Error("Manifest contract has an unknown shape.");
    const steps = contract.steps;
    const expectedTypes = ["document-parse", "information-extract"];
    if (steps.some((step, index) => !isRecord(step) || step.type !== expectedTypes[index] || typeof step.logicalName !== "string" || !isRecord(step.data) || !Array.isArray(step.next_steps))) throw new Error(`Manifest contract ${contract.kind} is malformed.`);
    if (steps.filter((step) => step.is_first === true).length !== 1 || steps[0].is_first !== true) throw new Error(`Manifest contract ${contract.kind} has no deterministic first step.`);
    for (let index = 0; index < steps.length; index += 1) {
      const targets = steps[index].next_steps.map((edge) => isRecord(edge) ? edge.step_name : null);
      const expected = index === steps.length - 1 ? [] : [steps[index + 1].logicalName];
      if (JSON.stringify(targets) !== JSON.stringify(expected)) throw new Error(`Manifest contract ${contract.kind} is not a two-step Studio chain.`);
    }
  }
  return manifest;
}
function slug(value) { return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "workflow"; }
function configFingerprint(config) {
  const record = requireId(config, "Config create response");
  if (!Array.isArray(record.steps) || record.steps.length !== 2) throw new Error("Config create response is missing two steps.");
  return hash({ id: record.id, external_id: record.external_id ?? null, agent_id: record.agent_id ?? null, steps: record.steps });
}
function assertPinnedConfig(config, agentId, contract) {
  const record = requireId(config, `Config ${contract.kind} response`);
  if (record.agent_id !== undefined && record.agent_id !== agentId) throw new Error(`Config ${contract.kind} is bound to a different agent.`);
  if (!Array.isArray(record.steps) || record.steps.length !== contract.steps.length) throw new Error(`Config ${contract.kind} has an unexpected Studio graph.`);
  for (let index = 0; index < contract.steps.length; index += 1) {
    const actual = record.steps[index]; const expected = contract.steps[index];
    if (!isRecord(actual) || actual.name !== expected.logicalName || actual.type !== expected.type || actual.is_first !== expected.is_first) {
      throw new Error(`Config ${contract.kind} does not preserve the pinned Studio step contract.`);
    }
    const actualTargets = Array.isArray(actual.next_steps) ? actual.next_steps.map((edge) => isRecord(edge) ? edge.step_name : null) : null;
    const expectedTargets = expected.next_steps.map((edge) => edge.step_name);
    if (!actualTargets || JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) throw new Error(`Config ${contract.kind} has an unexpected Studio graph.`);
  }
}
function nonEmptyString(value) { return typeof value === "string" && value.trim().length > 0; }
function isoDate(value) { return nonEmptyString(value) && Number.isFinite(Date.parse(value)); }
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function exactRecord(value, keys) { return isRecord(value) && Object.keys(value).every((key) => keys.includes(key)); }
function credentialScope(value) {
  if (!exactRecord(value, ["scheme", "keyFingerprint", "inventoryDigest", "endpoint", "observedAt", "requestId"])) return null;
  if (value.scheme !== "credential-scope/v1" || !/^sha256:[a-f0-9]{64}$/.test(value.keyFingerprint) || !/^sha256:[a-f0-9]{64}$/.test(value.inventoryDigest) || !isoDate(value.observedAt)) return null;
  let endpoint; try { endpoint = new URL(value.endpoint); } catch { return null; }
  if (endpoint.protocol !== "https:") return null;
  if (value.requestId !== undefined && !nonEmptyString(value.requestId)) return null;
  return value;
}
function officialDocs(value, now = Date.now()) {
  if (!exactRecord(value, ["url", "sha256", "retrievedAt"]) || !/^sha256:[a-f0-9]{64}$/.test(value.sha256) || !isoDate(value.retrievedAt)) return null;
  const retrievedAt = Date.parse(value.retrievedAt);
  return value.url === DEPLOYMENT_DOC_URL && retrievedAt <= now && retrievedAt >= now - MAX_DOCS_AGE_MS ? value : null;
}
export function normalizeDbHealth(value) {
  if (!exactRecord(value, ["ready", "recoveryPolicy", "cleanupMigrationVersion", "checkedAt"]) || value.ready !== true || value.recoveryPolicy !== "cleanup-only-v1" || !nonEmptyString(value.cleanupMigrationVersion) || !isoDate(value.checkedAt)) {
    return null;
  }
  return { healthy: true, recoveryPolicy: value.recoveryPolicy, cleanupMigrationVersion: value.cleanupMigrationVersion, checkedAt: value.checkedAt };
}
function differentialSpike(value) {
  if (!exactRecord(value, ["scheme", "configAId", "configBId", "configCId", "preConfigFingerprint", "postConfigFingerprint", "aResponse", "bDefaultMutation", "cDefaultMutation", "cleanup", "rollback"])) return null;
  if (value.scheme !== "sacrificial-differential-config-pin/v1" || !nonEmptyString(value.configAId) || !nonEmptyString(value.configBId) || !nonEmptyString(value.configCId) || new Set([value.configAId, value.configBId, value.configCId]).size !== 3 || !nonEmptyString(value.preConfigFingerprint) || value.preConfigFingerprint !== value.postConfigFingerprint) return null;
  const response = value.aResponse;
  if (!exactRecord(response, ["agentId", "initialStatus", "stepNames", "status"]) || !nonEmptyString(response.agentId) || !["queued", "in_progress"].includes(response.initialStatus) || response.status !== "completed" || !Array.isArray(response.stepNames) || response.stepNames.length !== 2 || response.stepNames.some((step) => !nonEmptyString(step))) return null;
  if (!exactRecord(value.bDefaultMutation, ["scheme", "beforeDefaultConfigId", "afterDefaultConfigId", "observedVia"]) || value.bDefaultMutation.scheme !== "config-create-default-observation/v1" || value.bDefaultMutation.beforeDefaultConfigId !== value.configAId || value.bDefaultMutation.afterDefaultConfigId !== value.configBId || value.bDefaultMutation.observedVia !== "authenticated-agent-get/v1") return null;
  if (!exactRecord(value.cDefaultMutation, ["scheme", "beforeDefaultConfigId", "afterDefaultConfigId", "responseStatusBeforeMutation", "observedVia"]) || value.cDefaultMutation.scheme !== "config-create-default-observation/v1" || value.cDefaultMutation.beforeDefaultConfigId !== value.configBId || value.cDefaultMutation.afterDefaultConfigId !== value.configCId || value.cDefaultMutation.responseStatusBeforeMutation !== response.initialStatus || value.cDefaultMutation.observedVia !== "authenticated-agent-get/v1") return null;
  if (!exactRecord(value.cleanup, ["status"]) || value.cleanup.status !== "deleted" || !exactRecord(value.rollback, ["status"]) || value.rollback.status !== "restored") return null;
  return value;
}
function requiredPins(artifact, manifest) {
  if (!isRecord(artifact) || artifact.mode !== "apply" || artifact.manifestSha !== manifest.fingerprint || !Array.isArray(artifact.created)) {
    throw new Error("Pinned apply artifact does not match the current manifest.");
  }
  const byKind = new Map();
  for (const pin of artifact.created) {
    if (!isRecord(pin) || !nonEmptyString(pin.kind) || !nonEmptyString(pin.agentId) || !nonEmptyString(pin.configId) || !nonEmptyString(pin.configFingerprint)) {
      throw new Error("Pinned apply artifact has an unknown workflow identity.");
    }
    if (byKind.has(pin.kind)) throw new Error(`Pinned apply artifact duplicates ${pin.kind}.`);
    byKind.set(pin.kind, pin);
  }
  if (byKind.size !== manifest.contracts.length || manifest.contracts.some((contract) => !byKind.has(contract.kind))) {
    throw new Error("Pinned apply artifact must contain every manifest workflow exactly once.");
  }
  return byKind;
}

export function makeApi({ fetch: fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, apiKey }) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "localhost") throw new Error("Studio API base URL must use HTTPS.");
  if (!apiKey) throw new Error("UPSTAGE_API_KEY is required; it is never read from a file.");
  const request = async (path, init = {}) => {
    const response = await fetchImpl(new URL(path, `${base.href.replace(/\/$/, "")}/`).href, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(init.headers ?? {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Studio API ${init.method ?? "GET"} ${path} failed (${response.status}).`);
    return body;
  };
  return {
    listAgents: async () => { const body = requireRecord(await request("agents"), "Agent list response"); if (!Array.isArray(body.data)) throw new Error("Agent list response has an unknown shape."); return body.data.map((agent) => requireId(agent, "Agent list item")); },
    getCredentialScope: async () => {
      const inventory = []; const cursors = new Set(); let cursor;
      let requestId;
      for (let page = 0; page < 100; page += 1) {
        const path = cursor ? `agents?cursor=${encodeURIComponent(cursor)}` : "agents";
        const response = await fetchImpl(new URL(path, `${base.href.replace(/\/$/, "")}/`).href, { headers: { Authorization: `Bearer ${apiKey}` } });
        const body = requireRecord(await response.json().catch(() => null), "Agent list response");
        if (!response.ok) throw new Error(`Studio API GET ${path} failed (${response.status}).`);
        requestId ??= response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
        if (!Array.isArray(body.data)) throw new Error("Agent list response has an unknown shape.");
        inventory.push(...body.data.map((agent) => requireId(agent, "Agent list item")));
        const next = nonEmptyString(body.next_cursor) ? body.next_cursor : nonEmptyString(body.nextCursor) ? body.nextCursor : undefined;
        const more = body.has_more === true || body.hasMore === true;
        if (!more && !next) return { scheme: "credential-scope/v1", keyFingerprint: sha256(apiKey), inventoryDigest: sha256(JSON.stringify(canonicalize(inventory))), endpoint: new URL("agents", `${base.href.replace(/\/$/, "")}/`).href, observedAt: new Date().toISOString(), ...(requestId ? { requestId } : {}) };
        if (!next || cursors.has(next)) throw new Error("Agent inventory pagination is incomplete or repeated.");
        cursors.add(next); cursor = next;
      }
      throw new Error("Agent inventory page limit exceeded.");
    },
    getAgent: async (id) => requireId(await request(`agents/${encodeURIComponent(id)}`), "Agent get response"),
    createAgent: async (name, description) => {
      const created = requireId(await request("agents", { method: "POST", body: JSON.stringify({}) }), "Agent create response");
      return requireId(await request(`agents/${encodeURIComponent(created.id)}`, { method: "PATCH", body: JSON.stringify({ name, description }) }), "Agent update response");
    },
    patchAgent: async (id, patch) => requireId(await request(`agents/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }), "Agent patch response"),
    createConfig: async (agentId, steps) => requireId(await request(
      `agents/${encodeURIComponent(agentId)}/configs`,
      { method: "POST", body: JSON.stringify({ steps }) },
    ), "Config create response"),
    listConfigs: async (agentId) => {
      const body = requireRecord(await request(`agents/${encodeURIComponent(agentId)}/configs`), "Config list response");
      if (!Array.isArray(body.data)) throw new Error("Config list response has an unknown shape.");
      return body.data.map((config) => requireId(config, "Config list item"));
    },
    deleteAgent: async (id) => { await request(`agents/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    uploadFile: async (bytes, filename) => {
      const form = new FormData(); form.append("file", new Blob([bytes], { type: "application/pdf" }), filename); form.append("purpose", "user_data");
      return requireId(await request("files", { method: "POST", body: form }), "File upload response");
    },
    deleteFile: async (id) => { await request(`files/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    createResponse: async (agentId, fileId, configId) => requireId(await request("responses", { method: "POST", body: JSON.stringify({ model: agentId, config_id: configId, include: ["all"], input: [{ role: "user", content: [{ type: "input_file", file_id: fileId }] }] }) }), "Response create response"),
    getResponse: async (id) => requireId(await request(`responses/${encodeURIComponent(id)}?include[]=all`), "Response get response"),
  };
}

/**
 * Executes a destructive-but-sacrificial differential proof. The public API
 * does not document a default-config mutation endpoint, so the spike records
 * only what authenticated Agent GETs observe: creating B makes B the default,
 * then creating C while an explicit-A response is active makes C the default.
 * A failed or inconclusive spike returns no readiness-compatible proof.
 */
export async function spikeExplicitConfigPin({ manifest, api, pdfBytes, runId = randomUUID().replace(/-/g, "").slice(0, 12), pollLimit = 160, pollIntervalMs = 1_500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const parsed = parseManifest(manifest); const contract = parsed.contracts[0];
  if (!(pdfBytes instanceof Uint8Array) || !pdfBytes.length) throw new Error("Spike requires a non-empty synthetic PDF.");
  const name = `${parsed.ownership.prefix}-spike-${runId}`; let agent; let fileId; let proof;
  const cleanup = { status: "not_started" }; const rollback = { status: "not_started" };
  let primaryError; const errors = [];
  try {
    agent = await api.createAgent(name, `[${parsed.ownership.marker}; spike=${runId}] sacrificial differential config pin proof`);
    const createSacrificialConfig = async (suffix) => {
      const steps = contract.steps.map((step) => ({ ...step, logicalName: `${step.logicalName}_spike_${suffix}`, next_steps: step.next_steps.map((edge) => ({ ...edge, step_name: `${edge.step_name}_spike_${suffix}` })) }));
      const config = await api.createConfig(agent.id, stepsFor({ ...contract, steps }));
      assertPinnedConfig(config, agent.id, { ...contract, steps });
      return config;
    };
    const readConfig = async (id) => {
      const found = (await api.listConfigs(agent.id)).filter((config) => config.id === id);
      if (found.length !== 1) throw new Error("Spike cannot retrieve exactly one sacrificial config after mutation.");
      return found[0];
    };
    const assertObservedDefault = async (config, label) => {
      const observed = await api.getAgent(agent.id);
      if (observed.default_config_id !== config.id || observed.default_config_external_id !== config.external_id) {
        throw new Error(`Spike Agent GET did not observe config ${label} as the default after creation.`);
      }
    };
    const a = await createSacrificialConfig("a");
    await assertObservedDefault(a, "A");
    const b = await createSacrificialConfig("b");
    await assertObservedDefault(b, "B");
    const preConfigFingerprint = configFingerprint(await readConfig(a.id));
    fileId = (await api.uploadFile(pdfBytes, "sacrificial-config-pin.pdf")).id;
    const response = await api.createResponse(agent.id, fileId, a.id);
    if (!["queued", "in_progress"].includes(response.status)) throw new Error("Spike explicit-A response was not active before the default changed to C.");
    const c = await createSacrificialConfig("c");
    await assertObservedDefault(c, "C");
    let final = response;
    for (let attempt = 0; attempt < pollLimit && ["queued", "in_progress"].includes(final.status); attempt += 1) { await sleep(pollIntervalMs); final = await api.getResponse(response.id); }
    if (final.status !== "completed" || final.model !== agent.id || !Array.isArray(final.output)) throw new Error("Spike explicit-A response was not completed for the sacrificial agent.");
    const stepNames = final.output.map((output) => isRecord(output) && nonEmptyString(output.model) ? output.model : null);
    const expectedA = a.steps.map((step) => step.name);
    if (stepNames.some((step) => step === null) || JSON.stringify([...stepNames].sort()) !== JSON.stringify([...expectedA].sort())) throw new Error("Spike did not prove explicit config A output while default was B.");
    const postConfigFingerprint = configFingerprint(await readConfig(a.id));
    if (preConfigFingerprint !== postConfigFingerprint) throw new Error("Spike config A drifted while defaults changed.");
    proof = { scheme: "sacrificial-differential-config-pin/v1", configAId: a.id, configBId: b.id, configCId: c.id, preConfigFingerprint, postConfigFingerprint, aResponse: { agentId: agent.id, initialStatus: response.status, stepNames, status: "completed" }, bDefaultMutation: { scheme: "config-create-default-observation/v1", beforeDefaultConfigId: a.id, afterDefaultConfigId: b.id, observedVia: "authenticated-agent-get/v1" }, cDefaultMutation: { scheme: "config-create-default-observation/v1", beforeDefaultConfigId: b.id, afterDefaultConfigId: c.id, responseStatusBeforeMutation: response.status, observedVia: "authenticated-agent-get/v1" } };
  } catch (error) {
    primaryError = error;
  } finally {
    if (fileId) {
      try { await api.deleteFile(fileId); cleanup.status = "deleted"; }
      catch (error) { cleanup.status = "delete_failed"; errors.push(error); }
    }
    if (agent) {
      try { await api.deleteAgent(agent.id); rollback.status = "restored"; }
      catch (error) { rollback.status = "delete_failed"; errors.push(error); }
    }
  }
  if (primaryError) errors.unshift(primaryError);
  if (errors.length) {
    const error = new AggregateError(errors, `Spike failed: ${errors.map((cause) => cause instanceof Error ? cause.message : String(cause)).join("; ")}`);
    error.cleanup = cleanup; error.rollback = rollback;
    throw error;
  }
  if (!proof || cleanup.status !== "deleted" || rollback.status !== "restored") throw new Error("Spike did not complete cleanup and rollback.");
  return { ...proof, cleanup, rollback };
}

function stepsFor(contract) {
  return contract.steps.map((step) => ({ name: step.logicalName, type: step.type, is_first: step.is_first, data: step.data, next_steps: step.next_steps.map((edge) => ({ step_name: edge.step_name })) }));
}
function receiptBase(manifest, mode, runId) { return { schemaVersion: 1, mode, createdAt: new Date().toISOString(), runId, manifestSha: manifest.fingerprint, ownershipMarker: manifest.ownership.marker, ownershipPrefix: manifest.ownership.prefix, redacted: true }; }
function writeJson(path, value) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, `${JSON.stringify(redact(value), null, 2)}\n`, { mode: 0o600 }); }

export async function planProvision({ manifest, api, runId = "plan" }) {
  const parsed = parseManifest(manifest);
  const inventory = await api.listAgents();
  const exactNames = new Set(inventory.map((agent) => agent.name).filter((name) => typeof name === "string"));
  return { ...receiptBase(parsed, "plan", runId), operations: parsed.contracts.map((contract) => {
    const physicalName = `${parsed.ownership.prefix}-${runId}-${slug(contract.agentLogicalName)}`;
    return { logicalName: contract.agentLogicalName, kind: contract.kind, physicalName, action: exactNames.has(physicalName) ? "collision" : "create", steps: contract.steps.map((step) => step.logicalName) };
  }) };
}

export async function applyProvision({ manifest, api, runId = randomUUID().replace(/-/g, "").slice(0, 12) }) {
  const parsed = parseManifest(manifest);
  const plan = await planProvision({ manifest: parsed, api, runId });
  if (plan.operations.some((operation) => operation.action !== "create")) throw new Error("Provisioning refused: a generated physical name already exists and will never be adopted.");
  const receipt = { ...receiptBase(parsed, "apply", runId), before: { agentCount: (await api.listAgents()).length }, created: [], rollback: [] };
  try {
    for (const contract of parsed.contracts) {
      const physicalName = `${parsed.ownership.prefix}-${runId}-${slug(contract.agentLogicalName)}`;
      const agent = await api.createAgent(physicalName, `[${parsed.ownership.marker}; run=${runId}] ${contract.description}`);
      // Record ownership immediately. Config creation/validation can fail after
      // the remote agent exists, and the partial receipt must still be able to
      // prove and roll that exact resource back.
      receipt.rollback.push({ resource: "agent", id: agent.id, expectedName: physicalName, status: "pending" });
      const config = await api.createConfig(agent.id, stepsFor(contract));
      assertPinnedConfig(config, agent.id, contract);
      const pin = { logicalName: contract.agentLogicalName, kind: contract.kind, agentId: agent.id, agentName: physicalName, configId: config.id, configExternalId: typeof config.external_id === "string" ? config.external_id : null, configFingerprint: configFingerprint(config), stepIds: Object.fromEntries(config.steps.map((step) => [step.name, step.id])) };
      receipt.created.push(pin);
    }
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : "Unknown provisioning error";
    receipt.after = { createdCount: receipt.created.length };
    throw Object.assign(new Error(`Provisioning failed: ${receipt.error}; use the partial receipt to roll back only created agents.`), { receipt });
  }
  receipt.after = { createdCount: receipt.created.length, configFingerprints: receipt.created.map((item) => item.configFingerprint) };
  return receipt;
}

export async function rollbackProvision({ receipt, api }) {
  if (!isRecord(receipt) || receipt.mode !== "apply" || !Array.isArray(receipt.rollback) || typeof receipt.runId !== "string" || typeof receipt.ownershipMarker !== "string" || typeof receipt.ownershipPrefix !== "string") throw new Error("Rollback receipt has an unknown shape.");
  const result = { schemaVersion: 1, mode: "rollback", sourceRunId: receipt.runId, createdAt: new Date().toISOString(), redacted: true, resources: [] };
  for (const entry of receipt.rollback) {
    if (!isRecord(entry) || entry.resource !== "agent" || typeof entry.id !== "string" || typeof entry.expectedName !== "string") throw new Error("Rollback receipt contains an unknown resource.");
    const agent = await api.getAgent(entry.id);
    if (
      agent.name !== entry.expectedName ||
      !agent.name.startsWith(`${receipt.ownershipPrefix}-${receipt.runId}-`) ||
      typeof agent.description !== "string" ||
      !agent.description.includes(`[${receipt.ownershipMarker}; run=${receipt.runId}]`)
    ) throw new Error(`Rollback refused: agent ${entry.id} does not prove receipt ownership.`);
    await api.deleteAgent(entry.id);
    result.resources.push({ resource: "agent", id: entry.id, status: "deleted" });
  }
  return result;
}

export async function smokeProvision({
  manifest,
  artifact,
  api,
  pdfBytes,
  filename = "synthetic.pdf",
  pollLimit = 160,
  pollIntervalMs = 1_500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.length === 0) throw new Error("Smoke mode requires a non-empty synthetic PDF byte stream.");
  const parsed = parseManifest(manifest);
  const pins = requiredPins(artifact, parsed);
  const receipt = { schemaVersion: 1, mode: "smoke", createdAt: new Date().toISOString(), manifestSha: parsed.fingerprint, sourceRunId: artifact.runId, redacted: true, proofs: {} };
  for (const contract of parsed.contracts) {
    const target = pins.get(contract.kind);
    // The responses API evidence available to this adapter echoes `model`, but
    // not the selected config.  Keep the exact request pin as evidence, while
    // deliberately not claiming that the completed response atomically echoed
    // or otherwise proved the config it executed.
    const proof = { agentId: target.agentId, configId: target.configId, createdConfigFingerprint: target.configFingerprint, servedIdentity: null, servedIdentityField: "model", requestFields: { config_id: target.configId }, remoteStepNames: [], outputsRetrieved: 0, cleanup: "not_started" };
    receipt.proofs[contract.kind] = proof;
    let fileId;
    let primaryError;
    try {
      const file = await api.uploadFile(pdfBytes, filename); fileId = file.id;
      const response = await api.createResponse(target.agentId, fileId, target.configId);
      let final = response;
      for (let attempt = 0; attempt < pollLimit && ["queued", "in_progress"].includes(final.status); attempt += 1) {
        await sleep(pollIntervalMs);
        final = await api.getResponse(response.id);
      }
      if (final.status !== "completed" || !Array.isArray(final.output)) throw new Error(`Smoke ${contract.kind} did not complete successfully.`);
      if (final.model !== target.agentId) throw new Error(`Smoke ${contract.kind} served a different agent identity.`);
      const remoteStepNames = final.output.map((output) => isRecord(output) && nonEmptyString(output.model) ? output.model : null);
      if (remoteStepNames.some((name) => name === null)) throw new Error(`Smoke ${contract.kind} output is missing its Studio model step name.`);
      const expectedSteps = contract.steps.map((step) => step.logicalName);
      if (new Set(remoteStepNames).size !== remoteStepNames.length || JSON.stringify([...remoteStepNames].sort()) !== JSON.stringify([...expectedSteps].sort())) {
        throw new Error(`Smoke ${contract.kind} did not return the exact pinned Studio Parse -> Extract steps.`);
      }
      proof.servedIdentity = final.model;
      proof.remoteStepNames = remoteStepNames;
      proof.outputsRetrieved = final.output.length;
      proof.status = final.status;
    } catch (error) {
      primaryError = error;
    } finally {
      if (fileId) {
        try { await api.deleteFile(fileId); proof.cleanup = "deleted"; }
        catch (cleanupError) { proof.cleanup = "delete_failed"; if (!primaryError) primaryError = cleanupError; }
      }
    }
    if (primaryError) {
      receipt.error = primaryError instanceof Error ? primaryError.message : "Unknown smoke failure";
      throw Object.assign(primaryError, { receipt });
    }
  }
  return receipt;
}

/** Creates the only receipt accepted by live-readiness.ts. It intentionally
 * accepts a DB health proof as an explicit input rather than reading a DB. */
export function createReadinessReceipt({ manifest, artifact, smoke, dbHealth, credentialScope: scope, configPinEvidence, projectIdentity, now = Date.now(), ttlMs = 60 * 60_000 }) {
  const parsed = parseManifest(manifest);
  const pins = requiredPins(artifact, parsed);
  if (!isRecord(smoke) || smoke.mode !== "smoke" || smoke.manifestSha !== parsed.fingerprint || !isRecord(smoke.proofs)) {
    throw new Error("Readiness requires a complete smoke receipt for the current manifest.");
  }
  const normalizedDbHealth = normalizeDbHealth(dbHealth);
  if (!normalizedDbHealth) {
    throw new Error("Readiness requires an explicit healthy DB cleanup proof.");
  }
  if (Date.parse(normalizedDbHealth.checkedAt) > now + 60_000 || Date.parse(normalizedDbHealth.checkedAt) < now - 15 * 60_000) {
    throw new Error("Readiness requires a fresh DB cleanup proof.");
  }
  const localScope = credentialScope(scope);
  const projectScope = exactRecord(projectIdentity, ["scheme", "projectId", "endpoint", "observedAt", "requestId"]) && projectIdentity.scheme === "api-project-id/v1" && nonEmptyString(projectIdentity.projectId) && isoDate(projectIdentity.observedAt) ? projectIdentity : null;
  if (!localScope && !projectScope) throw new Error("Readiness requires an api-project-id/v1 proof or credential-scope/v1 localhost proof.");
  const docs = officialDocs(configPinEvidence?.officialDocs, now);
  const spike = differentialSpike(configPinEvidence?.spike);
  if (!docs || !spike) throw new Error("Readiness requires official documented config_id evidence and one sacrificial differential config-pin spike.");
  const workflows = {};
  for (const contract of parsed.contracts) {
    const pin = pins.get(contract.kind); const proof = smoke.proofs[contract.kind];
    if (!isRecord(proof) || proof.status !== "completed" || proof.cleanup !== "deleted" || proof.agentId !== pin.agentId || proof.configId !== pin.configId || proof.createdConfigFingerprint !== pin.configFingerprint || proof.servedIdentity !== pin.agentId || proof.servedIdentityField !== "model" || !isRecord(proof.requestFields) || JSON.stringify(proof.requestFields) !== JSON.stringify({ config_id: pin.configId }) || !Array.isArray(proof.remoteStepNames) || proof.outputsRetrieved !== contract.steps.length || JSON.stringify([...proof.remoteStepNames].sort()) !== JSON.stringify(contract.steps.map((step) => step.logicalName).sort())) {
      throw new Error(`Readiness requires a successful, cleaned smoke proof for ${contract.kind}.`);
    }
    workflows[contract.kind] = { agentId: pin.agentId, agentName: contract.agentLogicalName, configId: pin.configId, configFingerprint: pin.configFingerprint, servedIdentity: proof.servedIdentity, servedIdentityField: proof.servedIdentityField, requestFields: proof.requestFields };
  }
  const issuedAt = new Date(now).toISOString();
  return {
    schemaVersion: 3, receiptId: `studio-local-${artifact.runId}-${createHash("sha256").update(JSON.stringify(smoke.proofs)).digest("hex").slice(0, 12)}`,
    issuedAt, expiresAt: new Date(now + ttlMs).toISOString(), scope: projectScope ? "production-project" : "localhost-development", accountId: projectScope?.projectId ?? "localhost-development", projectIdentity: projectScope ?? undefined, credentialScope: localScope ?? undefined, topology: "per-kind-agent",
    physicalStudioSteps: ["document-parse", "information-extract"], runtimeOwnership: { studio: ["document-parse", "information-extract"], application: ["validation", "review"] },
    configPinProof: "documented-explicit-config-pin/v1", configPinEvidence: { officialDocs: docs, spike }, servedConfigEchoVerified: false, servedAgentVerified: true, manifestSha: parsed.fingerprint,
    outputEnvelopeVersion: parsed.outputEnvelopeVersion, responseParserVersion: parsed.responseParserVersion,
    cleanupMigrationVersion: normalizedDbHealth.cleanupMigrationVersion, cleanupMigrationVerified: true,
    sweeper: { healthy: true, checkedAt: normalizedDbHealth.checkedAt, recoveryPolicy: "cleanup-only-v1" },
    platformBudget: { maxDurationMs: 300_000, processingDeadlineMs: 240_000, cleanupReserveMs: 30_000, responseMarginMs: 15_000 }, workflows,
  };
}

function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function has(name) { return process.argv.includes(name); }
function load(path) { return JSON.parse(readFileSync(path, "utf8")); }
function usage(message) { if (message) console.error(message); console.error("Usage: node scripts/studio-provision.mjs [plan|--apply|rollback|smoke|scope|spike|evidence|readiness] [--artifact path] [--receipt path]; scope emits credential-scope/v1; spike requires --pdf; evidence requires --official-docs --spike; readiness requires --smoke --db-health --credential-scope --config-pin-evidence (or --project-identity for production)."); process.exitCode = 1; }

export async function main() {
  const mode = has("--apply") ? "apply" : process.argv[2] === "rollback" ? "rollback" : process.argv[2] === "smoke" ? "smoke" : process.argv[2] === "scope" ? "scope" : process.argv[2] === "spike" ? "spike" : process.argv[2] === "evidence" ? "evidence" : process.argv[2] === "readiness" ? "readiness" : "plan";
  if (mode === "apply" && process.argv[2] && !process.argv[2].startsWith("--")) throw new Error("Apply is enabled only by the explicit --apply flag.");
  const manifest = load(new URL("../lib/context/studio-manifest.json", import.meta.url));
  const artifactPath = argument("--artifact") ?? ".studio-provision/pins.json";
  const receiptPath = argument("--receipt") ?? ".studio-provision/receipt.json";
  if (mode === "readiness") {
    const smokePath = argument("--smoke"); const dbHealthPath = argument("--db-health"); const scopePath = argument("--credential-scope"); const evidencePath = argument("--config-pin-evidence"); const projectIdentityPath = argument("--project-identity");
    if (!smokePath || !dbHealthPath) throw new Error("Readiness mode requires --smoke and --db-health JSON proofs.");
    if ((!scopePath && !projectIdentityPath) || !evidencePath || (scopePath && projectIdentityPath)) throw new Error("Readiness mode requires exactly one of --credential-scope/--project-identity plus --config-pin-evidence.");
    const receipt = createReadinessReceipt({ manifest, artifact: load(artifactPath), smoke: load(smokePath), dbHealth: load(dbHealthPath), credentialScope: scopePath ? load(scopePath) : undefined, projectIdentity: projectIdentityPath ? load(projectIdentityPath) : undefined, configPinEvidence: load(evidencePath) });
    writeJson(receiptPath, receipt);
    console.log(JSON.stringify({ mode: "readiness", receipt: resolve(receiptPath), manifestSha: receipt.manifestSha, workflowCount: Object.keys(receipt.workflows).length, redacted: true }, null, 2));
    return;
  }
  if (mode === "evidence") {
    const docsPath = argument("--official-docs"); const spikePath = argument("--spike");
    if (!docsPath || !spikePath) throw new Error("Evidence mode requires --official-docs and --spike JSON files.");
    const docsProof = load(docsPath); const spike = load(spikePath);
    if (!officialDocs(docsProof) || !differentialSpike(spike)) throw new Error("Evidence inputs do not form a documented differential config-pin proof.");
    writeJson(receiptPath, { officialDocs: docsProof, spike }); console.log(JSON.stringify({ mode: "evidence", receipt: resolve(receiptPath), redacted: true }, null, 2));
    return;
  }
  const api = makeApi({ apiKey: process.env.UPSTAGE_API_KEY, baseUrl: argument("--base-url") ?? DEFAULT_BASE_URL });
  if (mode === "plan") console.log(JSON.stringify(await planProvision({ manifest, api, runId: argument("--run-id") ?? "plan" }), null, 2));
  else if (mode === "apply") { const receipt = await applyProvision({ manifest, api, runId: argument("--run-id") }); writeJson(artifactPath, receipt); writeJson(receiptPath, receipt); console.log(JSON.stringify({ mode: "apply", artifact: resolve(artifactPath), receipt: resolve(receiptPath), redacted: true }, null, 2)); }
  else if (mode === "rollback") { const result = await rollbackProvision({ receipt: load(argument("--receipt") ?? ""), api }); writeJson(argument("--rollback-receipt") ?? ".studio-provision/rollback-receipt.json", result); console.log(JSON.stringify(result, null, 2)); }
  else if (mode === "scope") { const result = await api.getCredentialScope(); writeJson(receiptPath, result); console.log(JSON.stringify({ mode: "scope", receipt: resolve(receiptPath), redacted: true }, null, 2)); }
  else if (mode === "spike") { const pdf = argument("--pdf"); if (!pdf) throw new Error("Spike mode requires --pdf."); const result = await spikeExplicitConfigPin({ manifest, api, pdfBytes: new Uint8Array(readFileSync(pdf)), runId: argument("--run-id") }); writeJson(receiptPath, result); console.log(JSON.stringify({ mode: "spike", receipt: resolve(receiptPath), redacted: true }, null, 2)); }
  else { const pdf = argument("--pdf"); if (!pdf) throw new Error("Smoke mode requires --pdf containing a synthetic PDF."); const result = await smokeProvision({ manifest, artifact: load(artifactPath), api, pdfBytes: new Uint8Array(readFileSync(pdf)), filename: "synthetic.pdf" }); writeJson(receiptPath, result); console.log(JSON.stringify({ mode: "smoke", receipt: resolve(receiptPath), redacted: true }, null, 2)); }
}

export function runCli() {
  return main().catch((error) => { if (error?.receipt) writeJson(argument("--receipt") ?? ".studio-provision/partial-receipt.json", error.receipt); usage(error instanceof Error ? error.message : String(error)); });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) runCli();
