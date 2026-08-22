// 김포 고촌 물류센터 시나리오를 실제 Postgres 의 board 스키마에 적재한다.
//
//   node scripts/apply-board-migration.mjs   ← 먼저 스키마를 만든다
//   node scripts/seed-board.mjs              ← 그 다음 이 스크립트를 돌린다
//
//   node scripts/seed-board.mjs --check      적재하지 않고 지금 건수만 센다
//   node scripts/seed-board.mjs --json       치환된 사본을 data/board/{items,facts}.json 으로도 떨어뜨린다
//
// DATABASE_URL 은 레포 루트의 .env.local 에서 읽는다. node_modules 해석 때문에
// **반드시 레포 루트에서** 돌려야 한다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 무엇을 넣는가
//
//   1. public.sites 에 김포 고촌 물류센터 한 행. code = 'gimpo-gochon' 이 이미 있으면
//      넣지 않고 그 행을 쓴다. 다만 그 행의 id 가 lib/board/site.ts 의 BOARD_SITE_ID 와
//      다르면 **그 자리에서 멈춘다.** 누가 먼저 다른 uuid 로 같은 code 를 넣어 둔 상태를
//      조용히 지나치면 뒤따르는 사실 86건과 카드 11건이 전부 남의 현장에 붙는다.
//   2. board.snapshot_facts ← data/board/seed-facts.json
//   3. board.work_items     ← data/board/seed-items.json (+ 카드가 무효화하는 문서를
//      board.invalidations 에 함께 적는다)
//   4. board.detection_events ← 감지 엔진을 2026-08-19T08:10 기준으로 직접 돌려 나온
//      감지만 넣는다. **엔진이 만든 카드 20장은 버린다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이렇게 하는가 — 되짚을 때 필요한 이유 셋
//
// ▸ siteId 치환. 시드 JSON 은 'site_gimpo_gochon_01' 이라는 사람이 읽는 이름을 쓰고
//   board.*.site_id 는 uuid 다. 원본 JSON 은 고치지 않고 이 스크립트가 읽는 도중에
//   BOARD_SITE_ID 로 덮는다. 시드 파일은 docs/scenario-gimpo-logistics.md 와 짝을 이루는
//   시나리오 기록이라 특정 Railway 인스턴스의 uuid 에 묶이면 안 되고, 100곳 가까운 자리를
//   uuid 로 바꾸면 그 뒤로는 diff 도 grep 도 읽히지 않는다.
//
// ▸ 카드는 시드 한 벌만 넣고 감지 엔진이 만든 카드는 버린다. 엔진의 itemId
//   ('card_t03_letter_0ev3kh2')와 시드의 itemId ('card_letter_structure')는 짓는 규칙이
//   달라 영원히 겹치지 않는다. 둘 다 넣으면 on conflict 병합이 걸리지 않아 같은 일이 두
//   장씩 쌓인다. 게다가 엔진은 초안을 쓰지 못해서(toWorkItems 의 draft 는 언제나 null)
//   엔진 카드로 갈아끼우면 승인 열이 제목만 남은 빈 카드 열이 된다. 시드 카드 넷이 들고
//   있는 실제 초안이 이 화면의 핵심이다.
//   ▶ 따라서 **이 현장에 POST /api/board/detect 를 부르면 안 된다.** 그 라우트는 언제나
//     run.created 를 upsertItems 로 밀어 넣으므로 부르는 순간 카드가 31장이 된다.
//     출구는 정해져 있다. 엔진이 초안을 쓸 수 있게 되는 날 시드 카드 11장을 지우고
//     보드의 주인을 엔진으로 넘긴다.
//
// ▸ store-pg.ts 의 upsertItems 를 쓰지 않고 직접 insert 한다. 그 함수는 item_id 가
//   충돌하면 updated_at 을 nowIso() 로 덮는데, 두 번째 실행에서 시드의 2026-08-19
//   타임스탬프가 오늘로 밀린다. 그러면 dueBy 가 없고 createdAt 이 2026-08-18 인
//   card_mail_parse 가 2026-08-19 보드의 날짜 조건에서 빠져 카드가 10장으로 줄어든다.
//   여기서는 on conflict (item_id) do nothing 을 써서 이미 있는 카드를 건드리지 않는다.
//   그 대가로 board.work_item_events 에 'created' 한 줄이 남지 않는데, 화면이 이력을
//   읽지 않으므로 지금은 감수한다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 멱등성
//
// 몇 번을 돌려도 건수가 늘지 않는다. 세 겹으로 막는다.
//   public.sites          where not exists (code = 'gimpo-gochon')
//   board.snapshot_facts  on conflict (site_id, fact_type, key, observed_at) do update
//   board.work_items      on conflict (item_id) do nothing
//   board.detection_events on conflict (run_id, rule_id, detected_at) do update
// detection 의 run_id 는 실행 시각이 아니라 감지 기준 시각에서 나온다
// ('2026-08-19T08:10' → 'run_20260819_0810'). 그래서 언제 돌려도 같은 값이다.
//
// public 스키마에는 sites 한 행을 넣는 INSERT 말고는 읽기 질의만 보낸다.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { countPublic, connect, readEnv } from "./apply-board-migration.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// lib/board/site.ts 의 상수와 같은 값이어야 한다. .ts 를 node 가 바로 읽지 못해 여기서
// 다시 적는다. 두 곳이 갈라지지 않도록 아래 assertSiteConstants() 가 실행할 때마다
// 파일을 읽어 대조하고 다르면 멈춘다.
const SITE_ID = "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae";
const SITE_CODE = "gimpo-gochon";
const SITE_NAME = "김포 고촌 물류센터";

