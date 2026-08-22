import assert from "node:assert/strict";
import test from "node:test";
import { prepareIngestRequest } from "../tmp/test-dist/lib/context/ingest-request.js";

const DISABLED = {
  enabled: false,
  code: "STUDIO_LIVE_DISABLED",
  reason: "Gate C is not ready",
};

test("checks disabled live readiness before consuming the multipart body", async () => {
  let formDataCalls = 0;
  const result = await prepareIngestRequest(
    {
      url: "http://localhost/api/context/ingest?mode=live&kind=%EA%B8%B0%ED%83%80",
      formData: async () => {
        formDataCalls += 1;
        throw new Error("must not be called");
      },
    },
    () => DISABLED,
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(formDataCalls, 0);
});

test("allows demo metadata parsing while live is disabled", async () => {
  let formDataCalls = 0;
  const form = new FormData();
  form.append("filename", "local-only.pdf");
  const result = await prepareIngestRequest(
    {
      url: "http://localhost/api/context/ingest?mode=demo&kind=%EA%B8%B0%ED%83%80",
      formData: async () => {
        formDataCalls += 1;
        return form;
      },
    },
    () => DISABLED,
  );

  assert.equal(result.ok, true);
  assert.equal(formDataCalls, 1);
  if (result.ok) assert.equal(result.intent.mode, "demo");
});
