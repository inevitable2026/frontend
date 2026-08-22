// SAFEGRID 의 위험성평가를 board.context_chunks 에 색인한다.
//
//   node scripts/apply-board-migration.mjs      ← 먼저 [9] 의 표를 만든다
//   node scripts/index-assessments.mjs          색인한다(임베딩을 부른다)
//   node scripts/index-assessments.mjs --dry-run  임베딩·쓰기 없이 몇 건이 색인될지만 센다
//
// SAFEGRID_API_URL · UPSTAGE_API_KEY · DATABASE_URL 은 레포 루트의 .env.local 에서
// 읽는다. node_modules 해석 때문에 **반드시 레포 루트에서** 돌려야 한다.
// 값은 어디에도 찍지 않는다 — 있는지 없는지만 말한다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 이 종류만 색인하는가
//
// 사내 문서는 tbm-check 가 public.document_chunks 에 임베딩까지 넣어 두었고 챗봇은
// 그것을 읽기만 한다. 위험성평가만은 그 저장소에 없다 — SAFEGRID 라는 별개 서비스의
// DB 에 있고 임베딩이 붙어 있지 않다. 그 하나를 이 레포 소유의 board 스키마로 옮겨
// 담는 것이 이 스크립트다. **public 스키마에는 한 글자도 쓰지 않는다.**
//
// ─────────────────────────────────────────────────────────────────────────────
// 알려진 한계 — 현장 필터가 없다
//
// SAFEGRID 의 `GET /assessments` 는 인스턴스 전체를 돌려준다(app/api/risk/list/route.ts
// 의 같은 주석). 저쪽에 현장 개념이 없어 좁힐 수단이 아예 없다. 따라서 이 색인에는
// **다른 사람이 만든 평가도 섞인다.** 검색 결과를 "우리 현장의 기록" 이라고 말하면
// 안 되고, 그 사실은 실행할 때마다 화면에 찍힌다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 멱등성
//
// 몇 번을 돌려도 행이 늘지 않는다.
//   on conflict (source_kind, source_id, seq) do update  ← 같은 자리는 덮는다
//   delete ... where seq >= 이번_행수                      ← 줄어든 꼬리를 지운다
//
// 꼬리를 지우는 것이 중요하다. 평가를 고쳐 12행이 8행이 되면 9~12행이 색인에 남고,
// 그 행들은 원본에 더 이상 없는 위험요인이다. 지우지 않으면 챗봇이 존재하지 않는
// 행을 근거로 인용하게 된다.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { connect, readEnv } from "./apply-board-migration.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// lib/agent/assessment-index.ts 의 SOURCE_KIND 와 같은 값이어야 한다. .ts 를 node 가 바로
// 읽지 못해 여기서 다시 적는다. seed-board.mjs 의 assertSiteConstants 와 같은 이유로
// 아래 상수대조()가 실행할 때마다 파일을 읽어 맞춰 보고 다르면 멈춘다 — 두 곳이 갈라지면
// 색인은 성공하는데 검색이 0건을 돌려주고, 그 조합은 원인이 가장 안 보이는 고장이다.
const SOURCE_KIND = "위험성평가";

// 임베딩 예산. 한 평가의 행 전부(6~12줄)를 한 번에 보내므로 호출당 여유를 넉넉히 준다.
// 짧게 잡으면 행이 많은 평가에서만 간헐적으로 실패해 원인을 찾기 어렵다.
const 임베딩_예산 = { limitMs: 60_000 };

/* ------------------------------------------------------------------ 상수 대조 */

function 상수대조() {
  const text = readFileSync(path.join(ROOT, "lib/agent/assessment-index.ts"), "utf8");
  const matched = /const SOURCE_KIND = "([^"]*)"/.exec(text);
  if (!matched) throw new Error("lib/agent/assessment-index.ts 에 SOURCE_KIND 가 없습니다.");
  if (matched[1] !== SOURCE_KIND) {
    throw new Error(
      `lib/agent/assessment-index.ts 의 SOURCE_KIND('${matched[1]}')와 이 스크립트의 값('${SOURCE_KIND}')이 다릅니다. ` +
        `이대로 색인하면 넣은 행을 검색이 한 건도 찾지 못합니다.`,
    );
  }
}

/* ---------------------------------------------------------------- TS 불러오기 */

