#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../lib/context/studio-manifest.json", import.meta.url), "utf8"));
const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
const fingerprint = (value) => { const unsigned = { ...value }; delete unsigned.fingerprint; return createHash("sha256").update(JSON.stringify(canonicalize(unsigned))).digest("hex"); };
const REDACTED_KEY = /(authorization|api[_-]?key|token|content|document|base64|attendee|amount|filename)/i;
const redact = (value) => Array.isArray(value) ? value.map(redact) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !REDACTED_KEY.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, redact(child)])) : value;

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.contracts) || value.contracts.length !== 6) throw new Error("Invalid Studio manifest.");
  if (value.ownership?.noAdoption !== true || !value.ownership.marker) throw new Error("Manifest must prohibit adoption with an ownership marker.");
  if (fingerprint(value) !== value.fingerprint) throw new Error("Manifest SHA does not match contents.");
  const kinds = new Set();
  for (const contract of value.contracts) {
    if (!contract.kind || kinds.has(contract.kind) || !Array.isArray(contract.steps) || contract.steps.length !== 2) throw new Error("Invalid document contract.");
    kinds.add(contract.kind);
    const names = new Set(contract.steps.map((step) => step.logicalName));
    if (names.size !== 2 || contract.steps.filter((step) => step.is_first).length !== 1 || contract.steps[0].type !== "document-parse" || contract.steps[1].type !== "information-extract") throw new Error(`Invalid graph for ${contract.kind}.`);
    for (let index = 0; index < contract.steps.length; index += 1) {
      const expected = index === 1 ? [] : [contract.steps[index + 1].logicalName];
      if (JSON.stringify(contract.steps[index].next_steps?.map((edge) => edge.step_name)) !== JSON.stringify(expected)) throw new Error(`Graph must be Studio Parse -> Extract for ${contract.kind}.`);
    }
  }
}
function plan(inventory) {
  const byName = new Map();
  for (const agent of inventory) {
    if (!agent || typeof agent.id !== "string" || typeof agent.name !== "string") throw new Error("Malformed Studio inventory agent.");
    byName.set(agent.name, [...(byName.get(agent.name) ?? []), agent]);
  }
  return manifest.contracts.map((contract) => {
    const found = byName.get(contract.agentLogicalName) ?? [];
    if (found.length === 0) return { kind: contract.kind, action: "create", reason: "missing owned resource" };
    if (found.length > 1) return { kind: contract.kind, action: "collision", reason: "duplicate logical name" };
    if (found[0].ownershipMarker !== manifest.ownership.marker) return { kind: contract.kind, action: "collision", reason: "pre-existing name match is not adopted" };
    if (!contract.expectedConfigFingerprint || found[0].configFingerprint !== contract.expectedConfigFingerprint) return { kind: contract.kind, action: "drift", reason: "immutable config fingerprint missing or mismatched" };
    return { kind: contract.kind, action: "noop", reason: "owned config fingerprint matches" };
  });
}
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function has(name) { return process.argv.includes(name); }
function inventoryFrom(path) { return path ? JSON.parse(readFileSync(path, "utf8")) : []; }
function usage(message) { if (message) console.error(message); console.error("Usage: node scripts/studio-reconcile.mjs [plan|verify|apply|rollback|export] [--inventory path | --discover --account stable-id --identity-url https://... --agents-url https://... --capability-receipt path]"); process.exitCode = 1; }
function getStableIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Account identity response is malformed.");
  const candidates = [value.account_id, value.accountId, value.project_id, value.projectId, value.id].filter((candidate) => typeof candidate === "string");
  if (new Set(candidates).size !== 1) throw new Error("Account identity response is missing or ambiguous stable ID.");
  return candidates[0];
}
async function getJson(url, key) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`Read-only discovery failed: GET ${new URL(url).pathname} (${response.status}).`);
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") throw new Error("Read-only discovery returned malformed JSON.");
  return body;
}
async function paginatedAgents(agentsUrl, key, maxPages = 100, maxItems = 10_000) {
  const agents = []; const cursors = new Set(); let cursor;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(agentsUrl); if (cursor) url.searchParams.set("cursor", cursor);
    const body = await getJson(url, key); const values = Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : null;
    if (!values) throw new Error("Agent list response does not contain data/items array.");
    agents.push(...values); if (agents.length > maxItems) throw new Error("Agent inventory item limit exceeded.");
    const next = typeof body.next_cursor === "string" ? body.next_cursor : typeof body.nextCursor === "string" ? body.nextCursor : undefined;
    const more = body.has_more === true || body.hasMore === true;
    if (!more && !next) return { agents, metrics: { pages: page, items: agents.length } };
    if (!next || cursors.has(next)) throw new Error("Agent inventory cursor is missing or repeated.");
    cursors.add(next); cursor = next;
  }
  throw new Error("Agent inventory page limit exceeded.");
}
async function discover() {
  const key = process.env.UPSTAGE_API_KEY;
  const account = arg("--account"), identityUrl = arg("--identity-url"), agentsUrl = arg("--agents-url"), capabilityReceipt = arg("--capability-receipt");
  if (!account || !identityUrl || !agentsUrl) throw new Error("Read-only discovery requires --account, --identity-url, and --agents-url from verified API evidence; names are not identity proof.");
  if (!capabilityReceipt) throw new Error("Read-only discovery requires --capability-receipt from Gate B; public Upstage docs do not publish Studio inventory or account identity endpoints.");
  const capability = JSON.parse(readFileSync(capabilityReceipt, "utf8"));
  let identity; try { identity = new URL(identityUrl); } catch { throw new Error("--identity-url must be an absolute HTTPS URL."); }
  if (identity.protocol !== "https:") throw new Error("--identity-url must use HTTPS.");
  let agents; try { agents = new URL(agentsUrl); } catch { throw new Error("--agents-url must be an absolute HTTPS URL."); }
  if (agents.protocol !== "https:") throw new Error("--agents-url must use HTTPS.");
  if (identity.origin !== agents.origin) throw new Error("--identity-url and --agents-url must use the same trusted origin.");
  if (
    !capability ||
    capability.accountId !== account ||
    capability.identityUrl !== identity.href ||
    capability.agentsUrl !== agents.href ||
    capability.readOnlyInventoryVerified !== true
  ) {
    throw new Error("Gate B capability receipt does not authorize the requested account inventory endpoints.");
  }
  if (!key) throw new Error("Read-only discovery requires UPSTAGE_API_KEY in the environment; no .env file is loaded.");
  const actualAccount = getStableIdentity(await getJson(identity, key));
  if (actualAccount !== account) throw new Error("Verified account identity does not match --account.");
  const { agents: inventory, metrics } = await paginatedAgents(agents, key);
  return { inventory: inventory.map((agent) => ({ id: agent.id, name: agent.name, ownershipMarker: agent.ownershipMarker ?? agent.metadata?.ownershipMarker ?? agent.labels?.ownershipMarker, configFingerprint: agent.configFingerprint ?? agent.default_config_fingerprint ?? null })), source: "account", authoritative: true, identity: { accountId: actualAccount, endpoint: identity.pathname, keyFingerprint: createHash("sha256").update(key).digest("hex").slice(0, 16) }, metrics };
}

