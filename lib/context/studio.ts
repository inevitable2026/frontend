import type { DocumentKind, LayoutElement } from "@/lib/context/types";

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

export async function resolveAgent(kind: DocumentKind): Promise<StudioAgent> {
  const wanted = STUDIO_AGENTS[kind] ?? STUDIO_AGENTS.기타;
  const found = await findAgents();
  const id = found.get(wanted.slug);
  if (!id) {
    throw new StudioError(
      `Studio 에이전트 "${wanted.slug}" 가 없습니다. \`node scripts/provision-agents.mjs\` 로 만드세요.`,
    );
  }
  return { id, name: wanted.slug, role: wanted.role };
}

async function uploadFile(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), filename);
  const res = await fetch(`${UPSTAGE_BASE}/files`, {
    method: "POST",
    headers: headers(false),
    body: form,
    cache: "no-store",
  });
  if (!res.ok) await fail(res, "파일 업로드");
  return ((await res.json()) as { id: string }).id;
}

/* ------------------------------------------------------------------ *
 * 체인 실행
 *
 * 지금까지는 parse 만 Studio 로 하고 extract 를 v1 으로 다시 불렀다. 같은 문서를 Upstage 에
 * **두 번 올리는** 낭비였고, 무엇보다 Studio 워크플로우가 아니었다.
 *
 * 아래는 config 에 정의된 체인을 통째로 돌리고 최종 출력을 돌려준다. 중간 스텝의 출력은
 * 응답에 담기지 않는다(`include` 로 꺼내지 못했다) — 그래서 화면에는 **config 에서 읽은 체인
 * 정의**와 **실행 증거**(에이전트·config id · 최종 스텝 이름 · 실측 시간 · 캐시 여부)를 보인다.
 * 없는 중간 결과를 지어내지 않는다.
 * ------------------------------------------------------------------ */

/** config 에 적힌 체인 한 칸. 화면이 "무엇을 거쳤는지" 를 말할 때 쓴다. */
export type ChainStep = { name: string; type: string; isFirst: boolean; next: string[] };

export type StudioChainResult = {
  /** 최종 스텝이 뱉은 텍스트. information-extract 면 JSON 문자열이다. */
  text: string;
  agentId: string;
  configId: string;
  /** 응답이 밝힌 최종 스텝 이름(`output[].model`). */
  finalStep: string | null;
  /** config 에서 읽은 체인 순서. */
  chain: ChainStep[];
  elapsedMs: number;
  /** Upstage 가 캐시로 돌려줬는지. 소요시간을 정직하게 읽으려면 필요하다. */
  cached: boolean;
};

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


/**
 * 에이전트의 체인을 통째로 돌린다. `parse → extract` 가 **Studio 안에서** 이어진다.
 *
 * 기존 `runStudioParse` 와 나란히 둔다. 한 번에 갈아치우면 무엇이 깨졌는지 못 가린다.
 *
 * 파일은 **끝나면 지운다.** 올린 것은 하도급계약서라 계약금액·담당자명이 들어 있고,
 * 성공하든 실패하든 남길 이유가 없다. 삭제 실패가 본 작업을 무너뜨리지는 않게 한다.
 */