// lib/** 는 TypeScript 라 node 가 바로 못 읽는다. scripts/verify/detect.mjs ·
// scripts/seed-board.mjs 와 같은 방식으로 임시 디렉터리에 CommonJS 로 컴파일하고
// "@/…" 별칭을 상대 경로로 바꿔 require 한다. 레포의 어떤 파일도 고치지 않는다.
function 모듈불러오기() {
  const work = mkdtempSync(path.join(tmpdir(), "index-assessments-"));
  const outDir = path.join(work, "build");
  const tsconfig = path.join(work, "tsconfig.json");

  // ▼ node_modules 를 임시 디렉터리에 이어 준다. **없으면 그 자리에서 죽는다.**
  //
  // seed-board.mjs 가 컴파일하는 lib/detect 는 외부 패키지를 하나도 안 쓴다. 여기는
  // 다르다 — lib/context/db.ts 가 `require("postgres")` 를 하는데, 컴파일 결과가
  // /tmp 아래에 있어 node 가 위로 올라가며 찾아도 이 레포의 node_modules 에 닿지 못하고
  // MODULE_NOT_FOUND 로 멈춘다. 실제로 밟았다. 심볼릭 링크 하나면 build/lib/**/*.js 에서
  // 위로 올라가는 해석이 그대로 들어맞는다.
  symlinkSync(path.join(ROOT, "node_modules"), path.join(work, "node_modules"), "dir");

  const entries = [
    "lib/risk/safegrid.ts",
    "lib/context/upstage-doc.ts",
    "lib/context/db.ts",
    "lib/agent/assessment-index.ts",
  ].map((rel) => path.join(ROOT, rel));

  writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["esnext"],
          // safegrid.ts 와 upstage-doc.ts 가 process.env 를 읽는다. node 타입이 없으면
          // 그 한 줄 때문에 컴파일이 죽는다.
          types: ["node"],
          // tsconfig 가 임시 디렉터리에 있어 node_modules 를 위로 못 찾는다. 경로를 박아 준다.
          typeRoots: [path.join(ROOT, "node_modules", "@types")],
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
        files: entries,
      },
      null,
      2,
    ),
  );

  execFileSync("npx", ["tsc", "-p", tsconfig], { cwd: ROOT, stdio: "inherit" });

  (function 별칭바꾸기(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        별칭바꾸기(full);
        continue;
      }
      if (!full.endsWith(".js")) continue;
      const before = readFileSync(full, "utf8");
      const after = before.replace(/require\("@\/([^"]*)"\)/g, (_m, rel) => {
        let r = path.relative(path.dirname(full), path.join(outDir, rel)).replace(/\\/g, "/");
        if (!r.startsWith(".")) r = `./${r}`;
        return `require("${r}")`;
      });
      if (after !== before) writeFileSync(full, after);
    }
  })(outDir);

  const req = createRequire(path.join(outDir, "noop.cjs"));
  const safegrid = req(path.join(outDir, "lib/risk/safegrid.js"));
  const upstage = req(path.join(outDir, "lib/context/upstage-doc.js"));
  const dbmod = req(path.join(outDir, "lib/context/db.js"));
  const index = req(path.join(outDir, "lib/agent/assessment-index.js"));

  return {
    평가목록: safegrid.평가목록,
    평가읽기: safegrid.평가읽기,
    embedPassages: upstage.embedPassages,
    // 벡터 리터럴을 여기서 손으로 만들지 않는다. 저장하는 형식과 검색하는 형식이
    // 갈라지면 거리 계산이 조용히 틀린다.
    toVectorLiteral: dbmod.toVectorLiteral,
    assessmentRows: index.assessmentRows,
  };
}

/* -------------------------------------------------------------------- 환경변수 */

// .env.local 의 값을 process.env 로 옮긴다. lib/** 는 process.env 만 읽기 때문이다.
// **값은 찍지 않는다.** 있는지 없는지만 말한다.
function 환경준비() {
  const env = readEnv();
  for (const key of ["SAFEGRID_API_URL", "UPSTAGE_API_KEY", "DATABASE_URL"]) {
    if (env[key]) process.env[key] = env[key];
  }
  const 없는것 = ["SAFEGRID_API_URL", "UPSTAGE_API_KEY", "DATABASE_URL"].filter(
    (key) => !process.env[key],
  );
  if (없는것.length > 0) {
    throw new Error(`.env.local 에 ${없는것.join(" · ")} 이 없습니다.`);
  }
  return env;
}

/* ------------------------------------------------------------------- 건수 세기 */

// 표가 아직 없으면 null 을 돌려준다. 마이그레이션은 사람이 돌리므로 없는 것이
// 정상적인 중간 상태다. 다만 실제 색인은 그 상태에서 시작하면 안 된다.
async function 건수(sql) {
  try {
    // 별칭을 ASCII 로 둔다. 한글 식별자도 Postgres 가 받기는 하지만, 이 스크립트는
    // 사람이 손으로 돌려 보는 것이고 별칭 인코딩 때문에 죽는 자리를 만들 이유가 없다.
    const [row] = await sql`
      select count(*)::int as rows, count(distinct source_id)::int as sources
        from board.context_chunks
       where source_kind = ${SOURCE_KIND}
    `;
    return { 행: row.rows, 평가: row.sources };
  } catch (err) {
    if (err.code === "42P01" || err.code === "3F000") return null;
    throw err;
  }
}

/* --------------------------------------------------------------------- 적재 */