try {
  validateManifest(manifest);
  const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "plan";
  if (!new Set(["plan", "verify", "apply", "rollback", "export"]).has(command)) usage(`Unknown command: ${command}`);
  else if (command === "apply") {
    const account = arg("--account"), receipt = arg("--identity-receipt"), sha = arg("--manifest-sha");
    if (!account || !receipt || sha !== manifest.fingerprint) usage("Apply is locked: require --account, --identity-receipt, and exact --manifest-sha.");
    else usage("Apply remains locked: no API mutation adapter is authorized in Gate A.");
  } else if (command === "rollback") {
    if (!arg("--receipt")) usage("Rollback requires --receipt."); else usage("Rollback remains locked: no API mutation adapter is authorized in Gate A.");
  } else {
    if (has("--discover") && arg("--inventory")) throw new Error("Choose either --discover or --inventory, never both.");
    const context = has("--discover")
      ? await discover()
      : { inventory: inventoryFrom(arg("--inventory")), source: "offline", authoritative: false, identity: null, metrics: null };
    const result = plan(context.inventory);
    const authoritative = context.source === "account";
    const output = command === "export"
      ? { manifestSha: manifest.fingerprint, source: context.source, authoritative, identity: context.identity, metrics: context.metrics, snapshot: canonicalize(redact(result)), redacted: true }
      : { source: context.source, authoritative, identity: context.identity, metrics: context.metrics, plan: result };
    console.log(JSON.stringify(output, null, 2));
    if (command === "verify" && (!authoritative || result.some((item) => item.action !== "noop"))) process.exitCode = 2;
  }
} catch (error) { usage(error instanceof Error ? error.message : String(error)); }
