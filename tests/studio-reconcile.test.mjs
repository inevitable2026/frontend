import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../lib/context/studio-manifest.json", import.meta.url), "utf8"));
const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
const sha = (value) => {
  const unsigned = { ...value };
  delete unsigned.fingerprint;
  return createHash("sha256").update(JSON.stringify(canonicalize(unsigned))).digest("hex");
};
const run = (...args) => execFileSync("node", ["scripts/studio-reconcile.mjs", ...args], { cwd: new URL("..", import.meta.url), encoding: "utf8" });

test("manifest has six documented Studio Parse -> Extract contracts", () => {
  assert.equal(manifest.contracts.length, 6);
  assert.equal(new Set(manifest.contracts.map((contract) => contract.kind)).size, 6);
  assert.equal(sha(manifest), manifest.fingerprint);
  for (const contract of manifest.contracts) {
    assert.deepEqual(contract.steps.map((step) => step.type), ["document-parse", "information-extract"]);
    assert.deepEqual(contract.steps.map((step) => step.next_steps.map((edge) => edge.step_name)), [
      [contract.steps[1].logicalName], [],
    ]);
  }
});

test("plan is read-only and rejects pre-existing name adoption", () => {
  const inventoryPath = new URL("./.studio-inventory.json", import.meta.url);
  writeFileSync(inventoryPath, JSON.stringify([{ id: "pre-existing", name: manifest.contracts[0].agentLogicalName, ownershipMarker: "other" }]));
  try {
    const output = JSON.parse(run("plan", "--inventory", inventoryPath.pathname));
    assert.equal(output.source, "offline");
    assert.equal(output.authoritative, false);
    assert.equal(output.identity, null);
    assert.equal(output.plan[0].action, "collision");
    assert.match(output.plan[0].reason, /not adopted/);
    assert.equal(output.plan.filter((item) => item.action === "create").length, 5);
  } finally { unlinkSync(inventoryPath); }
});

test("offline verify never presents supplied inventory as account verification", () => {
  const inventoryPath = new URL("./.studio-empty-inventory.json", import.meta.url);
  writeFileSync(inventoryPath, "[]");
  try {
    assert.throws(() => run("verify", "--inventory", inventoryPath.pathname));
  } finally { unlinkSync(inventoryPath); }
});

test("account discovery fails closed without a Gate B capability receipt", () => {
  assert.throws(
    () => run(
      "plan",
      "--discover",
      "--account",
      "expected",
      "--identity-url",
      "https://api.example.test/v2/account",
      "--agents-url",
      "https://api.example.test/v2/agents",
    ),
    /requires --capability-receipt/,
  );
});

test("account discovery never sends one bearer key to unrelated origins", () => {
  const receiptPath = new URL("./.studio-capability.json", import.meta.url);
  writeFileSync(receiptPath, JSON.stringify({
    accountId: "expected",
    identityUrl: "https://identity.example.test/v2/account",
    agentsUrl: "https://api.example.test/v2/agents",
    readOnlyInventoryVerified: true,
  }));
  try {
  assert.throws(
    () => execFileSync(
      "node",
      [
        "scripts/studio-reconcile.mjs",
        "plan",
        "--discover",
        "--account",
        "expected",
        "--identity-url",
        "https://identity.example.test/v2/account",
        "--agents-url",
        "https://api.example.test/v2/agents",
        "--capability-receipt",
        receiptPath.pathname,
      ],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, UPSTAGE_API_KEY: "test-key-never-sent" },
      },
    ),
    /same trusted origin/,
  );
  } finally { unlinkSync(receiptPath); }
});

test("apply stays locked without all explicit gates", () => {
  assert.throws(() => run("apply"), /Apply is locked/);
  assert.throws(() => run("apply", "--account", "account", "--identity-receipt", "receipt", "--manifest-sha", manifest.fingerprint), /Apply remains locked/);
});
