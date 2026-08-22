const UPSTAGE_BASE = "https://api.upstage.ai/v1";
const PASSAGE_MODEL = "embedding-passage";
const QUERY_MODEL = "embedding-query";

export const EMBEDDING_DIMENSIONS = 4096;

export class UpstageError extends Error {}

function apiKey(): string {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new UpstageError("UPSTAGE_API_KEY 가 없습니다. 서버 환경변수를 확인하세요.");
  return key;
}

export type Budget = {
  limitMs: number;
  deadline?: number;
  /** Runs immediately before each network call, e.g. to renew a fenced lease. */
  beforeCall?: () => Promise<void>;
  onCall?: () => void;
};

export function budgetTimeoutMs({ limitMs, deadline }: Budget, now = Date.now()): number {
  const left = deadline ? deadline - now : limitMs;
  const timeout = Math.min(limitMs, left);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UpstageError("Upstage 처리 예산이 만료되었습니다.");
  return Math.max(1, Math.floor(timeout));
}

function signal(budget: Budget): AbortSignal {
  return AbortSignal.timeout(budgetTimeoutMs(budget));
}

async function fail(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => "");
  throw new UpstageError(`${what} 실패 (${res.status}) ${body.slice(0, 300)}`);
}

async function embed(model: string, input: string | string[], budget: Budget): Promise<number[][]> {
  await budget.beforeCall?.();
  budget.onCall?.();
  const res = await fetch(`${UPSTAGE_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    cache: "no-store",
    signal: signal(budget),
  });
  if (!res.ok) await fail(res, "임베딩");

  const data = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
  const rows = data.data ?? [];
  if (rows.length === 0) throw new UpstageError("임베딩 응답이 비었습니다.");
  const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const dimensions = ordered[0].embedding.length;
  if (dimensions !== EMBEDDING_DIMENSIONS) {
    throw new UpstageError(
      `임베딩 차원이 ${dimensions} 입니다. 저장소는 halfvec(${EMBEDDING_DIMENSIONS}) 이라 그대로 넣으면 실패합니다.`,
    );
  }
  return ordered.map((r) => r.embedding);
}

export async function embedPassages(
  texts: string[],
  budget: Budget = { limitMs: 30_000 },
  batchSize = 32,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    out.push(...(await embed(PASSAGE_MODEL, texts.slice(i, i + batchSize), budget)));
  }
  return out;
}

export async function embedQuery(text: string, budget: Budget = { limitMs: 10_000 }): Promise<number[]> {
  return (await embed(QUERY_MODEL, text, budget))[0];
}
