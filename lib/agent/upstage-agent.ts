const UPSTAGE_BASE_URL = "https://api.upstage.ai/v2";
const UPLOAD_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 420_000;

/**
 * 공개 문서에 기재된 것은 파일 업로드와 잡 생성·조회뿐이다. 에이전트와 config를
 * 다루는 경로는 문서에 없지만 실제로 동작하며, 예고 없이 변경될 수 있다.
 * 확인 시점은 2026-08-22이다.
 */

export type StepType =
  | "class-generate"
  | "class-update"
  | "document-classify"
  | "document-parse"
  | "export"
  | "information-extract"
  | "instruct"
  | "instruct-generate"
  | "match"
  | "merge"
  | "review"
  | "schema-generate"
  | "schema-update"
  | "validate";

export type JobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type StepRef = {
  name: string;
  step_name: string;
  id?: string;
  step_id?: string;
};

export type StepDefinition = {
  name: string;
  type: StepType;
  isFirst?: boolean;
  next?: string[];
  data?: Record<string, unknown>;
};

export type ConfigStep = {
  id: string;
  name: string;
  type: StepType;
  data: Record<string, unknown>;
  next_steps: StepRef[];
  is_first: boolean;
};

export type AgentConfig = {
  id: string;
  external_id: string;
  agent_id: string;
  is_default: boolean;
  steps: ConfigStep[];
};

export type Agent = {
  id: string;
  name: string | null;
  description: string | null;
  default_config_id: string | null;
  default_config_external_id: string | null;
  published_config_id: string | null;
  vector_store_id: string | null;
  used_steps: StepType[];
};

export type JobStepResult = {
  stepName: string;
  status: string;
  text: string;
  additionalValues: unknown;
};

export type JobResult = {
  id: string;
  status: JobStatus;
  error: { code: string | null; step?: string; message: string } | null;
  steps: JobStepResult[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function apiKey(): string {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) {
    throw new Error(
      "UPSTAGE_API_KEY 환경 변수가 설정되어 있지 않습니다. .env.local에 추가해 주세요.",
    );
  }
  return key;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const response = await fetch(`${UPSTAGE_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && isRecord(payload.error)
        ? String(payload.error.message ?? "알 수 없는 오류")
        : `HTTP ${response.status}`;
    throw new Error(`Upstage API 호출이 실패했습니다: ${message}`);
  }

  return payload as T;
}

/** 파일을 업로드하고 file_id를 반환한다. */
export async function uploadFile(
  file: Blob,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("purpose", "user_data");

  const uploaded = await request<{ id: string }>(
    "/files",
    { method: "POST", body: form },
    UPLOAD_TIMEOUT_MS,
  );
  return uploaded.id;
}

export async function deleteFile(fileId: string): Promise<void> {
  await request(`/files/${fileId}`, { method: "DELETE" });
}

export async function listAgents(): Promise<Agent[]> {
  const listed = await request<{ data: Agent[] }>("/agents");
  return listed.data;
}

export async function getAgent(agentId: string): Promise<Agent> {
  return request<Agent>(`/agents/${agentId}`);
}

export async function createAgent(
  name: string,
  description: string,
): Promise<Agent> {
  const created = await request<Agent>("/agents", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return request<Agent>(`/agents/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name, description }),
  });
}

function toStepBody(
  step: StepDefinition,
  ids: Map<string, string> | null,
): JsonRecord {
  return {
    name: step.name,
    type: step.type,
    is_first: step.isFirst ?? false,
    next_steps: (step.next ?? []).map((target) => {
      const id = ids?.get(target);
      return id
        ? { name: target, step_name: target, id, step_id: id }
        : { name: target, step_name: target };
    }),
    ...(step.data ? { data: step.data } : {}),
  };
}

