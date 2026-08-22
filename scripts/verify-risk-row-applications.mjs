#!/usr/bin/env node
/**
 * Disposable end-to-end verifier for the atomic risk-row application API.
 * It owns neither the production schema nor data: every run starts an isolated
 * pgvector container and deletes it (and the Next dev server) before exiting.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const SUCCESS_CARD = "risk-apply-success";
const FAILURE_CARD = "risk-apply-failure";
const SUCCESS_COMMAND = "22222222-2222-4222-8222-222222222222";
const FAILURE_COMMAND = "33333333-3333-4333-8333-333333333333";
const SECOND_COMMAND = "44444444-4444-4444-8444-444444444444";
const DB_PASSWORD = "risk_row_application_test";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function run(command, args, options = {}) {
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

async function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitFor(label, probe, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError ?? "timed out")}`);
}

function riskRow(id) {
  return {
    itemId: id,
    process: "슬래브 타설",
    hazard: "낙하물",
    hazardClass: "추락·낙하",
    currentControl: "안전난간 설치",
    risk: { likelihood: 3, severity: 3, score: 9, level: "높음" },
    residualRisk: { likelihood: 1, severity: 3, score: 3, level: "낮음" },
    measures: [{ measureId: `${id}-measure`, text: "출입 통제", type: "engineering", owner: "안전관리자", dueDate: "2026-08-23", status: "planned" }],
    legalReferences: [{ ref: "산업안전보건법", citable: true, note: "위험성평가" }],
    derivedFrom: { evidenceIds: [`evidence-${id}`], contextDocRefs: ["meeting-risk-2026-08"] },
  };
}

function meetingDraft(prefix) {
  return { form: "회의록", rows: [riskRow(`${prefix}-01`), riskRow(`${prefix}-02`), riskRow(`${prefix}-03`)] };
}

async function seed(sql) {
  await sql.unsafe(`
    create extension if not exists pgcrypto;
    create schema board;
    create table sites (id uuid primary key);
    create table board.work_items (
      item_id text primary key, site_id uuid not null references sites(id), timing text not null default 'trigger',
      status text not null, origin text not null default 'machine', title text not null, summary text,
      trigger jsonb, invalidates jsonb not null default '[]', produces jsonb not null default '[]', draft jsonb,
      confirmed_by text, confirmed_at timestamptz, due_by text, estimated_minutes integer, assignee text,
      delegable boolean not null default true, blocked_by jsonb not null default '[]', lane_order double precision not null default 0,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      check ((confirmed_by is null) = (confirmed_at is null))
    );
    create table board.snapshot_facts (
      fact_id bigint generated always as identity primary key, site_id uuid not null, fact_type text not null,
      key text not null, value jsonb not null, observed_at timestamptz not null, source_doc_id text,
      confidence double precision not null default 1, recorded_at timestamptz not null default now(),
      unique (site_id, fact_type, key, observed_at)
    );
    create table board.work_item_events (
      event_id bigint generated always as identity primary key, item_id text not null references board.work_items(item_id),
      type text not null, actor text not null, reason text, diff jsonb not null default '[]', created_at timestamptz not null default now()
    );
    create table board.detection_events (id bigint generated always as identity primary key);
    create table board.invalidations (id bigint generated always as identity primary key);
    create table board.briefing_narratives (cache_key text primary key);
    create table risk_row_reviews (
      site_id uuid not null references sites(id), work_item_id text not null, row_id text not null, row_fingerprint text not null,
      decision text not null check (decision in ('held', 'approved')), version bigint not null check (version > 0), actor text not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key (site_id, work_item_id, row_id)
    );
    create table risk_row_review_events (id uuid primary key default gen_random_uuid());
    create table risk_row_application_events (
      id uuid primary key default gen_random_uuid(), command_id uuid not null unique, site_id uuid not null references sites(id),
      work_item_id text not null, work_item_event_id bigint not null, target_document_id text not null, row_ids text[] not null,
      fact_ids bigint[] not null, request_fingerprint text not null, actor text not null, result jsonb not null,
      applied_at timestamptz not null default now(), created_at timestamptz not null default now(), unique (site_id, work_item_id)
    );
    create function reject_failure_receipt() returns trigger language plpgsql as $$
    begin
      if new.work_item_id = '${FAILURE_CARD}' then raise exception 'forced receipt failure'; end if;
      return new;
    end;
    $$;
    create trigger risk_row_application_failure before insert on risk_row_application_events
      for each row execute function reject_failure_receipt();
  `);
  await sql`insert into sites (id) values (${SITE_ID}::uuid)`;
  for (const [card, draft, target] of [[SUCCESS_CARD, meetingDraft("success"), "risk-doc-success"], [FAILURE_CARD, meetingDraft("failure"), "risk-doc-failure"]]) {
    await sql`
      insert into board.work_items (item_id, site_id, status, title, produces, draft)
      values (${card}, ${SITE_ID}::uuid, 'approval', ${card}, ${JSON.stringify([{ into: target }])}::text::jsonb, ${JSON.stringify(draft)}::text::jsonb)
    `;
    await sql`
      insert into risk_row_reviews (site_id, work_item_id, row_id, row_fingerprint, decision, version, actor)
      select ${SITE_ID}::uuid, ${card}, source.row ->> 'itemId', md5(source.row::text), 'approved', 1, 'local-console'
        from board.work_items item
        cross join lateral jsonb_array_elements(item.draft -> 'rows') with ordinality as source(row, position)
       where item.item_id = ${card}
    `;
  }
}

async function responseJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function request(baseUrl, path, options) {
  const response = await fetch(new URL(path, baseUrl), options);
  return { status: response.status, body: await responseJson(response) };
}

async function descriptor(baseUrl, workItemId) {
  const result = await request(baseUrl, `/api/risk/row-applications?siteId=${SITE_ID}&workItemId=${workItemId}`);
  assert(result.status === 200, `descriptor returned ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function apply(baseUrl, commandId, workItemId, fingerprint) {
  return request(baseUrl, "/api/risk/row-applications", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, siteId: SITE_ID, workItemId, expectedApplicationFingerprint: fingerprint }),
  });
}

async function counts(sql, workItemId, target) {
  const [result] = await sql`
    select
      (select count(*)::int from board.snapshot_facts where site_id = ${SITE_ID}::uuid and key like ${`${target}#%`}) as facts,
      (select count(*)::int from board.work_item_events where item_id = ${workItemId} and type = 'approved') as events,
      (select count(*)::int from risk_row_application_events where site_id = ${SITE_ID}::uuid and work_item_id = ${workItemId}) as receipts,
      (select status from board.work_items where item_id = ${workItemId}) as status,
      (select value ? '이행확인' from board.snapshot_facts where site_id = ${SITE_ID}::uuid and key like ${`${target}#%`} limit 1) as has_execution_confirmation
  `;
  return result;
}

async function main() {
  const dbPort = await freePort();
  const appPort = await freePort();
  const containerName = `risk-row-applications-${randomUUID().slice(0, 8)}`;
  const databaseUrl = `postgres://postgres:${DB_PASSWORD}@127.0.0.1:${dbPort}/postgres`;
  const baseUrl = `http://127.0.0.1:${appPort}`;
  let database;
  let container;
  let next;
  const logs = [];
  try {
    container = run("docker", ["run", "--rm", "--name", containerName, "-e", `POSTGRES_PASSWORD=${DB_PASSWORD}`, "-p", `127.0.0.1:${dbPort}:5432`, "pgvector/pgvector:pg16"]);
    container.stderr.on("data", (data) => logs.push(data.toString()));
    database = postgres(databaseUrl, { max: 1, prepare: false });
    await waitFor("Postgres", async () => { await database`select 1`; return true; });
    await seed(database);

    next = run("npm", ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(appPort)], {
      env: { ...process.env, DATABASE_URL: databaseUrl, BOARD_STORE: "pg", RISK_ROW_REVIEW_LOCAL_ENABLED: "true", CONSOLE_SITE_IDS: SITE_ID, NODE_ENV: "development" },
    });
    next.stderr.on("data", (data) => logs.push(data.toString()));
    await waitFor("Next", async () => (await fetch(`${baseUrl}/api/risk/row-applications?siteId=${SITE_ID}&workItemId=${SUCCESS_CARD}`)).status < 500);

    const initial = await descriptor(baseUrl, SUCCESS_CARD);
    assert(initial.eligible === true && typeof initial.applicationFingerprint === "string", "initial descriptor is not eligible");
    assert(initial.rowIds?.length === 3, "initial descriptor does not contain three approved rows");

    const generic = await request(baseUrl, `/api/board/items/${SUCCESS_CARD}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done", confirmedBy: "local-console" }),
    });
    assert(generic.status === 409, `generic completion must be rejected, got ${generic.status}`);

    const first = await apply(baseUrl, SUCCESS_COMMAND, SUCCESS_CARD, initial.applicationFingerprint);
    assert(first.status === 201 && first.body.replayed === false, `first application must return 201, got ${first.status}: ${JSON.stringify(first.body)}`);
    let successCounts = await counts(database, SUCCESS_CARD, "risk-doc-success");
    assert(successCounts.facts === 3 && successCounts.events === 1 && successCounts.receipts === 1 && successCounts.status === "done" && successCounts.has_execution_confirmation === false,
      `first application persistence mismatch: ${JSON.stringify(successCounts)}`);

    const replay = await apply(baseUrl, SUCCESS_COMMAND, SUCCESS_CARD, initial.applicationFingerprint);
    assert(replay.status === 200 && replay.body.replayed === true, `exact replay must return 200/replayed, got ${replay.status}: ${JSON.stringify(replay.body)}`);
    successCounts = await counts(database, SUCCESS_CARD, "risk-doc-success");
    assert(successCounts.facts === 3 && successCounts.events === 1 && successCounts.receipts === 1, "replay created duplicate side effects");

    const different = await apply(baseUrl, SECOND_COMMAND, SUCCESS_CARD, initial.applicationFingerprint);
    assert(different.status === 409, `different command after application must conflict, got ${different.status}`);

    const failingDescriptor = await descriptor(baseUrl, FAILURE_CARD);
    assert(failingDescriptor.eligible === true && typeof failingDescriptor.applicationFingerprint === "string", "failure fixture is not eligible");
    const failing = await apply(baseUrl, FAILURE_COMMAND, FAILURE_CARD, failingDescriptor.applicationFingerprint);
    assert(failing.status >= 500, `forced receipt failure must surface as server failure, got ${failing.status}`);
    const failureCounts = await counts(database, FAILURE_CARD, "risk-doc-failure");
    assert(failureCounts.facts === 0 && failureCounts.events === 0 && failureCounts.receipts === 0 && failureCounts.status === "approval",
      `receipt failure did not roll back all writes: ${JSON.stringify(failureCounts)}`);

    console.log(JSON.stringify({ ok: true, initialEligible: initial.eligible, genericCompletionStatus: generic.status, firstApplicationStatus: first.status, replayStatus: replay.status, conflictStatus: different.status, forcedFailureStatus: failing.status }, null, 2));
  } finally {
    if (database) await database.end({ timeout: 5 }).catch(() => {});
    await stop(next);
    await stop(container);
    if (container?.exitCode === null) run("docker", ["rm", "-f", containerName]);
    if (logs.length > 0 && process.exitCode) console.error(logs.slice(-12).join(""));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
