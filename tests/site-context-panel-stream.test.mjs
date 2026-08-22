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
  assert.match(unterminatedIngestStreamMessage(false), /완료 신호 없이 종료/);
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
    assert.match(outcome.message, /다시 업로드/);
  }
  assert.equal(malformed.kind, "failed");
  assert.match(malformed.message, /형식이 올바르지/);
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
  assert.match(eof.message, /완료 신호 없이 종료/);
});
