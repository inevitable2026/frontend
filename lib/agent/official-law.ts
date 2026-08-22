const LAW_SEARCH_URL = "https://www.law.go.kr/DRF/lawSearch.do";
const LAW_SERVICE_URL = "https://www.law.go.kr/DRF/lawService.do";
const LAW_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_EXCERPT_LENGTH = 3_000;

export type LawKind = "eflaw" | "admrul";

export type OfficialSource = {
  title: string;
  url: string;
  authority: string;
  version: string;
};

export type LawCandidate = {
  ref: string;
  kind: LawKind;
  citable: false;
  title: string;
  authority: string;
  version: string;
  canonicalUrl: string;
};

export type LawReadResult = {
  ref: string;
  kind: LawKind;
  citable: true;
  title: string;
  authority: string;
  version: string;
  provision: string | null;
  excerpt: string;
  canonicalUrl: string;
  source: OfficialSource;
};

export type LawReference = LawCandidate & {
  searchQuery: string;
  mst?: string;
  effectiveDate?: string;
  adminRuleId?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function pick(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value;
  }
  return "";
}

function lawOc(): string {
  const configured = process.env.LAW_GO_KR_OC?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return "test";
  throw new Error("LAW_OC_MISSING");
}

export function isOfficialLawConfigured(): boolean {
  return Boolean(process.env.LAW_GO_KR_OC?.trim()) || process.env.NODE_ENV !== "production";
}

function canonicalUrl(
  kind: LawKind,
  identifier: string,
  effectiveDate?: string,
): string {
  if (kind === "eflaw") {
    const url = new URL("https://www.law.go.kr/LSW/lsInfoP.do");
    url.searchParams.set("lsiSeq", identifier);
    if (effectiveDate) url.searchParams.set("efYd", effectiveDate);
    return url.toString();
  }

  const url = new URL("https://www.law.go.kr/LSW/admRulInfoP.do");
  url.searchParams.set("admRulSeq", identifier);
  return url.toString();
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("LAW_RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("LAW_RESPONSE_EMPTY");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("LAW_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function lawFetch(params: Record<string, string>): Promise<unknown> {
  const url = new URL(params.endpoint === "search" ? LAW_SEARCH_URL : LAW_SERVICE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (key !== "endpoint") url.searchParams.set(key, value);
  });
  url.searchParams.set("OC", lawOc());
  url.searchParams.set("type", "JSON");

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LAW_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        if (response.status >= 500 && attempt === 0) continue;
        throw new Error("LAW_UPSTREAM_STATUS");
      }
      if (!/application\/(json|[^;]+\+json)/i.test(contentType)) {
        throw new Error("LAW_UPSTREAM_CONTENT_TYPE");
      }
      const text = await readBoundedBody(response);
      if (/^\s*</.test(text)) throw new Error("LAW_UPSTREAM_HTML");
      return JSON.parse(text) as unknown;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && !(error instanceof Error && /CONTENT_TYPE|HTML|TOO_LARGE|MISSING/.test(error.message))) {
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("LAW_UPSTREAM_FAILED");
}

function makeReference(index: number): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `law_${index + 1}_${random[0].toString(36)}${random[1].toString(36)}`;
}

export async function searchOfficialLaw(
  query: string,
  search: "title" | "body",
): Promise<{ candidates: LawCandidate[]; references: Map<string, LawReference>; searchMode: "title" | "body" }> {
  const candidates: LawCandidate[] = [];
  const references = new Map<string, LawReference>();
  const searches: Array<{ kind: LawKind; root: string; nw: string }> = [
    { kind: "eflaw", root: "LawSearch", nw: "3" },
    { kind: "admrul", root: "AdmRulSearch", nw: "1" },
  ];

  const searchModes: Array<"title" | "body"> = search === "title"
    ? ["title", "body"]
    : ["body"];
  let searchMode = search;

  for (const mode of searchModes) {
    searchMode = mode;
    for (const config of searches) {
      const data = await lawFetch({
        endpoint: "search",
        target: config.kind,
        query,
        search: mode === "title" ? "1" : "2",
        nw: config.nw,
        display: "5",
      });
      const payload = isRecord(data) ? data : null;
      const root = payload && isRecord(payload[config.root]) ? payload[config.root] : null;
      if (!root) continue;
      const rowKey = config.kind === "eflaw" ? "law" : "admrul";
      const rows = asArray((root as JsonRecord)[rowKey])
        .filter(isRecord)
        .slice(0, 5);

      for (const row of rows) {
        const title = pick(row, config.kind === "eflaw" ? "법령명한글" : "행정규칙명");
        if (!title) continue;
        const ref = makeReference(candidates.length);
        const authority = pick(row, "소관부처명") || "국가법령정보센터";
        const version = pick(row, "시행일자", "발령일자", "공포일자") || "현행 확인 필요";
        const mst = pick(row, "법령일련번호");
        const effectiveDate = pick(row, "시행일자");
        const adminRuleId = pick(row, "행정규칙일련번호", "ID");
        if (config.kind === "eflaw" && (!mst || !effectiveDate)) continue;
        if (config.kind === "admrul" && !adminRuleId) continue;
        const reference: LawReference = {
          ref,
          kind: config.kind,
          citable: false,
          title,
          authority,
          version,
          searchQuery: query,
          canonicalUrl: canonicalUrl(
            config.kind,
            config.kind === "eflaw" ? mst : adminRuleId,
            effectiveDate,
          ),
          ...(config.kind === "eflaw"
            ? { mst, effectiveDate }
            : { adminRuleId }),
        };
        references.set(ref, reference);
        candidates.push(reference);
      }
    }

    if (candidates.length > 0) break;
  }
  return { candidates, references, searchMode };
}

