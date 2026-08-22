import { normalizeNulls } from "@/lib/context/normalize";
import type { DocumentKind, LayoutElement } from "@/lib/context/types";
import { countUpstageCall } from "@/lib/context/upstage-doc";

const UPSTAGE_BASE = "https://api.upstage.ai/v2";
const POLL_INTERVAL_MS = 1_500;

export class StudioError extends Error {}

export type StudioAgent = {
  id: string;
  name: string;
  role: string;
};

/**
 * 문서 종류별 Studio 에이전트.
 *
 * **정정 (2026-08-22 실측):** 여기 적혀 있던 "체인이 안 돈다"는 **틀렸다.**
 * `document-parse → information-extract` 는 Studio 안에서 돈다 — 실제 PDF 로
 * `status=completed`, 첫 실행 약 16초. 원인은 두 가지였다:
 *
 * 1. `next_steps` 는 **`step_name`** 으로 잇는다. 시도했던 `[{id,name}]`·`[{name}]`·`[{id}]`
 *    셋 다 그 키가 없었고, 실패 문구의 *"unknown step **'None'**"* 이 바로 그 뜻이었다.
 * 2. `information-extract` 의 `data.json_schema` 는 v1 의 `{name, schema:{…}}` 래퍼가 아니라
 *    **스키마 본체**(`{type, properties}`)를 받는다.
 *
 * 재현 절차는 `docs/studio-findings.md` 에 있다.
 */
export const STUDIO_AGENTS: Record<DocumentKind, { slug: string; role: string }> = {
  하도급계약서: { slug: "sitectx-contract", role: "계약 조항·금액·공기 판독" },
  위험성평가표: { slug: "sitectx-assessment", role: "평가표 행·위험도 판독" },
  TBM회의록: { slug: "sitectx-tbm", role: "참석자·중점위험 판독" },
  작업표준: { slug: "sitectx-sop", role: "작업단계·보호구 판독" },
  순회점검일지: { slug: "sitectx-patrol", role: "지적사항·조치 판독" },
  메일: { slug: "sitectx-mail", role: "발신자·요청사항·첨부 판독" },
  기타: { slug: "sitectx-general", role: "일반 문서 판독" },
};

function apiKey(): string {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new StudioError("UPSTAGE_API_KEY 가 없습니다.");
  return key;
}

function headers(json = true): Record<string, string> {
  const base: Record<string, string> = { Authorization: `Bearer ${apiKey()}` };
  if (json) base["Content-Type"] = "application/json";
  return base;
}

async function fail(res: Response, what: string): Promise<never> {
  throw new StudioError(`${what} 실패 (${res.status}) ${(await res.text().catch(() => "")).slice(0, 300)}`);
}

/** 계정의 에이전트 목록에서 slug 로 찾는다. 매 실행마다 만들지 않기 위해서다. */
export async function findAgents(): Promise<Map<string, string>> {
  const res = await fetch(`${UPSTAGE_BASE}/agents`, { headers: headers(false), cache: "no-store" });
  if (!res.ok) await fail(res, "에이전트 목록");
  const body = (await res.json()) as { data?: Array<{ id: string; name: string }> };
  return new Map((body.data ?? []).map((a) => [a.name, a.id]));
}

/**
 * 에이전트가 실제로 돌릴 config 의 id.
 *
 * `published_config_id` 가 아니라 **`default_config_id`** 를 먼저 본다. 발행(`/publish`)은
 * 404 고 `PATCH published_config_id` 는 200 이 와도 반영되지 않았다(`docs/studio-findings.md:74`).
 * 실측으로 실행된 것은 default 쪽이다.
 */
async function defaultConfigId(agentId: string): Promise<string | null> {
  const res = await fetch(`${UPSTAGE_BASE}/agents/${agentId}`, { headers: headers(false), cache: "no-store" });
  if (!res.ok) return null;
  const a = (await res.json()) as { default_config_id?: string; published_config_id?: string };
  return a.default_config_id ?? a.published_config_id ?? null;
}

