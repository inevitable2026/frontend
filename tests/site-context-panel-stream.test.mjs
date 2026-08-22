import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeIngestStream,
  createIngestJob,
  isTerminalIngestEvent,
  unterminatedIngestStreamMessage,
} from "../tmp/test-dist/lib/context/stream-terminal.js";

function stream(chunks, error = null) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (error) controller.error(error);
      else controller.close();
    },
  });
}

test("an EOF without a terminal ingest event supplies a failure message", () => {
  const stage = { 종류: "단계", 단계: { 이름: "수신", 상태: "완료", 시작: null, 소요ms: 1 } };

  assert.equal(isTerminalIngestEvent(stage), false);
  assert.match(unterminatedIngestStreamMessage(false), /끝나기 전에 진행 상황이 끊겼/);
  assert.match(unterminatedIngestStreamMessage(false), /다시 업로드/);
});

test("normal completed and failed terminal events are not converted into EOF failures", () => {
  const completed = { 종류: "완료", jobId: "job-1", upstageCalls: 1, 청크수: 1, 추천: null };
  const failed = { 종류: "실패", 단계: "수신", 사유: "업로드 실패" };

  assert.equal(isTerminalIngestEvent(completed), true);
  assert.equal(isTerminalIngestEvent(failed), true);
  assert.equal(unterminatedIngestStreamMessage(true), null);
});

test("creation converts a rejected POST fetch and a non-JSON response into retryable failures", async () => {
  const rejected = await createIngestJob(async () => { throw new Error("offline"); }, "/ingest", { method: "POST" });
  const nonJson = await createIngestJob(async () => new Response("not json", { status: 500 }), "/ingest", { method: "POST" });

  assert.equal(rejected.kind, "failed");
  assert.match(rejected.message, /다시 업로드/);
  assert.equal(nonJson.kind, "failed");
  assert.match(nonJson.message, /다시 업로드/);
});

test("stream consumer converts fetch, reader, and malformed-SSE failures into retryable failures", async () => {
  const fetchFailure = await consumeIngestStream(async () => { throw new Error("offline"); }, "/stream", () => {});
  const readerFailure = await consumeIngestStream(async () => new Response(stream([], new Error("connection lost"))), "/stream", () => {});
  const malformed = await consumeIngestStream(async () => new Response(stream(["data: {broken-json}\n\n"])), "/stream", () => {});

  for (const outcome of [fetchFailure, readerFailure]) {
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.message, /받아오지 못했습니다/);
    assert.match(outcome.message, /다시 업로드/);
  }
  assert.equal(malformed.kind, "failed");
  assert.match(malformed.message, /알아볼 수 없는 형식/);
  assert.match(malformed.message, /다시 업로드/);
});

test("the three stream failures stay distinguishable from one another", async () => {
  const fetchFailure = await consumeIngestStream(async () => { throw new Error("offline"); }, "/stream", () => {});
  const malformed = await consumeIngestStream(async () => new Response(stream(["data: {broken-json}\n\n"])), "/stream", () => {});
  const unterminated = unterminatedIngestStreamMessage(false);

  const messages = [fetchFailure.message, malformed.message, unterminated];
  assert.equal(new Set(messages).size, 3);
});

test("stream consumer preserves normal terminal events and reports clean unterminated EOF", async () => {
  const events = [];
  const terminal = await consumeIngestStream(
    async () => new Response(stream([`data: ${JSON.stringify({ 종류: "완료", jobId: "job-1", upstageCalls: 1, 청크수: 1, 추천: null })}\n\n`])),
    "/stream",
    (event) => events.push(event),
  );
  const eof = await consumeIngestStream(
    async () => new Response(stream([`data: ${JSON.stringify({ 종류: "단계", 단계: { 이름: "수신", 상태: "완료", 시작: null, 소요ms: 1 } })}\n\n`])),
    "/stream",
    () => {},
  );

  assert.deepEqual(terminal, { kind: "terminal" });
  assert.equal(events[0].종류, "완료");
  assert.equal(eof.kind, "failed");
  assert.match(eof.message, /끝나기 전에 진행 상황이 끊겼/);
});

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// 화면(components/site-context-panel.tsx)은 "이 파일로 데모 보기" 버튼을 `retryWithDemo` 로만
// 판단한다. 예전처럼 서버 문장을 뒤지지 않으므로, 문구를 바꿔도 버튼이 사라지면 안 된다.
test("the demo retry offer follows the structured flag, not the wording of the server message", async () => {
  const liveDisabled = (error) =>
    jsonResponse({ code: "STUDIO_LIVE_DISABLED", error, demoAvailable: true }, 503);

  const outcomes = await Promise.all(
    ["라이브 분석은 현재 비활성화되어 있습니다.", "지금은 실제 분석을 할 수 없습니다.", ""].map((wording) =>
      createIngestJob(async () => liveDisabled(wording), "/ingest", { method: "POST" }),
    ),
  );

  for (const outcome of outcomes) {
    assert.equal(outcome.kind, "live_disabled");
    assert.equal(outcome.demoAvailable, true);
    assert.equal(outcome.retryWithDemo, true);
  }
  assert.equal(new Set(outcomes.map((o) => o.message)).size, 3);
});

test("failures that are not a live-disabled rejection never offer the demo retry", async () => {
  // 첫 번째는 일부러 예전 분기 문구를 담은 500 이다. 문장만 보고 버튼을 열면 이 테스트가 깨진다.
  const worded = await createIngestJob(
    async () => jsonResponse({ error: "라이브 분석은 지금 할 수 없습니다." }, 500),
    "/ingest",
    { method: "POST" },
  );
  const demoUnavailable = await createIngestJob(
    async () => jsonResponse({ code: "STUDIO_LIVE_DISABLED", error: "라이브 분석은 꺼져 있습니다.", demoAvailable: false }, 503),
    "/ingest",
    { method: "POST" },
  );
  const offline = await createIngestJob(async () => { throw new Error("offline"); }, "/ingest", { method: "POST" });

  for (const outcome of [worded, demoUnavailable, offline]) {
    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.retryWithDemo, false);
  }
});
