import assert from "node:assert/strict";
import test from "node:test";
import { prepareIngestRequest } from "../tmp/test-dist/lib/context/ingest-request.js";

const DISABLED = {
  enabled: false,
  code: "STUDIO_LIVE_DISABLED",
  reason: "문서 분석 기능이 꺼져 있습니다. 시스템 담당자에게 문의해 주세요.",
  detail: "Gate C is not ready",
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

// 400 · 503 응답의 `error` 는 관리자 화면에 그대로 뜬다. 쿼리 이름·enum 값이 새어
// 나가지 않아야 하고, 거절 이유마다 문구가 달라야 한다.
test("rejection messages stay admin-readable and keep each cause apart", async () => {
  const form = new FormData();
  form.append("filename", "local-only.pdf");
  const call = (query) =>
    prepareIngestRequest(
      { url: `http://localhost/api/context/ingest${query}`, formData: async () => form },
      () => DISABLED,
    );

  const badMode = await call("?mode=turbo&kind=%EA%B8%B0%ED%83%80");
  const badKind = await call("?mode=demo&kind=invoice");
  const disabled = await call("?mode=live&kind=%EA%B8%B0%ED%83%80");
  const unreadable = await prepareIngestRequest(
    {
      url: "http://localhost/api/context/ingest?mode=demo&kind=%EA%B8%B0%ED%83%80",
      formData: async () => {
        throw new Error("boom");
      },
    },
    () => DISABLED,
  );

  assert.equal(badMode.ok, false);
  assert.equal(badKind.ok, false);
  assert.equal(disabled.ok, false);
  assert.equal(unreadable.ok, false);

  const messages = [badMode, badKind, disabled, unreadable].map((result) => result.body.error);
  for (const message of messages) {
    assert.doesNotMatch(message, /[A-Za-z]/, `leaks an internal name: ${message}`);
    assert.match(message, /(습니다|주세요)\.$/, `not 합쇼체: ${message}`);
  }
  assert.equal(new Set(messages).size, messages.length);

  // 400(요청이 잘못됨)과 503(라이브가 꺼짐)은 서로 다른 사실이다.
  assert.equal(badMode.status, 400);
  assert.equal(badKind.status, 400);
  assert.equal(unreadable.status, 400);
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.code, "STUDIO_LIVE_DISABLED");
  assert.equal(disabled.body.demoAvailable, true);
});