// 감지 기준 시각. 시드가 재현하는 한 장면의 시각이고 오늘로 옮기지 않는다.
// 사실 86건이 2026-06-04 부터 2026-08-19 까지 걸쳐 있고 규칙 여럿이 그 사이의 간격을
// 세기 때문에(T-08 은 직전 30일 출역, T-01 은 주말 누적 강우) 날짜를 밀면 감지 결과가
// 달라진다. 브리핑의 24시간 창도 이 시각을 기준으로 움직인다.
const DETECT_AT = "2026-08-19T08:10:00+09:00";

const 기대 = { facts: 86, items: 11, detections: 9 };

/* ------------------------------------------------------------------ 상수 대조 */

function assertSiteConstants() {
  const text = fs.readFileSync(path.join(ROOT, "lib/board/site.ts"), "utf8");
  const pairs = [
    ["BOARD_SITE_ID", SITE_ID],
    ["BOARD_SITE_CODE", SITE_CODE],
    ["BOARD_SITE_NAME", SITE_NAME],
  ];
  for (const [name, expected] of pairs) {
    const matched = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(text);
    if (!matched) throw new Error(`lib/board/site.ts 에 ${name} 이 없습니다.`);
    if (matched[1] !== expected) {
      throw new Error(
        `lib/board/site.ts 의 ${name}('${matched[1]}')와 이 스크립트의 값('${expected}')이 다릅니다. ` +
          `두 곳이 갈라진 채로 적재하면 화면이 보는 현장과 데이터가 붙은 현장이 달라집니다.`,
      );
    }
  }
}

/* ------------------------------------------------------ 감지 엔진 컴파일과 적재 */

// lib/detect 는 TypeScript 라 node 가 바로 못 읽는다. scripts/verify/detect.mjs 와 같은
// 방식으로 임시 디렉터리에 CommonJS 로 컴파일하고 "@/…" 별칭을 상대 경로로 바꿔 require 한다.
// 레포의 어떤 파일도 고치지 않는다.
function loadDetectEngine() {
  const work = mkdtempSync(path.join(tmpdir(), "seed-board-"));
  const outDir = path.join(work, "build");
  const tsconfig = path.join(work, "tsconfig.json");

  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["esnext"],
          module: "commonjs",
          moduleResolution: "node",
          strict: false,
          skipLibCheck: true,
          noEmit: false,
          esModuleInterop: true,
          outDir,
          rootDir: ROOT,
          baseUrl: ROOT,
          paths: { "@/*": ["./*"] },
        },
        files: ["lib/detect/rules/index.ts", "lib/detect/engine.ts"].map((rel) => path.join(ROOT, rel)),
      },
      null,
      2,
    ),
  );

  execFileSync("npx", ["tsc", "-p", tsconfig], { cwd: ROOT, stdio: "inherit" });

  (function rewriteAliases(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        rewriteAliases(full);
        continue;
      }
      if (!full.endsWith(".js")) continue;
      const before = fs.readFileSync(full, "utf8");
      const after = before.replace(/require\("@\/([^"]*)"\)/g, (_m, rel) => {
        let r = path.relative(path.dirname(full), path.join(outDir, rel)).replace(/\\/g, "/");
        if (!r.startsWith(".")) r = `./${r}`;
        return `require("${r}")`;
      });
      if (after !== before) fs.writeFileSync(full, after);
    }
  })(outDir);

  const req = createRequire(path.join(outDir, "noop.cjs"));
  const { triggerRules } = req(path.join(outDir, "lib/detect/rules/index.js"));
  const { runDetect } = req(path.join(outDir, "lib/detect/engine.js"));
  return { triggerRules, runDetect };
}

