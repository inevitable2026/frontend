import { normalizeNulls } from "@/lib/context/normalize";
import type { DocumentKind, ExtractedFields, LayoutElement } from "@/lib/context/types";

const UPSTAGE_BASE = "https://api.upstage.ai/v1";
const PARSE_MODEL = "document-parse";
const EXTRACT_MODEL = "information-extract";
const PASSAGE_MODEL = "embedding-passage";
const QUERY_MODEL = "embedding-query";

export const EMBEDDING_DIMENSIONS = 4096;

export class UpstageError extends Error {}

let callCount = 0;
export function upstageCallCount() {
  return callCount;
}

function apiKey(): string {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new UpstageError("UPSTAGE_API_KEY 가 없습니다. 서버 환경변수를 확인하세요.");
  return key;
}

export type Budget = { limitMs: number; deadline?: number };

function signal({ limitMs, deadline }: Budget): AbortSignal {
  const left = deadline ? deadline - Date.now() : limitMs;
  return AbortSignal.timeout(Math.max(1_000, Math.min(limitMs, left)));
}

async function fail(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => "");
  throw new UpstageError(`${what} 실패 (${res.status}) ${body.slice(0, 300)}`);
}

export type ParseResult = {
  elements: LayoutElement[];
  fullText: string;
  pageCount: number;
  model: string;
};

export async function parseDocument(
  bytes: Uint8Array,
  filename: string,
  mime: string,
  budget: Budget = { limitMs: 25_000 },
): Promise<ParseResult> {
  const form = new FormData();
  form.append("document", new Blob([bytes as unknown as BlobPart], { type: mime }), filename);
  form.append("model", PARSE_MODEL);
  form.append("ocr", "auto");
  form.append("output_formats", '["html","markdown"]');

  callCount += 1;
  const res = await fetch(`${UPSTAGE_BASE}/document-digitization`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
    cache: "no-store",
    signal: signal(budget),
  });
  if (!res.ok) await fail(res, "문서 파싱");

  const data = (await res.json()) as {
    elements?: LayoutElement[];
    content?: { markdown?: string; text?: string };
    model?: string;
  };
  const elements = data.elements ?? [];
  return {
    elements,
    fullText: data.content?.markdown ?? data.content?.text ?? "",
    pageCount: elements.reduce((max, e) => Math.max(max, e.page ?? 1), 0) || 1,
    model: data.model ?? PARSE_MODEL,
  };
}

type JsonSchema = Record<string, unknown>;
const str = (description: string) => ({ type: "string", description });
const strArray = (description: string) => ({ type: "array", items: { type: "string" }, description });

const commonFields: JsonSchema = {
  업체명: str("수급업체 또는 시공사 상호"),
  현장명: str("공사 현장 이름"),
  공종: strArray("공종명. 예: 철근콘크리트공사, 토공사"),
  장비: strArray("장비 및 설비 명칭. 예: 이동식크레인, 콘크리트펌프카"),
  자재: strArray("물질 및 자재 명칭. 예: 이형철근, 레미콘, 거푸집"),
};

const schemaByKind: Record<DocumentKind, JsonSchema> = {
  하도급계약서: { ...commonFields, 계약금액: str("계약 총액. 원문 표기 그대로"), 공사기간: str("착공일 ~ 준공일") },
  위험성평가표: { ...commonFields },
  TBM회의록: {
    ...commonFields,
    일자: str("회의 일자 YYYY-MM-DD"),
    참석자: strArray("참석자 성명"),
    중점위험요인: str("그날 중점으로 다룬 위험요인 한 줄"),
  },
  작업표준: { ...commonFields, 작업명: str("작업표준서의 대상 작업명"), 보호구: strArray("요구되는 개인보호장구") },
  순회점검일지: { ...commonFields },
  메일: {
    ...commonFields,
    발신자: str("보낸 사람. 성명과 소속을 함께 적는다"),
    수신처: strArray("받는 사람과 참조자의 주소 또는 부서"),
    제목: str("메일 제목. 원문 표기 그대로"),
    일자: str("보낸 일시 YYYY-MM-DD"),
    요청사항: str("본문이 상대에게 요구하는 내용 한 줄"),
    회신기한: str("회신 또는 반입 목표 일자 YYYY-MM-DD"),
  },
  기타: { ...commonFields },
};

export async function extractFields(
  bytes: Uint8Array,
  mime: string,
  kind: DocumentKind,
  budget: Budget = { limitMs: 20_000 },
): Promise<ExtractedFields> {
  const base64 = Buffer.from(bytes).toString("base64");
  const body = {
    model: EXTRACT_MODEL,
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "construction_doc", schema: { type: "object", properties: schemaByKind[kind] } },
    },
  };

  callCount += 1;
  const res = await fetch(`${UPSTAGE_BASE}/information-extraction`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: signal(budget),
  });
  if (!res.ok) await fail(res, "필드 추출");

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new UpstageError("추출 응답 형태가 예상과 다릅니다.");
  try {
    return normalizeNulls(JSON.parse(raw)) as ExtractedFields;
  } catch {
    throw new UpstageError("추출 결과가 JSON 이 아닙니다.");
  }
}

async function embed(model: string, input: string | string[], budget: Budget): Promise<number[][]> {
  callCount += 1;
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
