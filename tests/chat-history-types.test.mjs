import assert from "node:assert/strict";
import test from "node:test";

import { buildPriorChatModelContext, isChatToolCall, isChatTurn, parseChatHistory } from "../tmp/test-dist/lib/chat/chat-history-types.js";

const toolCall = { id: "tool-1", name: "read_official_law", status: "completed", input: { ref: "a" }, output: { result: "ok" }, sources: [{ label: "국가법령정보센터", url: "https://www.law.go.kr" }] };
const conversation = { conversationId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae", siteId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ab", title: "질문", actor: "local-console", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z" };
const turn = { turnId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ac", conversationId: conversation.conversationId, siteId: conversation.siteId, commandId: "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ad", sequence: 1, question: "질문", status: "completed", assistantText: "답변", toolCalls: [toolCall], failureMessage: null, actor: "local-console", createdAt: conversation.createdAt, updatedAt: conversation.updatedAt };

test("parses serializable hydrated chat records including normalized tool calls", () => {
  assert.equal(isChatToolCall(toolCall), true);
  assert.equal(isChatToolCall({ ...toolCall, sources: [{ label: "bad", url: "javascript:alert(1)" }] }), false);
  assert.equal(isChatTurn(turn), true);
  assert.deepEqual(parseChatHistory({ conversation, turns: [turn] }), { conversation, turns: [turn] });
  assert.equal(parseChatHistory({ conversation, turns: [{ ...turn, sequence: 0 }] }), null);
});

test("model context keeps bounded completed text pairs and never includes tool references", () => {
  const older = { ...turn, sequence: 2, question: "이전 질문", assistantText: "이전 답변", toolCalls: [{ ...toolCall, output: { secret: "do not send" } }] };
  const failed = { ...turn, sequence: 3, status: "failed", assistantText: null, failureMessage: "실패" };
  assert.deepEqual(buildPriorChatModelContext([older, failed, turn], { maxTurns: 2, maxCharacters: 30 }), [
    { role: "user", content: "이전 질문" }, { role: "assistant", content: "이전 답변" },
    { role: "user", content: "질문" }, { role: "assistant", content: "답변" },
  ]);
  assert.deepEqual(buildPriorChatModelContext([older, turn], { maxTurns: 2, maxCharacters: 3 }), []);
});