export async function runStudioChain(
  agentId: string,
  configId: string,
  bytes: Uint8Array,
  filename: string,
  mime: string,
  deadline: number,
): Promise<StudioChainResult> {
  const 시작 = Date.now();
  const chain = await readChain(agentId, configId);
  const fileId = await uploadFile(bytes, filename, mime);

  try {
    const created = await fetch(`${UPSTAGE_BASE}/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: agentId,
        input: [{ role: "user", content: [{ type: "input_file", file_id: fileId }] }],
        include: ["all"],
      }),
      cache: "no-store",
      // 데드라인을 요청 자체에도 건다. 폴링 루프만 막으면 첫 요청이 매달릴 수 있다.
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    if (!created.ok) await fail(created, "체인 실행");
    const job = (await created.json()) as { id: string };

    while (Date.now() < deadline) {
      const polled = await fetch(`${UPSTAGE_BASE}/responses/${job.id}`, {
        headers: headers(false),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
      });
      if (!polled.ok) await fail(polled, "체인 상태 조회");

      const data = (await polled.json()) as {
        status: string;
        error?: { message?: string; step?: string };
        metadata?: { cached?: string };
        // 최종 스텝 이름이 `model` 로 온다. 스텝별 중간 출력은 담기지 않는다.
        output?: Array<{ model?: string; content?: Array<{ text?: string }> }>;
      };

      if (data.status === "failed") {
        throw new StudioError(
          `Studio 체인 실패 (${data.error?.step ?? "?"}): ${data.error?.message ?? "이유 없음"}`,
        );
      }
      if (data.status === "completed") {
        const last = data.output?.[data.output.length - 1];
        const text = last?.content?.[0]?.text;
        if (!text) throw new StudioError("체인 응답이 비었습니다.");
        return {
          text,
          agentId,
          configId,
          finalStep: last?.model ?? null,
          chain,
          elapsedMs: Date.now() - 시작,
          // 캐시로 온 것을 실측 소요시간인 척하지 않는다.
          cached: data.metadata?.cached === "true",
        };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new StudioError("체인이 제한시간 안에 끝나지 않았습니다.");
  } finally {
    // 성공·실패·시간초과 모두에서 지운다.
    await fetch(`${UPSTAGE_BASE}/files/${fileId}`, { method: "DELETE", headers: headers(false) }).catch(
      () => {
        /* 삭제 실패로 본 작업을 실패시키지 않는다. 다만 남는다는 것은 알고 있어야 한다. */
      },
    );
  }
}

export type StudioParseResult = {
  agent: StudioAgent;
  jobId: string;
  fileId: string;
  elements: LayoutElement[];
  fullText: string;
  pageCount: number;
};

/**
 * Studio 에이전트로 문서를 읽는다.
 *
 * 응답의 `output[0].content[0].text` 가 `/v1/document-digitization` 과 같은 JSON 이라
 * 청킹·좌표 코드를 그대로 쓸 수 있다. 실측 7~8초.
 */
export async function runStudioParse(
  kind: DocumentKind,
  bytes: Uint8Array,
  filename: string,
  mime: string,
  deadline: number,
): Promise<StudioParseResult> {
  const agent = await resolveAgent(kind);
  const fileId = await uploadFile(bytes, filename, mime);

  const created = await fetch(`${UPSTAGE_BASE}/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: agent.id,
      input: [{ role: "user", content: [{ type: "input_file", file_id: fileId }] }],
      include: ["all"],
    }),
    cache: "no-store",
  });
  if (!created.ok) await fail(created, "에이전트 실행");
  const job = (await created.json()) as { id: string };

  while (Date.now() < deadline) {
    const polled = await fetch(`${UPSTAGE_BASE}/responses/${job.id}`, {
      headers: headers(false),
      cache: "no-store",
    });
    if (!polled.ok) await fail(polled, "에이전트 상태 조회");
    const data = (await polled.json()) as {
      status: string;
      error?: { message?: string; step?: string };
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };

    if (data.status === "failed") {
      throw new StudioError(
        `Studio 에이전트 실패 (${data.error?.step ?? "?"}): ${data.error?.message ?? "이유 없음"}`,
      );
    }
    if (data.status === "completed") {
      const text = data.output?.[0]?.content?.[0]?.text;
      if (!text) throw new StudioError("에이전트 응답이 비었습니다.");
      const parsed = JSON.parse(text) as {
        elements?: LayoutElement[];
        content?: { html?: string; markdown?: string; text?: string };
      };
      const elements = parsed.elements ?? [];
      return {
        agent,
        jobId: job.id,
        fileId,
        elements,
        fullText: parsed.content?.markdown ?? parsed.content?.text ?? "",
        pageCount: elements.reduce((max, e) => Math.max(max, e.page ?? 1), 0) || 1,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new StudioError("Studio 에이전트가 예산 안에 끝나지 않았습니다.");
}