export async function resolveAgent(kind: DocumentKind): Promise<StudioAgent> {
  const wanted = STUDIO_AGENTS[kind] ?? STUDIO_AGENTS.기타;
  const found = await findAgents();
  const id = found.get(wanted.slug);
  if (id) return { id, name: wanted.slug, role: wanted.role };

  // 종류 전용 에이전트가 없으면 일반 에이전트로 내려간다. 계정에 `sitectx-mail` 이
  // 실제로 없어서(2026-08-22 확인) 메일 문서가 통째로 실패하던 자리다.
  //
  // 다만 **조용히 내려가지 않는다.** 일반 에이전트는 종류 전용 필드(발신자·회신기한 등)를
  // 모르므로 결과가 얇아진다. 그걸 모른 채 "추출됨"으로 보이면 안 되니 역할 문구에 남긴다.
  const 대체 = found.get(STUDIO_AGENTS.기타.slug);
  if (대체) {
    return {
      id: 대체,
      name: STUDIO_AGENTS.기타.slug,
      role: `${wanted.role} — 전용 에이전트(${wanted.slug})가 없어 일반 판독으로 대체했습니다. 종류 전용 필드는 비어 옵니다.`,
    };
  }

  throw new StudioError(
    `Studio 에이전트 "${wanted.slug}" 도 "${STUDIO_AGENTS.기타.slug}" 도 없습니다. ` +
      `\`node scripts/provision-agents.mjs --apply\` 로 만드세요.`,
  );
}

/**
 * 문서를 Upstage 에 한 번 올린다. 돌려받은 `file_id` 는 **여러 실행에 재사용**할 수 있다.
 *
 * 이게 중요한 이유는 아래 「한 번 올리고 두 번 돌린다」에 있다. 예전에는 레이아웃과 필드가
 * 각자 파일을 올려 같은 문서가 두 번 Upstage 에 올라갔다.
 */
export async function uploadFile(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), filename);
  countUpstageCall();
  const res = await fetch(`${UPSTAGE_BASE}/files`, {
    method: "POST",
    headers: headers(false),
    body: form,
    cache: "no-store",
  });
  if (!res.ok) await fail(res, "파일 업로드");
  return ((await res.json()) as { id: string }).id;
}

/**
 * 올린 파일을 지운다. 계약서에는 계약금액·담당자명이 들어 있어 남길 이유가 없다.
 *
 * 삭제 실패로 본 작업을 무너뜨리지 않는다. 다만 **남는다는 것은 알고 있어야 한다** —
 * 조용히 삼키지 말고 부르는 쪽이 로그를 남길 수 있게 성패를 돌려준다.
 */
