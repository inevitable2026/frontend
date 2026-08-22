// docs/migration-board.sql 을 실제 Postgres 에 적용한다.
//
//   node scripts/apply-board-migration.mjs            적용한다
//   node scripts/apply-board-migration.mjs --check    적용하지 않고 지금 상태만 본다
//
// DATABASE_URL 은 레포 루트의 .env.local 에서 읽는다. node_modules 해석 때문에
// **반드시 레포 루트에서** 돌려야 한다.
//
// 파일 전체를 한 번의 simple query 로 보낸다. 파일 자신이 begin 으로 열고 commit 으로
// 닫으므로 중간에 어느 문장이 실패하면 앞의 문장까지 통째로 되돌아간다. 부분 적용된
// 스키마가 남으면 store-pg.ts 의 ensureSchema 가 "무엇이 없는지" 를 말해 주긴 하지만,
// 되돌리는 일은 사람이 손으로 해야 해서 처음부터 원자적으로 보내는 편이 낫다.
//
// 마이그레이션 자체가 재실행 가능하게 쓰여 있다(create ... if not exists, 제약은 do 블록).
// 그래서 이 스크립트도 몇 번을 돌려도 같은 상태로 수렴한다.
//
// public 스키마에는 읽기 질의만 보낸다. 적용 전후로 기존 테이블의 건수를 세어 하나라도
// 달라졌으면 그 사실을 화면에 찍는다 — 이 파일에 public 을 고치는 문장은 없어야 하고,
// 숫자가 움직였다면 그 전제가 깨진 것이다.

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const SQL_FILE = path.join(ROOT, "docs/migration-board.sql");

// board 스키마에 있어야 하는 다섯 테이블. lib/board/store-pg.ts 의 TABLES 와 같아야 한다.
const TABLES = ["work_items", "snapshot_facts", "detection_events", "invalidations", "work_item_events"];

// 적용 전후로 세는 public 테이블. 이 숫자가 움직이면 마이그레이션이 남의 데이터를
// 건드렸다는 뜻이라 즉시 드러나야 한다.
const PUBLIC_TABLES = [
  "sites", "documents", "document_chunks", "document_files", "ingest_jobs",
  "assessments", "tbm_plans", "tbm_records", "day_entries", "work_logs",
];

export function readEnv() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) throw new Error(".env.local 이 없습니다. DATABASE_URL 을 넣으세요.");
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, "")];
      }),
  );
}

export function connect(env) {
  if (!env.DATABASE_URL) throw new Error(".env.local 에 DATABASE_URL 이 없습니다.");
  return postgres(env.DATABASE_URL, {
    max: 1,
    prepare: false,
    // 마이그레이션의 [0] 블록이 raise notice 로 실제 컬럼 타입을 찍는다. 그 값이 이
    // 파일의 전제이므로 삼키지 않고 그대로 보여 준다.
    onnotice: (notice) => console.log(`  [notice] ${notice.message}`),
  });
}

/** public 쪽 건수를 센다. 읽기만 한다. */
export async function countPublic(sql) {
  const counted = {};
  for (const name of PUBLIC_TABLES) {
    try {
      const rows = await sql.unsafe(`select count(*)::int as n from public.${name}`);
      counted[name] = rows[0].n;
    } catch {
      counted[name] = null; // 그런 테이블이 없다는 뜻이다. 만들지 않는다.
    }
  }
  return counted;
}

async function boardTables(sql) {
  const rows = await sql`
    select t.name, to_regclass('board.' || t.name) is not null as present
      from unnest(${TABLES}::text[]) as t(name)
  `;
  return Object.fromEntries(rows.map((r) => [r.name, r.present]));
}

async function main() {
  const check = process.argv.includes("--check");
  const sql = connect(readEnv());

  try {
    const before = await countPublic(sql);
    console.log("public 건수(적용 전):", JSON.stringify(before));
    console.log("board 테이블(적용 전):", JSON.stringify(await boardTables(sql)));

    if (check) {
      console.log("--check 이므로 적용하지 않고 끝냅니다.");
      return;
    }

    const text = fs.readFileSync(SQL_FILE, "utf8");
    console.log(`\n${path.relative(ROOT, SQL_FILE)} 적용 중...`);
    // simple() 이어야 여러 문장을 한 번에 보낼 수 있다. 확장 프로토콜은 문장 하나만 받는다.
    await sql.unsafe(text).simple();
    console.log("적용했습니다.");

    const present = await boardTables(sql);
    const missing = TABLES.filter((name) => !present[name]);
    if (missing.length > 0) {
      throw new Error(`적용했는데 board.${missing.join(" · board.")} 가 보이지 않습니다.`);
    }
    console.log("board 테이블(적용 후):", JSON.stringify(present));

    const types = await sql`
      select table_name, column_name, data_type
        from information_schema.columns
       where table_schema = 'board' and column_name in ('site_id', 'source_doc_id')
       order by table_name, column_name
    `;
    for (const t of types) console.log(`  board.${t.table_name}.${t.column_name} = ${t.data_type}`);

    const constraints = await sql`
      select conname from pg_constraint
       where connamespace = 'board'::regnamespace and contype = 'f'
       order by conname
    `;
    console.log("  외래 키:", constraints.map((c) => c.conname).join(" · ") || "(없음)");

    const after = await countPublic(sql);
    console.log("public 건수(적용 후):", JSON.stringify(after));
    const moved = PUBLIC_TABLES.filter((name) => before[name] !== after[name]);
    if (moved.length > 0) {
      console.error(`⚠ public 건수가 달라졌습니다: ${moved.join(" · ")}. 이 파일에는 그럴 문장이 없어야 합니다.`);
      process.exitCode = 1;
    } else {
      console.log("public 건수는 그대로입니다.");
    }
  } finally {
    await sql.end();
  }
}

// 다른 스크립트가 readEnv · connect · countPublic 만 가져다 쓸 수 있게, 직접 실행할
// 때에만 main 을 돈다.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
