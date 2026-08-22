import { existsSync, readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "lib/context/demo-fixtures.json";
const pdfPath = process.argv[2];
const kind = process.argv[3] ?? "하도급계약서";

if (!pdfPath) {
  console.error("사용법: node scripts/record-demo.mjs <문서.pdf> [하도급계약서|위험성평가표|TBM회의록|작업표준|순회점검일지|기타]");
  process.exit(1);
}
if (process.env.STUDIO_LIVE_INGEST_ENABLED !== "true") {
  console.error("라이브 데모 녹화는 Gate B/C 완료 후 STUDIO_LIVE_INGEST_ENABLED=true 환경에서만 실행합니다.");
  process.exit(1);
}

const form = new FormData();
form.append("file", new Blob([readFileSync(pdfPath)], { type: "application/pdf" }), pdfPath.split("/").pop());

const ingestUrl = new URL("/api/context/ingest", BASE);
ingestUrl.searchParams.set("kind", kind);
ingestUrl.searchParams.set("mode", "live");
const created = await fetch(ingestUrl, { method: "POST", body: form });
const job = await created.json();
if (!created.ok) {
  console.error("업로드 실패", job);
  process.exit(1);
}
console.log(`녹화 시작: jobId=${job.jobId} kind=${kind}`);

const res = await fetch(`${BASE}/api/context/ingest/${job.jobId}/stream`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const events = [];

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 2);
    if (!block.startsWith("data: ")) continue;
    const event = JSON.parse(block.slice(6));
    if (event.종류 === "단계" && event.단계.상태 === "실행중") continue;
    events.push(event);
    if (event.종류 === "단계") console.log(`  ${event.단계.상태} ${event.단계.이름}`);
  }
}

const finished = events.find((e) => e.종류 === "완료");
if (!finished) {
  console.error("완료 이벤트가 없습니다. 실패한 실행은 녹화하지 않습니다.");
  process.exit(1);
}

const provenance = finished.execution ?? finished.provenance;
const mode = provenance?.mode;
const cleanup = provenance?.cleanup ?? provenance?.cleanupStatus;
const studioSteps = provenance?.steps ?? provenance?.studioSteps;
const normalizedSteps = Array.isArray(studioSteps)
  ? studioSteps.map((step) => String(step).toLowerCase())
  : [];
const hasGraph = ["parse", "extract_", "validate_", "review_"].every((prefix) =>
  normalizedSteps.some((step) => step === prefix || step.startsWith(prefix)),
);
if (mode !== "studio" || !["success", "deleted"].includes(cleanup) || !hasGraph) {
  console.error("완전한 Studio 워크플로만 녹화할 수 있습니다. Parse/Extract/Validate/Review, Studio 모드, cleanup=deleted 증명이 필요합니다.");
  process.exit(1);
}
const extracted = events.find((e) => e.종류 === "단계" && e.단계.이름 === "필드추출")?.단계.산출;
if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
  console.error("종류별 추출 계약이 없어 녹화하지 않습니다.");
  process.exit(1);
}

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { version: 1, fixtures: {} };
const fixture = {
  source: "recorded",
  recordedAt: new Date().toISOString(),
  recording: { agent: provenance.agent ?? "unknown", config: provenance.config ?? provenance.fingerprint ?? "unknown" },
  extracted,
  events: events.map((event) => event.종류 === "완료" ? { ...event, jobId: "", upstageCalls: 0 } : event),
};
existing.fixtures = { ...existing.fixtures, [kind]: fixture };
writeFileSync(OUT, JSON.stringify(existing, null, 2) + "\n", "utf8");
console.log(`\n${OUT} 에 ${kind} 이벤트 ${fixture.events.length}개 저장`);
console.log("이 잡은 라이브로 돌았으므로 저장하지 않고 지웁니다.");

const postgres = (await import("postgres")).default;
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
await sql`delete from ingest_jobs where id = ${job.jobId}`;
await sql.end();
console.log("정리 완료");
