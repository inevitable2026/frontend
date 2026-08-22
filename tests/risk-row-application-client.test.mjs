import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationResultMatchesDescriptor,
  applicationResultMatchesCommand,
  createLatestRiskRowApplicationLoader,
  parseRiskRowApplicationDescriptor,
  parseRiskRowApplicationResult,
} from "../tmp/test-dist/lib/risk/row-application-client.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const command = {
  commandId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ab",
  siteId: "site",
  workItemId: "card",
  expectedApplicationFingerprint: "0123456789abcdef0123456789abcdef",
};

test("parses the authoritative application descriptor", () => {
  const descriptor = {
    targetDocumentId: "ra_draft", applicationFingerprint: "0123456789abcdef0123456789abcdef", eligible: true,
    issues: [], rowIds: ["RI-01"],
  };
  assert.deepEqual(parseRiskRowApplicationDescriptor(descriptor), descriptor);
  assert.equal(parseRiskRowApplicationDescriptor({ ...descriptor, eligible: "yes" }), null);
  assert.equal(parseRiskRowApplicationDescriptor({ ...descriptor, applicationFingerprint: "bad" }), null);
});

test("binds an applied response to the exact command", () => {
  const result = {
    commandId: command.commandId, siteId: "site", workItemId: "card", targetDocumentId: "ra_draft",
    rowIds: ["RI-01"], factIds: [42], workItemEventId: 9, actor: "local-console",
    appliedAt: "2026-08-23T00:00:00.000Z",
    replayed: false,
  };
  assert.deepEqual(parseRiskRowApplicationResult(result), result);
  assert.equal(applicationResultMatchesCommand(result, command), true);
  assert.equal(applicationResultMatchesDescriptor(result, {
    targetDocumentId: "ra_draft", applicationFingerprint: null, eligible: true, issues: [], rowIds: ["RI-01"],
  }), true);
  assert.equal(applicationResultMatchesDescriptor(result, {
    targetDocumentId: "another", applicationFingerprint: null, eligible: true, issues: [], rowIds: ["RI-01"],
  }), false);
  assert.equal(applicationResultMatchesCommand({ ...result, commandId: "other" }, command), false);
  assert.equal(parseRiskRowApplicationResult({ ...result, factIds: [0] }), null);
  assert.equal(parseRiskRowApplicationResult({ ...result, appliedAt: "not-a-date" }), null);
});

test("an older application descriptor cannot overwrite a newer review state", async () => {
  const slow = deferred();
  const fast = deferred();
  const pending = [slow, fast];
  const loader = createLatestRiskRowApplicationLoader(() => pending.shift().promise);
  const older = loader.load("site", "card");
  const newer = loader.load("site", "card");
  const latestDescriptor = {
    targetDocumentId: "ra_draft",
    applicationFingerprint: "0123456789abcdef0123456789abcdef",
    eligible: true,
    issues: [],
    rowIds: ["RI-01"],
  };

  fast.resolve(latestDescriptor);
  assert.deepEqual(await newer, latestDescriptor);
  slow.resolve({ ...latestDescriptor, eligible: false });
  assert.equal(await older, null);

  const staleFailure = deferred();
  const current = deferred();
  const failures = [staleFailure, current];
  const failureLoader = createLatestRiskRowApplicationLoader(() => failures.shift().promise);
  const ignoredFailure = failureLoader.load("site", "card");
  const currentRequest = failureLoader.load("site", "card");
  staleFailure.reject(new Error("stale"));
  assert.equal(await ignoredFailure, null);
  current.resolve(latestDescriptor);
  assert.deepEqual(await currentRequest, latestDescriptor);
});
