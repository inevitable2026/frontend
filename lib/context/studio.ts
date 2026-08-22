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
 * 하나의 에이전트에 parse → extract 를 체인으로 엮는 것이 이상적이지만, Studio 런타임이
 * next_steps 를 해석하지 못한다("Step 'parse' next_steps references unknown step 'None'").
 * id · name · 객체 세 가지 참조 형식을 모두 시도했고 결과가 같았다. config publish 는 API 로
 * 노출되어 있지 않다. information-extract · document-classify · instruct · schema-generate 는
 * 모두 parse_result 를 요구해 단독으로 돌지 못한다.
 *
 * 그래서 **역할별 단일 스텝 에이전트를 나눠 두고 파이프라인이 조합**한다. 종류마다 에이전트를
 * 따로 두는 이유는 화면이 "이 구간을 어느 에이전트가 읽었는지" 를 문서별로 짚을 수 있어야
 * 하기 때문이고, 나중에 Studio 가 체인을 고치면 각 에이전트에 extract 스텝만 붙이면 된다.
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
