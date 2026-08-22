import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const BASE = "https://api.upstage.ai/v2";
const KEY = process.env.UPSTAGE_API_KEY;
if (!KEY) { console.error("UPSTAGE_API_KEY 가 없습니다."); process.exit(1); }
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const AGENTS = [
  ["sitectx-contract",   "하도급계약서 — 계약 조항·금액·공기 판독"],
  ["sitectx-assessment", "위험성평가표 — 평가표 행·위험도 판독"],
  ["sitectx-tbm",        "TBM회의록 — 참석자·중점위험 판독"],
  ["sitectx-sop",        "작업표준 — 작업단계·보호구 판독"],
  ["sitectx-patrol",     "순회점검일지 — 지적사항·조치 판독"],
  ["sitectx-general",    "일반 문서 판독"],
];

async function api(path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return data;
}

const existing = new Map(((await api("/agents")).data ?? []).map((a) => [a.name, a]));
console.log(`계정에 에이전트 ${existing.size}개\n`);

for (const [slug, description] of AGENTS) {
  const found = existing.get(slug);
  if (found?.default_config_id) {
    console.log(`  = ${slug.padEnd(20)} 이미 있음 (${found.id})`);
    continue;
  }
  const agent = found ?? (await api("/agents", "POST", { name: slug, description }));
  // 스텝 ID 는 계정 전역에서 유일해야 한다 — 재사용하면 409 로 막힌다.
  await api(`/agents/${agent.id}/configs`, "POST", {
    steps: [{ id: randomUUID(), name: `${slug}-parse`, type: "document-parse", data: {}, next_steps: [], is_first: true }],
  });
  console.log(`  + ${slug.padEnd(20)} 생성 (${agent.id})`);
}

console.log("\n확인:");
for (const a of (await api("/agents")).data ?? []) {
  if (!a.name.startsWith("sitectx-")) continue;
  console.log(`  ${a.name.padEnd(20)} ${a.id}  steps=${JSON.stringify(a.used_steps)}  config=${a.default_config_external_id}`);
}
