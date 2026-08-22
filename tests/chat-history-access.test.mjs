import assert from "node:assert/strict";
import test from "node:test";

import { chatHistoryAccess, ChatHistoryAccessUnavailableError } from "../tmp/test-dist/lib/chat/chat-history-access.js";

const siteId = "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae";

test("chat history stays fail-closed in production and without explicit local settings", () => {
  assert.throws(() => chatHistoryAccess({ NODE_ENV: "production", CHAT_HISTORY_LOCAL_ENABLED: "true", DATABASE_URL: "postgres://local", CONSOLE_SITE_IDS: siteId }), ChatHistoryAccessUnavailableError);
  assert.throws(() => chatHistoryAccess({ NODE_ENV: "development", DATABASE_URL: "postgres://local", CONSOLE_SITE_IDS: siteId }), ChatHistoryAccessUnavailableError);
  assert.throws(() => chatHistoryAccess({ NODE_ENV: "development", CHAT_HISTORY_LOCAL_ENABLED: "true", CONSOLE_SITE_IDS: siteId }), ChatHistoryAccessUnavailableError);
  assert.throws(() => chatHistoryAccess({ NODE_ENV: "development", CHAT_HISTORY_LOCAL_ENABLED: "true", DATABASE_URL: "postgres://local", CONSOLE_SITE_IDS: "not-a-uuid" }), ChatHistoryAccessUnavailableError);
});

test("local chat history accepts only UUID site IDs from the server allowlist", () => {
  const access = chatHistoryAccess({ NODE_ENV: "development", CHAT_HISTORY_LOCAL_ENABLED: "true", DATABASE_URL: "postgres://local", CONSOLE_SITE_IDS: `${siteId},not-a-uuid` });
  assert.equal(access.actor, "local-console");
  assert.deepEqual([...access.siteIds], [siteId]);
});
