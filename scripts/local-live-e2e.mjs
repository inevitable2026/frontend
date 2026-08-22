#!/usr/bin/env node
/**
 * A deliberately small, local-only smoke test for the live document pipeline.
 * It does not start the application: run `npm run dev` (with the live gate
 * enabled) separately, then run this script against that localhost instance.
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DEFAULT_PDF = "scripts/make-docs/out/pdf/09_주간_공정표_20260817-0823.pdf";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function localBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--base-url must be an absolute localhost URL.");
  }
  assert(["http:", "https:"].includes(url.protocol) && LOCAL_HOSTS.has(url.hostname), "--base-url must use localhost.");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

export function parseArgs(argv) {
  const options = {
    baseUrl: process.env.BASE ?? "http://localhost:3000",
    pdfPath: DEFAULT_PDF,
    kind: "기타",
    configId: process.env.LOCAL_LIVE_E2E_CONFIG_ID,
    cleanup: false,
    verifyPersistence: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cleanup") options.cleanup = true;
    else if (arg === "--verify-persistence") options.verifyPersistence = true;
    else if (arg === "--base-url" || arg === "--pdf" || arg === "--kind" || arg === "--config-id") {
      const value = argv[++index];
      assert(value && !value.startsWith("--"), `${arg} requires a value.`);
      const names = { "base-url": "baseUrl", pdf: "pdfPath", kind: "kind", "config-id": "configId" };
      options[names[arg.slice(2)]] = value;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function localDatabaseUrl(value) {
  assert(typeof value === "string" && value, "DATABASE_URL is required for --verify-persistence.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid localhost Postgres URL.");
  }
  assert(["postgres:", "postgresql:"].includes(url.protocol) && LOCAL_HOSTS.has(url.hostname),
    "--verify-persistence only accepts a localhost Postgres database.");
  return url.href;
}

export async function verifyLivePersistence({ jobId, documentId, siteId, kind, fetchImpl = fetch }) {
  const connectionString = localDatabaseUrl(process.env.DATABASE_URL);
  assert(typeof process.env.UPSTAGE_API_KEY === "string" && process.env.UPSTAGE_API_KEY,
    "UPSTAGE_API_KEY is required to verify remote Studio file deletion.");
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [proof] = await sql`
      select j.status,
             j.document_id,
             j.cleanup_status,
             j.studio_file_id,
             d.site_id,
             d.kind,
             (select count(*)::int from document_chunks c where c.job_id = j.id and c.document_id = d.id) as chunk_count,
             (select count(*)::int from document_chunks c where c.job_id = j.id and c.document_id is null) as staging_chunk_count,
             (select count(*)::int from document_chunks c where c.job_id = j.id and c.embedding is null) as null_embedding_count,
             (select min(vector_dims(c.embedding))::int from document_chunks c where c.job_id = j.id and c.embedding is not null) as min_dimension,
             (select max(vector_dims(c.embedding))::int from document_chunks c where c.job_id = j.id and c.embedding is not null) as max_dimension,
             (select coalesce(max(octet_length(f.bytes)), 0)::int from document_files f where f.job_id = j.id and f.document_id = d.id) as file_bytes
        from ingest_jobs j
        join documents d on d.id = j.document_id
       where j.id = ${jobId} and d.id = ${documentId}
       limit 1
    `;
    assert(proof, "Saved job/document persistence row is missing.");
    assert(proof.status === "done" && proof.document_id === documentId, "Saved job is not durably completed and bound to the document.");
    assert(proof.cleanup_status === "deleted", "Saved job does not attest to remote Studio file deletion.");
    assert(proof.site_id === siteId && proof.kind === kind, "Saved document persistence does not match the selected site/kind.");
    assert(proof.chunk_count > 0 && proof.staging_chunk_count === 0, "Saved chunks were not fully promoted from staging.");
    assert(proof.null_embedding_count === 0 && proof.min_dimension === 4096 && proof.max_dimension === 4096,
      "Saved chunks do not all contain 4096-dimensional embeddings.");
    assert(proof.file_bytes > 0, "Saved original file bytes were not retained.");
    assert(typeof proof.studio_file_id === "string" && proof.studio_file_id, "Saved job has no remote Studio file audit ID.");

    const remote = await fetchImpl(`https://api.upstage.ai/v2/files/${encodeURIComponent(proof.studio_file_id)}`, {
      headers: { Authorization: `Bearer ${process.env.UPSTAGE_API_KEY}` },
    });
    assert(remote.status === 404, `Deleted remote Studio file returned HTTP ${remote.status} instead of 404.`);
    return {
      chunkCount: proof.chunk_count,
      vectorDimension: proof.min_dimension,
      retainedOriginalBytes: true,
      stagingChunks: proof.staging_chunk_count,
      remoteFileStatus: remote.status,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Parse SSE without assuming event boundaries line up with network chunks. */
