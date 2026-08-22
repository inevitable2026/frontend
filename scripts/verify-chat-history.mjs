#!/usr/bin/env node
/**
 * Disposable end-to-end verifier for URL-addressable chat history.
 * Uses a fresh pgvector container and a real local Next server. The route's
 * explicitly gated test generator is the only AI implementation exercised.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SITE_ID = "22222222-2222-4222-8222-222222222222";
const DB_PASSWORD = "chat_history_test";
const logs = [];

function assert(condition, message) { if (!condition) throw new Error(message); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function run(command, args, options = {}) { return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options }); }

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitFor(label, probe, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError ?? "timed out")}`);
}

async function responseJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function request(baseUrl, path, options) {
  const response = await fetch(new URL(path, baseUrl), options);
  return { status: response.status, body: await responseJson(response) };
}

async function seed(sql) {
  await sql.unsafe(`
    create extension if not exists pgcrypto;
    create table sites (id uuid primary key);
    create table chat_conversations (
      conversation_id uuid primary key, site_id uuid not null references sites(id) on delete cascade,
      title text not null, actor text not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      check (btrim(title) <> ''), check (btrim(actor) <> ''), check (updated_at >= created_at)
    );
    alter table chat_conversations add unique (conversation_id, site_id);
    create table chat_turns (
      turn_id uuid primary key default gen_random_uuid(), command_id uuid not null unique,
      conversation_id uuid not null references chat_conversations(conversation_id) on delete cascade,
      site_id uuid not null references sites(id) on delete cascade, sequence integer not null,
      question text not null, assistant_text text, failure_message text,
      tool_calls jsonb not null default '[]'::jsonb, status text not null default 'pending', actor text not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (conversation_id, sequence), check (sequence > 0), check (btrim(question) <> ''), check (btrim(actor) <> ''),
      check (status in ('pending', 'completed', 'failed')), check (jsonb_typeof(tool_calls) = 'array'),
      check ((status = 'pending' and assistant_text is null and failure_message is null)
        or (status = 'completed' and assistant_text is not null and btrim(assistant_text) <> '' and failure_message is null)
        or (status = 'failed' and assistant_text is null and failure_message is not null and btrim(failure_message) <> '')),
      check (updated_at >= created_at),
      foreign key (conversation_id, site_id) references chat_conversations(conversation_id, site_id) on delete cascade
    );
  `);
  await sql`insert into sites (id) values (${SITE_ID}::uuid), (${OTHER_SITE_ID}::uuid)`;
}

function command(question, conversationId) {
  return { siteId: SITE_ID, commandId: randomUUID(), question, ...(conversationId ? { conversationId } : {}) };
}

async function post(baseUrl, payload) {
  return request(baseUrl, "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

async function startNext({ databaseUrl, port, mode = "normal", generatorDelayMs = 0, logs }) {
  const next = run("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "development", CHAT_HISTORY_LOCAL_ENABLED: "true",
      CONSOLE_SITE_IDS: SITE_ID, CHAT_TEST_GENERATOR_ENABLED: "true",
      CHAT_TEST_GENERATOR_DELAY_MS: String(generatorDelayMs),
      ...(mode === "failure" ? { CHAT_TEST_GENERATOR_MODE: "forced-completion-failure" } : {}),
    },
  });
  next.stderr.on("data", (data) => logs.push(data.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor("Next", async () => (await fetch(`${baseUrl}/api/chat?siteId=${SITE_ID}&conversationId=${randomUUID()}`)).status < 500);
  return { next, baseUrl };
}

async function main() {
  const dbPort = await freePort();
  const appPort = await freePort();
  const failureAppPort = await freePort();
  const containerName = `chat-history-${randomUUID().slice(0, 8)}`;
  const databaseUrl = `postgres://postgres:${DB_PASSWORD}@127.0.0.1:${dbPort}/postgres`;
  let database;
  let container;
  let next;
  let failureNext;
  let baseUrl;
  let failureUrl;
  try {
    container = run("docker", ["run", "--rm", "--name", containerName, "-e", `POSTGRES_PASSWORD=${DB_PASSWORD}`, "-p", `127.0.0.1:${dbPort}:5432`, "pgvector/pgvector:pg16"]);
    container.stderr.on("data", (data) => logs.push(data.toString()));
    database = postgres(databaseUrl, { max: 1, prepare: false });
    await waitFor("Postgres", async () => { await database`select 1`; return true; });
    await seed(database);

    ({ next, baseUrl } = await startNext({ databaseUrl, port: appPort, generatorDelayMs: 250, logs }));
    const firstCommand = command("첫 질문: 안전 점검은 무엇인가요?");
    const first = await post(baseUrl, firstCommand);
    assert(first.status === 200 && first.body.replayed === false, `first POST must create a completed turn: ${JSON.stringify(first)}`);
    assert(typeof first.body.conversationId === "string" && first.body.turn?.status === "completed", "first POST did not return a completed conversation turn");
    const conversationId = first.body.conversationId;

    const firstReplay = await post(baseUrl, firstCommand);
    assert(firstReplay.status === 200 && firstReplay.body.replayed === true && firstReplay.body.conversationId === conversationId,
      `first command replay without conversationId must resolve the original conversation: ${JSON.stringify(firstReplay)}`);

    const hydrated = await request(baseUrl, `/api/chat?siteId=${SITE_ID}&conversationId=${conversationId}`);
    assert(hydrated.status === 200 && hydrated.body.turns?.length === 1, `deep-link GET did not hydrate the first turn: ${JSON.stringify(hydrated)}`);
    assert(hydrated.body.turns[0].question === firstCommand.question && hydrated.body.turns[0].status === "completed", "hydrated first turn differs from persisted turn");

    const secondCommand = command("두 번째 질문: 앞 질문을 이어서 설명해 주세요.", conversationId);
    const second = await post(baseUrl, secondCommand);
    assert(second.status === 200 && second.body.turn?.status === "completed", `second POST did not complete: ${JSON.stringify(second)}`);
    const generated = JSON.parse(second.body.turn.assistantText);
    assert(generated.priorQuestions.includes(firstCommand.question), `second generation did not receive prior question context: ${JSON.stringify(generated)}`);

    const replay = await post(baseUrl, secondCommand);
    assert(replay.status === 200 && replay.body.replayed === true, `exact command replay must be idempotent: ${JSON.stringify(replay)}`);
    const [afterReplay] = await database`select count(*)::int as count from chat_turns where conversation_id = ${conversationId}::uuid`;
    assert(afterReplay.count === 2, `replay created duplicate turns: ${JSON.stringify(afterReplay)}`);

    const crossSite = await request(baseUrl, `/api/chat?siteId=${OTHER_SITE_ID}&conversationId=${conversationId}`);
    assert(crossSite.status === 404, `cross-site GET must return 404, got ${crossSite.status}`);

    const inFlightCommand = command("같은 명령 재전송", conversationId);
    await database`
      insert into chat_turns (turn_id, command_id, conversation_id, site_id, sequence, question, actor)
      values (${randomUUID()}::uuid, ${inFlightCommand.commandId}::uuid, ${conversationId}::uuid, ${SITE_ID}::uuid, 3,
        ${inFlightCommand.question}, 'local-console')
    `;
    const inFlightReplay = await post(baseUrl, inFlightCommand);
    assert(inFlightReplay.status === 409, `pending command replay must remain in flight: ${JSON.stringify(inFlightReplay)}`);
    const [stillPending] = await database`select status from chat_turns where command_id = ${inFlightCommand.commandId}::uuid`;
    assert(stillPending.status === "pending", `pending replay must not overwrite the active turn: ${JSON.stringify(stillPending)}`);
    await database`update chat_turns set status = 'failed', failure_message = 'test cleanup' where command_id = ${inFlightCommand.commandId}::uuid`;

    const concurrentOne = command("동시 질문 하나", conversationId);
    const concurrentTwo = command("동시 질문 둘", conversationId);
    const [parallelOne, parallelTwo] = await Promise.all([post(baseUrl, concurrentOne), post(baseUrl, concurrentTwo)]);
    const statuses = [parallelOne.status, parallelTwo.status].sort((a, b) => a - b);
    assert(statuses[0] === 200 && statuses[1] === 409, `concurrent distinct commands must produce one 200 and one 409: ${JSON.stringify([parallelOne, parallelTwo])}`);

    await stop(next); next = undefined;
    ({ next: failureNext, baseUrl: failureUrl } = await startNext({ databaseUrl, port: failureAppPort, mode: "failure", logs }));
    const failedCommand = command("완료 저장 실패를 강제합니다.");
    const failed = await post(failureUrl, failedCommand);
    assert(failed.status >= 500, `forced provider failure must surface as 5xx: ${JSON.stringify(failed)}`);
    assert(failed.body.turn?.status === "failed" && failed.body.conversationId === failed.body.turn.conversationId,
      `forced failure must return its canonical persisted turn: ${JSON.stringify(failed)}`);
    const [failedTurn] = await database`select status, assistant_text as "assistantText", failure_message as "failureMessage" from chat_turns where command_id = ${failedCommand.commandId}::uuid`;
    assert(failedTurn?.status === "failed" && failedTurn.assistantText === null && typeof failedTurn.failureMessage === "string", `forced failure must persist a consistent failed turn: ${JSON.stringify(failedTurn)}`);

    console.log(JSON.stringify({ ok: true, firstStatus: first.status, firstReplayStatus: firstReplay.status, hydrationStatus: hydrated.status, secondStatus: second.status, replayStatus: replay.status, inFlightReplayStatus: inFlightReplay.status, concurrencyStatuses: statuses, crossSiteStatus: crossSite.status, forcedFailureStatus: failed.status }, null, 2));
  } finally {
    await stop(failureNext);
    await stop(next);
    if (database) await database.end({ timeout: 5 }).catch(() => {});
    await stop(container);
    if (logs.length && process.exitCode) console.error(logs.slice(-16).join(""));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  if (logs.length > 0) console.error(logs.slice(-32).join(""));
  process.exitCode = 1;
});
