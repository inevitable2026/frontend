// 문서 종류별 Studio 에이전트를 계정에 맞춘다.
//
//   node scripts/provision-agents.mjs            # 차이만 출력 (기본, 계정을 바꾸지 않는다)
//   node scripts/provision-agents.mjs --apply    # 실제로 반영
//
// **기본이 dry-run 이다.** 이 스크립트는 실계정을 바꾸고, 스텝 id 는 계정 전역에서 유일해야
// 하므로(재사용하면 409) `--apply` 한 번이 되돌릴 수 없는 UUID 를 태운다. 무엇이 달라지는지
// 먼저 보고 나서 반영한다.
//
// 예전 판은 `process.argv` 를 보지 않았고 매 실행이 라이브 POST 였다. 그리고 여섯 에이전트에
// `steps: [{ type: "document-parse", data: {} }]` **하나씩만** 넣어 이름 말고는 전부 같았다.
// 이제 종류마다 `parse → extract` 체인을 두고 extract 의 스키마를 다르게 준다.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const BASE = "https://api.upstage.ai/v2";
const KEY = process.env.UPSTAGE_API_KEY;
if (!KEY) {
  console.error("UPSTAGE_API_KEY 가 없습니다.");
  process.exit(1);
}
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const APPLY = process.argv.includes("--apply");

/* ---------------------------------------------------------------- 스키마 */

const str = (description) => ({ type: "string", description });
const strArray = (description) => ({ type: "array", items: { type: "string" }, description });

// `lib/context/upstage-doc.ts` 의 `commonFields` 와 같은 값이다. 두 곳이 갈라지면
// v1 폴백과 Studio 결과의 모양이 달라져 화면이 둘을 같은 자리에 못 놓는다.
const 공통 = {
  업체명: str("수급업체 또는 시공사 상호"),
  현장명: str("공사 현장 이름"),
  공종: strArray("공종명. 예: 철근콘크리트공사, 토공사"),
  장비: strArray("장비 및 설비 명칭. 예: 이동식크레인, 콘크리트펌프카"),
  자재: strArray("물질 및 자재 명칭. 예: 이형철근, 레미콘, 거푸집"),
};

/**
 * 종류마다 **실제로 다른** 추출 계약.
 *
 * 이것이 AC-24("여섯 종류의 config 가 실질적으로 다르다")의 실체다. 계약서는 금액과 공기를,
 * TBM 은 참석자와 중점위험을, 작업표준은 보호구를 뽑는다 — 문서가 답할 수 있는 것이 다르다.
 */
const 에이전트들 = [
  {
    // 레이아웃 전용. **체인이 아니다.**
    //
    // 체인 응답은 최종 스텝(extract) 출력만 준다 — parse 의 요소와 좌표는 안 나온다
    // (`include` 로도 못 꺼냈다). 그런데 청킹·근거 좌표·오버레이가 그 요소를 쓴다.
    // 그래서 레이아웃만 뽑는 에이전트를 하나 따로 둔다. 파일은 **한 번만 올리고**
    // 같은 file_id 로 이 에이전트와 종류별 체인 에이전트를 부른다.
    slug: "sitectx-layout",
    설명: "레이아웃·좌표 전용 — 청킹과 근거 좌표의 재료",
    속성: null, // parse 하나뿐이라 추출 스키마가 없다
  },
  {
    slug: "sitectx-contract",
    설명: "하도급계약서 — 계약 조항·금액·공기 판독",
    속성: { ...공통, 계약금액: str("계약 총액. 원문 표기 그대로"), 공사기간: str("착공일 ~ 준공일") },
  },
  { slug: "sitectx-assessment", 설명: "위험성평가표 — 평가표 행·위험도 판독", 속성: { ...공통 } },
  {
    slug: "sitectx-tbm",
    설명: "TBM회의록 — 참석자·중점위험 판독",
    속성: {
      ...공통,
      일자: str("회의 일자 YYYY-MM-DD"),
      참석자: strArray("참석자 성명"),
      중점위험요인: str("그날 중점으로 다룬 위험요인 한 줄"),
    },
  },
  {
    slug: "sitectx-sop",
    설명: "작업표준 — 작업단계·보호구 판독",
    속성: { ...공통, 작업명: str("작업표준서의 대상 작업명"), 보호구: strArray("요구되는 개인보호장구") },
  },
  { slug: "sitectx-patrol", 설명: "순회점검일지 — 지적사항·조치 판독", 속성: { ...공통 } },
  { slug: "sitectx-general", 설명: "일반 문서 판독", 속성: { ...공통 } },
];