/**
 * 파이프라인을 정의한다.
 *
 * next_steps는 스텝 UUID를 요구하는데 그 UUID는 config를 만들어 봐야 알 수 있다.
 * 그래서 이름만 채운 config를 한 번 만들어 UUID를 받아 온 뒤, 그 UUID를 넣어
 * 두 번째 config를 만든다. 실제로 동작하는 것은 두 번째 config다.
 *
 * 주의: 생성 단계는 각 스텝의 data를 검증하지 않는다. 200을 받았다는 사실만으로는
 * 동작을 보장할 수 없으므로, 새 파이프라인은 반드시 문서 한 건으로 실행해 확인해야 한다.
 */
export async function createConfig(
  agentId: string,
  steps: StepDefinition[],
): Promise<AgentConfig> {
  const draft = await request<AgentConfig>(`/agents/${agentId}/configs`, {
    method: "POST",
    body: JSON.stringify({ steps: steps.map((s) => toStepBody(s, null)) }),
  });

  const ids = new Map(draft.steps.map((s) => [s.name, s.id]));

  return request<AgentConfig>(`/agents/${agentId}/configs`, {
    method: "POST",
    body: JSON.stringify({ steps: steps.map((s) => toStepBody(s, ids)) }),
  });
}

export async function listConfigs(agentId: string): Promise<AgentConfig[]> {
  const listed = await request<{ data: AgentConfig[] }>(
    `/agents/${agentId}/configs`,
  );
  return listed.data;
}

/** 잡을 생성하고 job_id를 반환한다. 결과는 폴링으로 받아야 한다. */
export async function createJob(
  agentId: string,
  fileId: string,
): Promise<string> {
  const job = await request<{ id: string }>("/responses", {
    method: "POST",
    body: JSON.stringify({
      model: agentId,
      include: ["all"],
      input: [
        {
          role: "user",
          content: [{ type: "input_file", file_id: fileId }],
        },
      ],
    }),
  });
  return job.id;
}

function toJobResult(payload: unknown): JobResult {
  if (!isRecord(payload)) {
    throw new Error("잡 조회 응답의 형식이 올바르지 않습니다.");
  }

  const output = Array.isArray(payload.output) ? payload.output : [];

  return {
    id: String(payload.id ?? ""),
    status: payload.status as JobStatus,
    error: (payload.error ?? null) as JobResult["error"],
    steps: output.flatMap((step) => {
      if (!isRecord(step)) return [];
      const contents = Array.isArray(step.content) ? step.content : [];
      return contents.filter(isRecord).map((content) => ({
        stepName: String(step.model ?? ""),
        status: String(step.status ?? ""),
        text: String(content.text ?? ""),
        // additional_values는 문자열로 인코딩된 JSON이라 한 번 더 파싱해야 한다.
        additionalValues: parseAdditionalValues(content.additional_values),
      }));
    }),
  };
}

function parseAdditionalValues(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function getJob(jobId: string): Promise<JobResult> {
  return toJobResult(
    await request(`/responses/${jobId}?include[]=all`),
  );
}

/**
 * 잡이 끝날 때까지 기다린다. 처리는 초 단위가 아니라 분 단위로 걸리므로,
 * 라우트 핸들러 안에서 이 함수를 끝까지 기다리게 만들면 안 된다.
 * 잡 생성까지만 서버에서 처리하고 폴링은 클라이언트에 맡기는 편이 안전하다.
 */
export async function waitForJob(
  jobId: string,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<JobResult> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const job = await getJob(jobId);
    if (job.status !== "queued" && job.status !== "in_progress") return job;

    if (Date.now() >= deadline) {
      throw new Error(
        `잡 ${jobId}이(가) ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Instruct 출력에 섞여 나오는 인용 표지를 제거한다. */
export function stripCitations(text: string): string {
  return text.replace(/【[^】]*】/g, "").trim();
}

/**
 * Extract 스텝의 결과를 파싱한다. 스텝 이름을 지정하지 않으면 마지막
 * information-extract 결과를 쓴다.
 */
export function extractedFields<T>(
  job: JobResult,
  stepName?: string,
): T | null {
  const step = stepName
    ? job.steps.find((s) => s.stepName === stepName)
    : job.steps.findLast((s) => s.text.trimStart().startsWith("{"));

  if (!step) return null;

  try {
    return JSON.parse(step.text) as T;
  } catch {
    return null;
  }
}