/* ---------------------------------------------------------------------- 시드 */

function readSeed(name) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data/board", name), "utf8"));
  return raw;
}

// 파일 최상위의 "siteId" 키는 읽지 않는다. 각 레코드의 siteId 를 파일 값과 무관하게
// 상수로 덮는다 — 시드가 어떤 이름을 쓰고 있든 결과가 같아지도록.
function 현장덮기(records) {
  return records.map((record) => ({ ...record, siteId: SITE_ID }));
}

// ▼ 결과에 반드시 ::text::jsonb 를 붙인다. ::jsonb 만 붙이면 안 된다.
//
// postgres.js 는 `${문자열}::jsonb` 를 만나면 그 매개변수를 jsonb 로 보내면서 값을 한 번 더
// JSON 으로 감싼다. 그래서 '[]' 를 넣으면 배열이 아니라 문자열 스칼라 '"[]"' 가 들어가고,
// board.work_items 의 jsonb_typeof 체크가 23514 로 거절한다. 실제로 밟았다.
// 중간에 ::text 를 끼우면 매개변수가 text 로 나가고 서버가 그 문자열을 jsonb 로 파싱한다.
//   select ${'[]'}::jsonb       → jsonb_typeof = 'string'   ← 틀림
//   select ${'[]'}::text::jsonb → jsonb_typeof = 'array'    ← 맞음
function json(value) {
  return JSON.stringify(value ?? null);
}

/* ------------------------------------------------------------------- 건수 세기 */

async function 건수(sql) {
  const [facts] = await sql`select count(*)::int as n from board.snapshot_facts where site_id = ${SITE_ID}`;
  const [items] = await sql`select count(*)::int as n from board.work_items where site_id = ${SITE_ID}`;
  const [dets] = await sql`select count(*)::int as n from board.detection_events where site_id = ${SITE_ID}`;
  const [inval] = await sql`select count(*)::int as n from board.invalidations`;
  const [events] = await sql`select count(*)::int as n from board.work_item_events`;
  return {
    "board.snapshot_facts": facts.n,
    "board.work_items": items.n,
    "board.detection_events": dets.n,
    "board.invalidations": inval.n,
    "board.work_item_events": events.n,
  };
}

/* -------------------------------------------------------------------- 적재 단계 */

/**
 * public.sites 에 현장 한 행을 보장한다. 이 스크립트가 public 스키마에 쓰는 유일한 문장이다.
 * 이미 같은 code 가 있으면 넣지 않고, 그 행의 id 가 상수와 다르면 멈춘다.
 */
async function 현장보장(sql) {
  await sql`
    insert into public.sites (id, code, name)
    select ${SITE_ID}::uuid, ${SITE_CODE}, ${SITE_NAME}
     where not exists (select 1 from public.sites where code = ${SITE_CODE})
  `;
  const rows = await sql`select id, code, name from public.sites where code = ${SITE_CODE}`;
  if (rows.length !== 1) {
    throw new Error(`public.sites 에 code='${SITE_CODE}' 인 행이 ${rows.length}개입니다. 하나여야 합니다.`);
  }
  const row = rows[0];
  if (row.id !== SITE_ID) {
    throw new Error(
      `public.sites 의 code='${SITE_CODE}' 행이 이미 다른 uuid(${row.id})로 있습니다. ` +
        `상수는 ${SITE_ID} 입니다. 이대로 적재하면 사실과 카드가 남의 현장에 붙으므로 멈춥니다.`,
    );
  }
  return row;
}