export async function deleteFile(fileId: string): Promise<boolean> {
  try {
    const res = await fetch(`${UPSTAGE_BASE}/files/${fileId}`, {
      method: "DELETE",
      headers: headers(false),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 한 번 올리고 두 번 돌린다
 *
 * **실측으로 정해진 구조다(2026-08-22).** 왜 이렇게 생겼는지 남겨 둔다. 안 그러면
 * "체인 하나로 합치면 되잖아"로 되돌아온다.
 *
 * ① 체인 응답은 **마지막 스텝의 출력만** 담는다.
 *    `include:["all"]` 로 돌려도 `output` 길이가 1이고 `output[0].model === "extract"` 다.
 *    `["step_outputs"]`·`["parse"]`·`["intermediate"]` 는 전부 400 이다. 즉 체인을 돌리면
 *    **레이아웃(elements·좌표)은 버려진다.**
 *
 * ② `information-extract` 는 단독으로 못 돈다.
 *    텍스트를 주면 `parse_result is required` 로 실패한다. parse 결과를 직접 먹여 보려고
 *    top-level `parse_result`, `content.type="parse_result"`, parse JSON 을 `input_text` 로
 *    주는 세 가지를 다 시도했지만 전부 거절당했다. `parse_result` 는 **체인 안에서만** 흐른다.
 *
 * ①과 ②를 겹치면 답은 하나다 — 레이아웃과 필드를 둘 다 얻으려면 **두 번 돌려야 한다.**
 * 대신 `/v2/files` 의 `file_id` 는 재사용되므로 **업로드는 한 번**으로 줄인다.
 *
 *     upload ──┬─→ sitectx-layout        (parse 단독)      → elements·좌표
 *              └─→ sitectx-<종류> 체인    (parse→extract)   → 필드
 *
 * 예전(업로드 2회 + v1 extract)보다 업로드가 절반이고, v1 의존이 사라진다.
 * ------------------------------------------------------------------ */

/** config 에 적힌 체인 한 칸. 화면이 "무엇을 거쳤는지" 를 말할 때 쓴다. */
export type ChainStep = { name: string; type: string; isFirst: boolean; next: string[] };

type ConfigResponse = {
  id: string;
  steps: Array<{
    name: string;
    type: string;
    is_first: boolean;
    next_steps: Array<{ step_name?: string; name?: string }>;
  }>;
};

/** 에이전트의 기본 config 를 읽어 체인 모양을 확인한다. 실행 전에 무엇을 돌릴지 알아야 한다. */
export async function readChain(agentId: string, configId: string): Promise<ChainStep[]> {
  const res = await fetch(`${UPSTAGE_BASE}/agents/${agentId}/configs/${configId}`, {
    headers: headers(false),
    cache: "no-store",
  });
  if (!res.ok) await fail(res, "config 조회");
  const cfg = (await res.json()) as ConfigResponse;

  return cfg.steps.map((s) => ({
    name: s.name,
    type: s.type,
    isFirst: s.is_first,
    // 런타임이 읽는 키는 step_name 이다. name 은 예전 형식이라 함께 본다.
    next: (s.next_steps ?? []).map((n) => n.step_name ?? n.name ?? "").filter(Boolean),
  }));
}


/** 실행 한 번의 날것 결과. parse 든 chain 이든 이 모양으로 돌아온다. */
type RunResult = {
  text: string;
  finalStep: string | null;
  elapsedMs: number;
  cached: boolean;
  jobId: string;
};

/**
 * 이미 올라간 파일로 에이전트를 한 번 돌리고 최종 출력을 받는다.
 *
 * `runStudioParse` 와 `runStudioChain` 이 같은 폴링 루프를 따로 갖고 있었다. 한쪽만 고친
 * 데드라인·취소 처리가 다른 쪽에 빠지는 자리라 하나로 합친다.
 */
async function runOnFile(agentId: string, fileId: string, deadline: number, 무엇: string): Promise<RunResult> {
  const 시작 = Date.now();
  const 남은 = () => Math.max(1_000, deadline - Date.now());

  countUpstageCall();
  const created = await fetch(`${UPSTAGE_BASE}/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: agentId,
      input: [{ role: "user", content: [{ type: "input_file", file_id: fileId }] }],
      include: ["all"],
    }),
    cache: "no-store",
    // 폴링 루프만 막으면 첫 요청이 매달릴 수 있다. 요청 자체에도 데드라인을 건다.
    signal: AbortSignal.timeout(남은()),
  });
  if (!created.ok) await fail(created, `${무엇} 실행`);
  const jobId = ((await created.json()) as { id: string }).id;

  while (Date.now() < deadline) {
    const polled = await fetch(`${UPSTAGE_BASE}/responses/${jobId}`, {
      headers: headers(false),
      cache: "no-store",
      signal: AbortSignal.timeout(남은()),
    });
    if (!polled.ok) await fail(polled, `${무엇} 상태 조회`);

    const data = (await polled.json()) as {
      status: string;
      error?: { message?: string; step?: string };
      metadata?: { cached?: string };
      output?: Array<{ model?: string; content?: Array<{ text?: string }> }>;
    };

    if (data.status === "failed") {
      throw new StudioError(
        `${무엇} 실패 (${data.error?.step ?? "?"}): ${data.error?.message ?? "이유 없음"}`,
      );
    }
    if (data.status === "completed") {
      // 체인이면 마지막 스텝, 단독이면 유일한 항목 — 어느 쪽이든 끝 항목이 정답이다.
      const last = data.output?.[data.output.length - 1];
      const text = last?.content?.[0]?.text;
      if (!text) throw new StudioError(`${무엇} 응답이 비었습니다.`);
      return {
        text,
        finalStep: last?.model ?? null,
        elapsedMs: Date.now() - 시작,
        // 캐시로 온 것을 실측 소요시간인 척하지 않는다.
        cached: data.metadata?.cached === "true",
        jobId,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new StudioError(`${무엇} 이 제한시간 안에 끝나지 않았습니다.`);
}

export type StudioParseResult = {
  agent: StudioAgent;
  jobId: string;
  elements: LayoutElement[];
  fullText: string;
  pageCount: number;
  elapsedMs: number;
};

/** 레이아웃 전용 에이전트. **체인이 없어야 한다** — 아래 가드가 그것을 지킨다. */
const LAYOUT_SLUG = "sitectx-layout";

/**
 * 레이아웃을 읽는다. 좌표·표·요소가 여기서 나오고, 청킹과 색인이 이것을 먹는다.
 *
 * **반드시 parse 단독 에이전트로 돈다.** 종류별 에이전트(`sitectx-contract` 등)는 이제
 * `parse → extract` 체인이라, 그걸로 돌리면 응답에 오는 것은 extract 의 JSON 이고
 * `elements` 는 없다.
 *
 * 실제로 그렇게 돌고 있었다. 예전 `runStudioParse` 는 종류별 에이전트를 불러
 * `output[0]` 을 파싱했는데, 체인이 붙은 뒤로 그 값이 extract 출력으로 바뀌면서
 * `elements` 가 **0개**가 됐다. 그런데도 잡은 `status=done` 으로 끝났다 — 요소 0 →
 * 청크 0 → 색인 0. 맥락 DB 에 아무것도 안 들어가는데 화면은 성공이라고 말했다.
 *
 * 그래서 아래 두 가지를 **소리 나게** 만든다: 엉뚱한 에이전트면 이름을 대고 거절하고,
 * 요소가 0개면 성공으로 취급하지 않는다.
 */
export async function runStudioParse(fileId: string, deadline: number): Promise<StudioParseResult> {
  const found = await findAgents();
  const id = found.get(LAYOUT_SLUG);
  if (!id) {
    throw new StudioError(
      `레이아웃 에이전트 "${LAYOUT_SLUG}" 가 없습니다. \`node scripts/provision-agents.mjs --apply\` 로 만드세요.`,
    );
  }

  const configId = await defaultConfigId(id);
  if (!configId) throw new StudioError(`"${LAYOUT_SLUG}" 에 config 가 없습니다.`);
  const chain = await readChain(id, configId);
  if (chain.length !== 1 || chain[0].type !== "document-parse") {
    throw new StudioError(
      `"${LAYOUT_SLUG}" 은 parse 단독이어야 하는데 체인이 ${chain
        .map((s) => s.name)
        .join("→")} 입니다. 체인으로 돌리면 elements 가 사라집니다.`,
    );
  }

  const run = await runOnFile(id, fileId, deadline, "레이아웃 판독");
  const parsed = JSON.parse(run.text) as {
    elements?: LayoutElement[];
    content?: { html?: string; markdown?: string; text?: string };
  };
  const elements = parsed.elements ?? [];
  if (elements.length === 0) {
    throw new StudioError(
      `레이아웃 판독이 요소를 한 개도 내지 않았습니다(최종 스텝: ${run.finalStep ?? "?"}). ` +
        `이 상태로 이어 가면 청크와 색인이 조용히 0건이 됩니다.`,
    );
  }

  return {
    agent: { id, name: LAYOUT_SLUG, role: "레이아웃·좌표 판독" },
    jobId: run.jobId,
    elements,
    fullText: parsed.content?.markdown ?? parsed.content?.text ?? "",
    pageCount: elements.reduce((max, e) => Math.max(max, e.page ?? 1), 0) || 1,
    elapsedMs: run.elapsedMs,
  };
}

export type StudioFieldsResult = {
  agent: StudioAgent;
  fields: Record<string, unknown>;
  finalStep: string | null;
  chain: ChainStep[];
  elapsedMs: number;
  cached: boolean;
  jobId: string;
};

/**
 * 종류별 체인(`parse → extract`)을 돌려 필드를 뽑는다. **Studio 안에서** 이어진다.
 *
 * 이 자리는 예전에 v1 `/information-extraction` 이었다. v1 은 문서를 base64 로 다시 실어
 * 보내야 해서 같은 파일이 두 번 올라갔고, Studio 워크플로우도 아니었다.
 */
export async function runStudioFields(
  kind: DocumentKind,
  fileId: string,
  deadline: number,
): Promise<StudioFieldsResult> {
  const agent = await resolveAgent(kind);
  const configId = await defaultConfigId(agent.id);
  const chain = configId ? await readChain(agent.id, configId) : [];
  const run = await runOnFile(agent.id, fileId, deadline, "필드 추출");

  let fields: Record<string, unknown>;
  try {
    // v1 경로가 쓰던 정규화를 그대로 태운다. 모델이 "없음"·"N/A"·빈 문자열을 섞어 뱉는데,
    // 그걸 값으로 취급하면 화면이 없는 정보를 있는 것처럼 보인다.
    fields = normalizeNulls(JSON.parse(run.text)) as Record<string, unknown>;
  } catch {
    throw new StudioError(`필드 추출 결과가 JSON 이 아닙니다: ${run.text.slice(0, 200)}`);
  }

  return {
    agent,
    fields,
    finalStep: run.finalStep,
    chain,
    elapsedMs: run.elapsedMs,
    cached: run.cached,
    jobId: run.jobId,
  };
}