async function 평가색인(sql, { id, title, 줄들, 벡터들, toVectorLiteral }) {
  for (let seq = 0; seq < 줄들.length; seq += 1) {
    await sql`
      insert into board.context_chunks (source_kind, source_id, site_id, title, seq, text, embedding)
      values (
        ${SOURCE_KIND}, ${id},
        -- SAFEGRID 의 Assessment.site 는 자유 문자열이라 public.sites.id 로 이어지지
        -- 않는다. 억지로 매칭하면 남의 현장에 붙으므로 비워 둔다.
        null,
        ${title}, ${seq}, ${줄들[seq]}, ${toVectorLiteral(벡터들[seq])}::halfvec
      )
      on conflict (source_kind, source_id, seq) do update set
        title     = excluded.title,
        text      = excluded.text,
        embedding = excluded.embedding,
        site_id   = excluded.site_id
    `;
  }

  // 줄어든 꼬리를 지운다. 남겨 두면 원본에 없는 행이 검색에 계속 잡힌다.
  const 지운것 = await sql`
    delete from board.context_chunks
     where source_kind = ${SOURCE_KIND} and source_id = ${id} and seq >= ${줄들.length}
    returning seq
  `;
  return 지운것.length;
}

/* --------------------------------------------------------------------- 실행부 */

async function main() {
  상수대조();

  const dryRun = process.argv.includes("--dry-run");
  const env = 환경준비();

  const { 평가목록, 평가읽기, embedPassages, toVectorLiteral, assessmentRows } = 모듈불러오기();

  const sql = connect(env);
  try {
    const 전 = await 건수(sql);
    if (전 === null) {
      console.log("board.context_chunks: 아직 없습니다.");
      if (!dryRun) {
        throw new Error(
          "board.context_chunks 가 없습니다. docs/migration-board.sql [9] 를 먼저 적용하세요 " +
            "(node scripts/apply-board-migration.mjs). 임베딩을 부르기 전에 멈춥니다.",
        );
      }
    } else {
      console.log(`board.context_chunks(색인 전): 평가 ${전.평가}건 · 행 ${전.행}줄`);
    }

    const { days } = await 평가목록();
    const 평가들 = (days ?? []).flatMap((day) => day.items ?? []);
    console.log(`SAFEGRID 평가 ${평가들.length}건 · 일자 ${(days ?? []).length}개`);
    console.log(
      "⚠ SAFEGRID 는 인스턴스 전체를 돌려주며 현장 필터가 없습니다. " +
        "여기 색인되는 평가에는 다른 사람이 만든 것도 섞입니다.",
    );

    let 총줄 = 0;
    let 건너뜀 = 0;
    let 실패 = 0;

    for (let i = 0; i < 평가들.length; i += 1) {
      const { id, title, created_at: 생성 } = 평가들[i];
      const 머리 = `[${i + 1}/${평가들.length}] ${id} · ${title ?? "(제목 없음)"}`;

      let 줄들;
      try {
        줄들 = assessmentRows(await 평가읽기(id));
      } catch (err) {
        // 한 건이 실패해도 나머지는 색인한다. 저쪽 평가 하나가 깨졌다고 색인 전체가
        // 없는 상태로 남으면 챗봇이 "기록이 없습니다" 라고 답한다.
        console.warn(`${머리} · 읽기 실패 — ${err.message}`);
        실패 += 1;
        continue;
      }

      if (줄들.length === 0) {
        console.log(`${머리} · 행 0줄 — 건너뜁니다(hazards 가 비었습니다).`);
        건너뜀 += 1;
        continue;
      }
      총줄 += 줄들.length;

      if (dryRun) {
        console.log(`${머리} · ${줄들.length}줄 (${생성 ?? "생성일 미상"})`);
        continue;
      }

      const 시작 = Date.now();
      const 벡터들 = await embedPassages(줄들, 임베딩_예산);
      const 임베딩ms = Date.now() - 시작;
      const 지운수 = await 평가색인(sql, { id, title: title ?? id, 줄들, 벡터들, toVectorLiteral });
      console.log(
        `${머리} · ${줄들.length}줄 · 임베딩 ${(임베딩ms / 1000).toFixed(1)}초` +
          (지운수 > 0 ? ` · 꼬리 ${지운수}줄 삭제` : ""),
      );
    }

    console.log(
      `\n평가 ${평가들.length}건 가운데 색인 대상 ${평가들.length - 건너뜀 - 실패}건 · 행 ${총줄}줄` +
        (건너뜀 > 0 ? ` · 건너뜀 ${건너뜀}건` : "") +
        (실패 > 0 ? ` · 읽기 실패 ${실패}건` : ""),
    );

    // 읽기 실패는 dry-run 에서도 종료 코드에 남긴다. 몇 건이 색인될지를 세러 돌린
    // 것인데 그 수가 저쪽 고장 때문에 줄어든 것이라면 0 으로 끝내면 안 된다.
    if (실패 > 0) process.exitCode = 1;

    if (dryRun) {
      console.log("--dry-run 이므로 임베딩도 쓰기도 하지 않았습니다.");
      return;
    }

    const 후 = await 건수(sql);
    console.log(`board.context_chunks(색인 후): 평가 ${후.평가}건 · 행 ${후.행}줄`);
  } finally {
    await sql.end();
  }
}

await main();