export async function readSseEvents(response) {
  assert(response.ok, `SSE request failed with HTTP ${response.status}.`);
  assert(response.body, "SSE response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";

  const consume = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(JSON.parse(data));
  };
  const drain = (final = false) => {
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
    if (final && buffer.trim()) {
      consume(buffer);
      buffer = "";
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
  buffer += decoder.decode();
  drain(true);
  return events;
}

async function json(response, label) {
  assert(response.ok, `${label} failed with HTTP ${response.status}.`);
  return response.json();
}

async function tryCleanup({ fetchImpl, baseUrl, documentId, jobId }) {
  const documentUrl = new URL(`/api/context/documents/${documentId}`, baseUrl);
  const probe = await fetchImpl(documentUrl, { method: "OPTIONS" });
  const allowed = (probe.headers.get("allow") ?? "").toUpperCase().split(/\s*,\s*/);
  // A generic DELETE is not enough: a local endpoint must explicitly attest
  // that it deletes only this document and its originating unsaved job.
  const safeScope = probe.headers.get("x-local-e2e-cleanup") === "document-job-v1";
  if (!allowed.includes("DELETE") || !safeScope) return { attempted: false, reason: "no safe local cleanup API" };
  const deleted = await fetchImpl(documentUrl, {
    method: "DELETE",
    headers: { "x-local-e2e-job-id": jobId, "x-local-e2e-cleanup": "document-job-v1" },
  });
  assert(deleted.ok, `Cleanup failed with HTTP ${deleted.status}.`);
  return { attempted: true, deleted: true };
}

function queryFromDocument(document) {
  const text = document?.chunks?.map((chunk) => chunk?.text).filter((value) => typeof value === "string").join(" ") ?? "";
  // This stays in memory only. It makes the semantic assertion depend on this
  // newly saved document without ever writing its extracted text to stdout.
  const terms = text.match(/[가-힣A-Za-z0-9]{2,}/g)?.slice(0, 5) ?? [];
  return terms.join(" ") || "현장 안전 점검 사항";
}

function assertLiveExecution(execution, { configId, kind }) {
  assert(execution && typeof execution === "object", "Completion has no live Studio execution provenance.");
  assert(execution.mode === "studio", "Completion was not produced by live Studio.");
  assert(execution.source === "실데이터", "Completion did not attest to real Studio data.");
  assert(typeof execution.agentId === "string" && execution.agentId, "Completion has no Studio agent identity.");
  assert(typeof execution.responseId === "string" && execution.responseId, "Completion has no Studio response identity.");
  assert(execution.requestedConfigId === configId, "Completion requestedConfigId does not match the receipt-bound live config.");
  assert(execution.boundByReceipt?.scheme === "request-config-id-v1" && typeof execution.boundByReceipt.id === "string" && execution.boundByReceipt.id,
    "Completion has no receipt-backed requested-config binding.");
  assert(execution.servedConfigEchoVerified === false,
    "Completion must not claim that Studio echoed or attested to the requested config.");
  assert(typeof execution.servedIdentity === "string" && execution.servedIdentity, "Completion has no served Studio identity.");
  assert(Array.isArray(execution.steps), "Completion has no Studio step provenance.");
  assert(execution.steps.length === 2 && execution.steps[0] === "parse" && execution.steps[1] === `extract_${kind}`,
    "Completion must contain only Studio Parse and Extract steps.");
  assert(execution.validation?.owner === "application" && execution.validation.valid === true,
    "Application validation did not accept the Studio extraction.");
  assert(execution.review?.owner === "application" && execution.review.decision === "accepted",
    "Application review did not accept the validated extraction.");
  assert(Number.isInteger(execution.review?.evidenceCount) && execution.review.evidenceCount > 0,
    "Application review acceptance has no evidence.");
  assert(execution.cleanup === "deleted", "Remote Studio file cleanup was not confirmed deleted.");
}

export async function runLocalLiveE2E(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const baseUrl = localBaseUrl(options.baseUrl);
  assert(typeof options.configId === "string" && options.configId.trim(),
    "--config-id (or LOCAL_LIVE_E2E_CONFIG_ID) must pin the expected live Studio config.");
  const bytes = await readFileImpl(resolve(options.pdfPath));
  assert(bytes.byteLength > 0, "Sample PDF is empty.");

  const ingestUrl = new URL("/api/context/ingest", baseUrl);
  ingestUrl.searchParams.set("mode", "live");
  ingestUrl.searchParams.set("kind", options.kind);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), basename(options.pdfPath));
  const job = await json(await fetchImpl(ingestUrl, { method: "POST", body: form }), "Live upload");
  assert(typeof job.jobId === "string" && job.jobId, "Upload response has no jobId.");

  const streamUrl = new URL(`/api/context/ingest/${job.jobId}/stream`, baseUrl);
  const events = await readSseEvents(await fetchImpl(streamUrl));
  const failed = events.find((event) => event?.종류 === "실패");
  assert(!failed, "Live ingestion reported failure.");
  const complete = events.find((event) => event?.종류 === "완료");
  assert(complete, "SSE did not include a completion event.");
  assert(complete.jobId === job.jobId, "Completion event belongs to a different job.");
  assertLiveExecution(complete.execution ?? complete.provenance, { configId: options.configId, kind: options.kind });

  const sites = await json(await fetchImpl(new URL("/api/context/sites", baseUrl)), "Sites fetch");
  const site = sites.sites?.find((candidate) => candidate?.id === complete.추천?.siteId) ?? sites.sites?.[0];
  assert(typeof site?.id === "string" && site.id, "No actual site is available for save.");
  const otherSite = sites.sites?.find((candidate) => candidate?.id && candidate.id !== site.id);
  assert(typeof otherSite?.id === "string" && otherSite.id, "Site isolation requires a second actual site.");
  const title = `local-e2e-${Date.now()}`;
  const saved = await json(await fetchImpl(new URL("/api/context/documents", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.jobId, siteId: site.id, kind: options.kind, title }),
  }), "Document save");
  assert(typeof saved.documentId === "string" && saved.documentId, "Save response has no documentId.");

  const listed = await json(await fetchImpl(new URL(`/api/context/documents?siteId=${encodeURIComponent(site.id)}&q=${encodeURIComponent(title)}`, baseUrl)), "Document list");
  assert(listed.documents?.some((document) => document.id === saved.documentId), "Saved document was not returned by the document list.");
  const isolatedList = await json(await fetchImpl(new URL(`/api/context/documents?siteId=${encodeURIComponent(otherSite.id)}&q=${encodeURIComponent(title)}`, baseUrl)), "Isolated document list");
  assert(!isolatedList.documents?.some((document) => document.id === saved.documentId), "Saved document leaked into another site's document list.");
  const document = await json(await fetchImpl(new URL(`/api/context/documents/${saved.documentId}`, baseUrl)), "Document retrieval");
  assert(document.document?.id === saved.documentId && document.document.site_id === site.id, "Retrieved document does not match the saved document/site.");
  const file = await fetchImpl(new URL(`/api/context/documents/${saved.documentId}/file`, baseUrl));
  assert(file.ok && (file.headers.get("content-type") ?? "").includes("application/pdf"), "Saved PDF file is unavailable.");

  const search = await json(await fetchImpl(new URL("/api/context/search", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: queryFromDocument(document), siteId: site.id, kind: options.kind, k: 8 }),
  }), "Semantic search");
  const citation = search.citations?.find((candidate) => candidate.documentId === saved.documentId);
  assert(citation && typeof citation.page === "number" && typeof citation.excerpt === "string" && citation.excerpt.trim(),
    "Semantic search did not return a usable citation for the saved document.");
  const isolatedSearch = await json(await fetchImpl(new URL("/api/context/search", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: queryFromDocument(document), siteId: otherSite.id, kind: options.kind, k: 8 }),
  }), "Isolated semantic search");
  assert(!isolatedSearch.citations?.some((candidate) => candidate.documentId === saved.documentId),
    "Saved document leaked into another site's semantic search.");

  const persistence = options.verifyPersistence
    ? await (dependencies.verifyPersistence ?? verifyLivePersistence)({
        jobId: job.jobId,
        documentId: saved.documentId,
        siteId: site.id,
        kind: options.kind,
        fetchImpl,
      })
    : null;
  const cleanup = options.cleanup ? await tryCleanup({ fetchImpl, baseUrl, documentId: saved.documentId, jobId: job.jobId }) : null;
  return { baseUrl: baseUrl.origin, jobId: job.jobId, documentId: saved.documentId, siteId: site.id, eventCount: events.length, citations: search.citations.length, persistence, cleanup };
}

function printSummary(result) {
  // Never print the upload, extracted fields, SSE payloads, request headers, or credentials.
  console.log(JSON.stringify({ status: "passed", baseUrl: result.baseUrl, events: result.eventCount, citations: result.citations, persistence: result.persistence ?? "not requested", cleanup: result.cleanup ?? "not requested" }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/local-live-e2e.mjs --config-id <bound-config-id> [--base-url http://localhost:3000] [--pdf path] [--kind 기타] [--verify-persistence] [--cleanup]");
  } else {
    runLocalLiveE2E(options).then(printSummary).catch((error) => {
      console.error(`Local live E2E failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