async function 사실적재(sql, facts) {
  for (const fact of facts) {
    await sql`
      insert into board.snapshot_facts (site_id, fact_type, key, value, observed_at, source_doc_id, confidence)
      values (
        ${fact.siteId}::uuid, ${fact.factType}, ${fact.key}, ${json(fact.value)}::text::jsonb,
        ${fact.observedAt}, ${fact.sourceDocId ?? null}, ${fact.confidence ?? 1}
      )
      on conflict (site_id, fact_type, key, observed_at) do update set
        value = excluded.value,
        source_doc_id = excluded.source_doc_id,
        confidence = excluded.confidence
    `;
  }
}

async function 카드적재(sql, items) {
  let 새로 = 0;
  for (const item of items) {
    const rows = await sql`
      insert into board.work_items (
        item_id, site_id, timing, status, origin, title, summary, trigger,
        invalidates, produces, draft, confirmed_by, confirmed_at, due_by,
        estimated_minutes, assignee, delegable, blocked_by, lane_order, created_at, updated_at
      ) values (
        ${item.itemId}, ${item.siteId}::uuid, ${item.timing}, ${item.status}, ${item.origin},
        ${item.title}, ${item.summary ?? null}, ${json(item.trigger)}::text::jsonb,
        ${json(item.invalidates ?? [])}::text::jsonb, ${json(item.produces ?? [])}::text::jsonb, ${json(item.draft)}::text::jsonb,
        ${item.confirmedBy ?? null}, ${item.confirmedAt ?? null}, ${item.dueBy ?? null},
        ${item.estimatedMinutes ?? null}, ${item.assignee ?? null}, ${item.delegable ?? true},
        ${json(item.blockedBy ?? [])}::text::jsonb, ${item.laneOrder ?? 0}, ${item.createdAt}, ${item.updatedAt}
      )
      on conflict (item_id) do nothing
      returning item_id
    `;
    if (rows.length > 0) 새로 += 1;

    // 카드 안에도 jsonb 로 남지만, "어느 문서가 무엇 때문에 유효하지 않은가" 를 문서 쪽에서
    // 되짚으려면 별도 색인이 필요하다. store-pg.ts 의 upsertItems 가 하는 일과 같다.
    for (const inv of item.invalidates ?? []) {
      await sql`
        insert into board.invalidations (item_id, run_id, doc_id, scope, reason, created_at)
        values (${item.itemId}, null, ${inv.docId}, ${inv.scope}, ${inv.reason}, ${item.createdAt})
        on conflict (item_id, doc_id, scope) do update set reason = excluded.reason
      `;
    }
  }
  return 새로;
}

async function 감지적재(sql, run) {
  for (const d of run.detections) {
    await sql`
      insert into board.detection_events (
        run_id, site_id, started_at, rule_id, detected_at, confidence,
        evidence, invalidates, produces, summary, created_item_ids
      ) values (
        ${run.runId}, ${d.siteId}::uuid, ${run.startedAt}, ${d.ruleId}, ${d.detectedAt},
        ${d.confidence}, ${json(d.evidence)}::text::jsonb, ${json(d.invalidates)}::text::jsonb,
        ${json(d.produces)}::text::jsonb, ${d.summary},
        -- ▼ 빈 배열이다. run.created 의 20개 id 는 DB 에 없는 카드를 가리키므로 그대로
        -- 넣으면 나중에 "이 감지가 만든 카드" 를 되짚을 때 거짓 단서가 된다.
        '[]'::jsonb
      )
      on conflict (run_id, rule_id, detected_at) do update set
        confidence       = excluded.confidence,
        evidence         = excluded.evidence,
        invalidates      = excluded.invalidates,
        produces         = excluded.produces,
        summary          = excluded.summary,
        created_item_ids = excluded.created_item_ids
    `;

    for (const inv of d.invalidates ?? []) {
      await sql`
        insert into board.invalidations (item_id, run_id, doc_id, scope, reason, created_at)
        values (null, ${run.runId}, ${inv.docId}, ${inv.scope}, ${inv.reason}, ${run.startedAt})
        on conflict do nothing
      `;
    }
  }
}

/* --------------------------------------------------------------------- 실행부 */