function flattenText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (isRecord(value)) return Object.values(value).flatMap(flattenText);
  return [];
}

function queryTerms(query: string): string[] {
  const compact = query.replace(/[^0-9A-Za-z가-힣\s]/g, " ").trim();
  const words = compact.split(/\s+/).filter((word) => word.length >= 2);
  return [...new Set(words)].slice(0, 8);
}

function selectRelevantArticles(root: JsonRecord, query: string): string {
  const articleRoot = root["조문"];
  if (!isRecord(articleRoot)) return "";

  const articles = asArray(articleRoot["조문단위"])
    .filter(isRecord)
    .map((article) => flattenText(article).join("\n").trim())
    .filter(Boolean);
  const terms = queryTerms(query);

  return articles
    .map((text, index) => ({
      text,
      index,
      score: terms.reduce(
        (total, term) => total + (text.match(new RegExp(term, "gi"))?.length ?? 0),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map(({ text }) => text)
    .join("\n\n");
}

function selectProvisionText(
  root: JsonRecord,
  kind: LawKind,
  query: string,
  hasExactProvision: boolean,
): string {
  if (kind === "eflaw") {
    return hasExactProvision
      ? flattenText(root["조문"]).join("\n").trim()
      : selectRelevantArticles(root, query);
  }

  const articleCandidates = [
    root["조문내용"],
    root["조문"],
    root["행정규칙내용"],
    root["본문"],
  ];

  for (const candidate of articleCandidates) {
    const text = flattenText(candidate).join("\n").trim();
    if (text) return text;
  }

  return "";
}

export async function readOfficialLaw(
  reference: LawReference,
  provision?: string,
): Promise<LawReadResult> {
  const params: Record<string, string> = {
    endpoint: "service",
    target: reference.kind,
  };
  if (reference.kind === "eflaw") {
    if (!reference.mst || !reference.effectiveDate) throw new Error("LAW_REFERENCE_INCOMPLETE");
    params.MST = reference.mst;
    params.efYd = reference.effectiveDate;
    if (provision) params.JO = provision;
  } else {
    if (!reference.adminRuleId) throw new Error("LAW_REFERENCE_INCOMPLETE");
    params.ID = reference.adminRuleId;
  }

  const data = await lawFetch(params);
  const rootNames = reference.kind === "eflaw"
    ? ["법령", "LawService"]
    : ["AdmRulService", "행정규칙"];
  const root = isRecord(data)
    ? rootNames.map((name) => data[name]).find(isRecord) ?? null
    : null;
  if (!root) throw new Error("LAW_RESPONSE_INVALID");
  const text = selectProvisionText(
    root,
    reference.kind,
    reference.searchQuery,
    Boolean(provision),
  );
  const fallback = flattenText(root).join("\n").trim();
  const excerpt = (text || fallback).slice(0, MAX_EXCERPT_LENGTH);
  if (!excerpt) throw new Error("LAW_RESPONSE_EMPTY");

  const source: OfficialSource = {
    title: reference.title,
    url: reference.canonicalUrl,
    authority: reference.authority,
    version: reference.version,
  };
  return {
    ...reference,
    citable: true,
    provision: provision ?? null,
    excerpt,
    source,
  };
}
