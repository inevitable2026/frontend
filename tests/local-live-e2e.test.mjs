import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, readSseEvents, runLocalLiveE2E } from "../scripts/local-live-e2e.mjs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_SITE_ID = "44444444-4444-4444-8444-444444444444";
const CONFIG_ID = "config-bound-live-1";

function liveExecution(overrides = {}) {
  return {
    mode: "studio",
    source: "실데이터",
    agentId: "agent-live-1",
    requestedConfigId: CONFIG_ID,
    boundByReceipt: { id: "studio-live-receipt-1", scheme: "request-config-id-v1" },
    servedConfigEchoVerified: false,
    responseId: "response-live-1",
    servedIdentity: "agent-live-1",
    steps: ["parse", "extract_기타"],
    cleanup: "deleted",
    validation: { owner: "application", valid: true, issueCount: 0 },
    review: { owner: "application", decision: "accepted", issueCount: 0, evidenceCount: 1 },
    ...overrides,
  };
}

function stream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

test("parses split CRLF SSE events while ignoring comments", async () => {
  const events = await readSseEvents(new Response(stream([
    ": ping\r\n\r\ndata: {\"종류\":\"단계\",\r\ndata: \"단계\":{\"이름\":\"수신\"}}\r\n\r",
    "\ndata: {\"종류\":\"완료\",\"jobId\":\"job\"}\n\n",
  ])));
  assert.deepEqual(events, [
    { 종류: "단계", 단계: { 이름: "수신" } },
    { 종류: "완료", jobId: "job" },
  ]);
});

test("proves the bound two-step Studio flow, saved file, citation, and site isolation", async () => {
  const calls = [];
  const persistenceCalls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ method: init.method ?? "GET", path: url.pathname, query: url.searchParams, body: init.body });
    if (url.pathname === "/api/context/ingest") return Response.json({ jobId: JOB_ID }, { status: 201 });
    if (url.pathname.endsWith("/stream")) return new Response(stream([`data: ${JSON.stringify({ 종류: "완료", jobId: JOB_ID, 추천: { siteId: SITE_ID }, execution: liveExecution() })}\n\n`]));
    if (url.pathname === "/api/context/sites") return Response.json({ sites: [{ id: SITE_ID, name: "Site" }, { id: OTHER_SITE_ID, name: "Other site" }] });
    if (url.pathname === "/api/context/documents" && init.method === "POST") return Response.json({ documentId: DOCUMENT_ID }, { status: 201 });
    if (url.pathname === "/api/context/documents") return Response.json({ documents: url.searchParams.get("siteId") === SITE_ID ? [{ id: DOCUMENT_ID }] : [] });
    if (url.pathname === `/api/context/documents/${DOCUMENT_ID}`) return Response.json({ document: { id: DOCUMENT_ID, site_id: SITE_ID }, chunks: [{ text: "현장 안전 점검 사항" }] });
    if (url.pathname.endsWith("/file")) return new Response(new Uint8Array([1]), { headers: { "content-type": "application/pdf" } });
    if (url.pathname === "/api/context/search") {
      const body = JSON.parse(init.body);
      return Response.json({ citations: body.siteId === OTHER_SITE_ID ? [] : [{ documentId: DOCUMENT_ID, page: 1, excerpt: "현장 안전 점검 사항" }] });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };

  const result = await runLocalLiveE2E(
    { baseUrl: "http://localhost:3000", pdfPath: "fixture.pdf", kind: "기타", configId: CONFIG_ID, cleanup: false, verifyPersistence: true },
    {
      fetchImpl,
      readFileImpl: async () => new Uint8Array([37, 80, 68, 70]),
      verifyPersistence: async (input) => {
        persistenceCalls.push(input);
        return { chunkCount: 1, vectorDimension: 4096, retainedOriginalBytes: true, stagingChunks: 0, remoteFileStatus: 404 };
      },
    },
  );
  const upload = calls[0];
  assert.equal(upload.method, "POST");
  assert.equal(upload.query.get("mode"), "live");
  assert.equal(upload.query.get("kind"), "기타");
  assert.ok(upload.body instanceof FormData);
  assert.equal(result.documentId, DOCUMENT_ID);
  assert.equal(result.siteId, SITE_ID);
  assert.equal(calls.some((call) => call.path === "/api/context/search"), true);
  assert.equal(calls.filter((call) => call.path === "/api/context/documents").length, 3);
  assert.equal(calls.filter((call) => call.path === "/api/context/search").length, 2);
  assert.equal(persistenceCalls.length, 1);
  assert.deepEqual(result.persistence, { chunkCount: 1, vectorDimension: 4096, retainedOriginalBytes: true, stagingChunks: 0, remoteFileStatus: 404 });
});