async function main() {
  assertSiteConstants();

  const check = process.argv.includes("--check");
  const dumpJson = process.argv.includes("--json");

  const factsRaw = readSeed("seed-facts.json");
  const itemsRaw = readSeed("seed-items.json");
  const facts = 현장덮기(Array.isArray(factsRaw) ? factsRaw : (factsRaw.facts ?? []));
  const items = 현장덮기(Array.isArray(itemsRaw) ? itemsRaw : (itemsRaw.items ?? []));

  console.log(`시드 사실 ${facts.length}건 · 카드 ${items.length}건 · siteId=${SITE_ID}`);
  if (facts.length !== 기대.facts) console.warn(`⚠ 사실이 ${기대.facts}건이 아니라 ${facts.length}건입니다.`);
  if (items.length !== 기대.items) console.warn(`⚠ 카드가 ${기대.items}건이 아니라 ${items.length}건입니다.`);

  const sql = connect(readEnv());
  try {
    const publicBefore = await countPublic(sql);
    console.log("public 건수(적재 전):", JSON.stringify(publicBefore));
    console.log("board 건수(적재 전):", JSON.stringify(await 건수(sql)));

    if (check) {
      console.log("--check 이므로 적재하지 않고 끝냅니다.");
      return;
    }

    const site = await 현장보장(sql);
    console.log(`현장: ${site.id} · ${site.code} · ${site.name}`);

    await 사실적재(sql, facts);
    const 새카드 = await 카드적재(sql, items);
    console.log(`카드 ${items.length}건 가운데 이번에 새로 꽂힌 것 ${새카드}건.`);

    // 감지는 엔진을 직접 돌려 얻는다. 카드는 버린다.
    const { triggerRules, runDetect } = loadDetectEngine();
    const run = runDetect({ siteId: SITE_ID, now: DETECT_AT, facts, rules: triggerRules });
    console.log(`감지 ${run.detections.length}건 · 엔진이 만든 카드 ${run.created.length}장(버립니다) · runId=${run.runId}`);
    if (run.detections.length !== 기대.detections) {
      console.warn(`⚠ 감지가 ${기대.detections}건이 아니라 ${run.detections.length}건입니다.`);
    }
    await 감지적재(sql, run);

    if (dumpJson) {
      // BOARD_STORE 를 비워 JSON 저장소로 되돌릴 때 쓰는 사본이다. store-json.ts 의 load()
      // 가 items.json 을 seed-items.json 보다 먼저 읽으므로 이 자리에 놓으면 그대로 먹는다.
      // 기본 동작이 아니라 --json 을 준 사람만 만든다 — 시드 원본과 식별자 체계가 달라진다.
      fs.writeFileSync(path.join(ROOT, "data/board/items.json"), `${JSON.stringify({ siteId: SITE_ID, total: items.length, items }, null, 2)}\n`);
      fs.writeFileSync(path.join(ROOT, "data/board/facts.json"), `${JSON.stringify({ siteId: SITE_ID, total: facts.length, facts }, null, 2)}\n`);
      console.log("data/board/items.json · facts.json 에 치환된 사본을 썼습니다.");
    }

    const 후 = await 건수(sql);
    console.log("board 건수(적재 후):", JSON.stringify(후));

    const 분포 = await sql`
      select status, count(*)::int as n from board.work_items where site_id = ${SITE_ID}::uuid group by status order by status
    `;
    console.log("  status 분포:", 분포.map((r) => `${r.status} ${r.n}`).join(" · "));
    const [초안] = await sql`
      select count(*)::int as n from board.work_items
       where site_id = ${SITE_ID}::uuid and draft is not null and jsonb_typeof(draft) = 'object'
    `;
    console.log(`  초안이 붙은 카드: ${초안.n}건`);
    const 규칙 = await sql`
      select rule_id, count(*)::int as n from board.detection_events where site_id = ${SITE_ID}::uuid group by rule_id order by rule_id
    `;
    console.log("  rule_id 분포:", 규칙.map((r) => `${r.rule_id} ${r.n}`).join(" · "));

    const publicAfter = await countPublic(sql);
    console.log("public 건수(적재 후):", JSON.stringify(publicAfter));
    const 움직임 = Object.keys(publicAfter).filter((k) => publicBefore[k] !== publicAfter[k]);
    const 허용 = 움직임.length === 0 || (움직임.length === 1 && 움직임[0] === "sites" && publicAfter.sites === publicBefore.sites + 1);
    if (!허용) {
      console.error(`⚠ public 건수가 예상 밖으로 달라졌습니다: ${움직임.join(" · ")}`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

await main();