/**
 * `parse → extract` 체인 한 벌.
 *
 * 두 가지가 이 형식이라야 돈다(`docs/studio-findings.md`):
 * - `next_steps` 는 **`step_name`** 으로 잇는다. `{id}`·`{name}` 은 런타임이 못 읽는다.
 * - `information-extract` 의 `json_schema` 는 v1 의 `{name, schema:{…}}` 래퍼가 아니라
 *   **스키마 본체**(`{type, properties}`)를 받는다.
 */
function 체인(속성) {
  // 속성이 없으면 parse 하나짜리다(레이아웃 전용).
  if (!속성) {
    return [
      { id: randomUUID(), name: "parse", type: "document-parse", data: {}, is_first: true, next_steps: [] },
    ];
  }
  return [
    {
      id: randomUUID(),
      name: "parse",
      type: "document-parse",
      data: {},
      is_first: true,
      next_steps: [{ step_name: "extract" }],
    },
    {
      id: randomUUID(),
      name: "extract",
      type: "information-extract",
      is_first: false,
      next_steps: [],
      data: { json_schema: { type: "object", properties: 속성 } },
    },
  ];
}

/* ---------------------------------------------------------------- 호출 */

async function api(path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** 지금 계정의 config 가 이미 체인인지. 이름이 아니라 **모양**으로 판정한다. */
async function 맞는모양인가(agent, 속성) {
  if (!agent.default_config_id) return false;
  try {
    const cfg = await api(`/agents/${agent.id}/configs/${agent.default_config_id}`);
    const steps = cfg.steps ?? [];
    // 레이아웃 전용은 단일 parse 가 정상이다.
    if (!속성) return steps.length === 1 && steps[0]?.type === "document-parse";
    if (steps.length < 2) return false;
    const first = steps.find((s) => s.is_first);
    return Boolean(first?.next_steps?.some((n) => n.step_name));
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- 실행 */

const { data: 기존 = [] } = await api("/agents");
const 이름으로 = new Map(기존.map((a) => [a.name, a]));

console.log(APPLY ? "모드: --apply (계정을 바꾼다)" : "모드: dry-run (계정을 바꾸지 않는다)");
console.log();

let 만들에이전트 = 0;
let 만들config = 0;

for (const { slug, 설명, 속성 } of 에이전트들) {
  const 있는것 = 이름으로.get(slug);
  const 필드 = 속성 ? Object.keys(속성).join(" · ") : "레이아웃·좌표만 (단일 parse)";

  if (!있는것) {
    console.log(`+ 에이전트 신규  ${slug}`);
    console.log(`    ${필드}`);
    만들에이전트 += 1;
    만들config += 1;
    if (APPLY) {
      const a = await api("/agents", "POST", { name: slug, description: 설명 });
      await api(`/agents/${a.id}/configs`, "POST", { steps: 체인(속성) });
      console.log(`    → ${a.id}`);
    }
    continue;
  }

  if (await 맞는모양인가(있는것, 속성)) {
    console.log(`= 그대로       ${slug}`);
    continue;
  }

  console.log(`~ config 교체  ${slug}  ${속성 ? "(단일 parse → parse+extract 체인)" : "(레이아웃 전용)"}`);
  console.log(`    ${필드}`);
  만들config += 1;
  if (APPLY) {
    const cfg = await api(`/agents/${있는것.id}/configs`, "POST", { steps: 체인(속성) });
    console.log(`    → ${cfg.id}`);
  }
}

console.log();
console.log(`차이: 에이전트 ${만들에이전트}개 신규 · config ${만들config}개 생성`);
if (만들config > 0) {
  // 스텝 id 는 계정 전역 유일이라 되돌릴 수 없다. 몇 개를 태우는지 미리 말한다.
  console.log(`스텝 id ${만들config * 2}개가 영구 소모된다 (재사용 시 409).`);
}
if (!APPLY && 만들config > 0) console.log("반영하려면 --apply 를 붙인다.");