test("does not delete when the local API lacks an explicit cleanup scope", async () => {
  const methods = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); methods.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/context/ingest") return Response.json({ jobId: JOB_ID }, { status: 201 });
    if (url.pathname.endsWith("/stream")) return new Response(stream([`data: ${JSON.stringify({ 종류: "완료", jobId: JOB_ID, 추천: null, execution: liveExecution() })}\n\n`]));
    if (url.pathname === "/api/context/sites") return Response.json({ sites: [{ id: SITE_ID }, { id: OTHER_SITE_ID }] });
    if (url.pathname === "/api/context/documents" && init.method === "POST") return Response.json({ documentId: DOCUMENT_ID }, { status: 201 });
    if (url.pathname === "/api/context/documents") return Response.json({ documents: url.searchParams.get("siteId") === SITE_ID ? [{ id: DOCUMENT_ID }] : [] });
    if (url.pathname === `/api/context/documents/${DOCUMENT_ID}` && init.method === "OPTIONS") return new Response(null, { headers: { allow: "GET, OPTIONS" } });
    if (url.pathname === `/api/context/documents/${DOCUMENT_ID}`) return Response.json({ document: { id: DOCUMENT_ID, site_id: SITE_ID }, chunks: [{ text: "현장 안전 점검 사항" }] });
    if (url.pathname.endsWith("/file")) return new Response(null, { headers: { "content-type": "application/pdf" } });
    if (url.pathname === "/api/context/search") {
      const body = JSON.parse(init.body);
      return Response.json({ citations: body.siteId === OTHER_SITE_ID ? [] : [{ documentId: DOCUMENT_ID, page: 1, excerpt: "현장 안전 점검 사항" }] });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  const result = await runLocalLiveE2E({ baseUrl: "http://127.0.0.1:3000", pdfPath: "fixture.pdf", kind: "기타", configId: CONFIG_ID, cleanup: true }, { fetchImpl, readFileImpl: async () => new Uint8Array([1]) });
  assert.deepEqual(result.cleanup, { attempted: false, reason: "no safe local cleanup API" });
  assert.equal(methods.some((method) => method.startsWith("DELETE ")), false);
});

test("rejects non-local base URLs before any request", async () => {
  assert.equal(parseArgs(["--base-url", "https://example.com"]).baseUrl, "https://example.com");
  await assert.rejects(
    runLocalLiveE2E({ baseUrl: "https://example.com", pdfPath: "fixture.pdf", kind: "기타", cleanup: false }),
    /localhost/,
  );
});

test("rejects a completion whose receipt-bound requested config differs from the explicitly bound config", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/context/ingest") return Response.json({ jobId: JOB_ID }, { status: 201 });
    if (url.pathname.endsWith("/stream")) return new Response(stream([`data: ${JSON.stringify({ 종류: "완료", jobId: JOB_ID, execution: liveExecution({ requestedConfigId: "wrong-config" }) })}\n\n`]));
    throw new Error(`unexpected ${url.pathname}`);
  };
  await assert.rejects(
    runLocalLiveE2E({ baseUrl: "http://localhost:3000", pdfPath: "fixture.pdf", kind: "기타", configId: CONFIG_ID, cleanup: false }, { fetchImpl, readFileImpl: async () => new Uint8Array([1]) }),
    /requestedConfigId does not match/,
  );
});

test("rejects undocumented remote validation or review nodes even when the job completed", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/context/ingest") return Response.json({ jobId: JOB_ID }, { status: 201 });
    if (url.pathname.endsWith("/stream")) return new Response(stream([`data: ${JSON.stringify({ 종류: "완료", jobId: JOB_ID, execution: liveExecution({ steps: ["parse", "extract_기타", "validate"] }) })}\n\n`]));
    throw new Error(`unexpected ${url.pathname}`);
  };
  await assert.rejects(
    runLocalLiveE2E({ baseUrl: "http://localhost:3000", pdfPath: "fixture.pdf", kind: "기타", configId: CONFIG_ID, cleanup: false }, { fetchImpl, readFileImpl: async () => new Uint8Array([1]) }),
    /only Studio Parse and Extract/,
  );
});
