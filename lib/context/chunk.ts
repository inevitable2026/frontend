import type { LayoutElement } from "@/lib/context/types";

const MIN_CHARS = 300;
const MAX_CHARS = 800;
const OVERLAP = 50;

const STANDALONE = new Set(["table"]);
const HEADINGS = new Set(["heading1", "heading2", "heading3", "header"]);

export type Chunk = { seq: number; page: number; text: string; elementIds: number[] };

function bodyText(element: LayoutElement): string {
  return (element.content.markdown || element.content.text || element.content.html || "").trim();
}

function tableRows(html: string): string[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  if (rows.length === 0) return [];

  const cells = (row: string) =>
    [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);

  const header = cells(rows[0]);
  const body = rows.slice(1).map(cells).filter((c) => c.length > 0);
  if (body.length === 0) return [header.join(" | ")];

  return body.map((row) => row.map((v, i) => (header[i] ? `${header[i]}: ${v}` : v)).join(" · "));
}

function withHeading(heading: string | null, text: string): string {
  if (!heading) return text;
  if (text.includes(heading)) return text;
  return `${heading}\n${text}`;
}

export function chunkElements(elements: LayoutElement[]): Chunk[] {
  const out: Chunk[] = [];
  let heading: string | null = null;
  let buffer = "";
  let bufferPage = 1;
  let bufferIds: number[] = [];

  const flush = () => {
    const text = withHeading(heading, buffer.trim());
    buffer = "";
    const ids = bufferIds;
    bufferIds = [];
    if (!text) return;
    out.push({ seq: out.length, page: bufferPage, text, elementIds: ids });
  };

  for (const element of elements) {
    const text = bodyText(element);
    if (!text) continue;
    const category = (element.category || "").toLowerCase();
    const page = element.page ?? 1;

    if (HEADINGS.has(category)) {
      flush();
      heading = text.replace(/^#+\s*/, "").trim();
      continue;
    }

    if (STANDALONE.has(category)) {
      flush();
      const rows = element.content.html ? tableRows(element.content.html) : [];
      const pieces = rows.length > 0 ? rows : [text];

      let group: string[] = [];
      const emit = () => {
        if (group.length === 0) return;
        const joined = withHeading(heading, group.join("\n")).trim();
        group = [];
        if (!joined) return;
        out.push({ seq: out.length, page, text: joined, elementIds: [element.id] });
      };
      for (const row of pieces) {
        group.push(row);
        if (group.join("\n").length >= MIN_CHARS) emit();
      }
      emit();
      continue;
    }

    if (buffer.length === 0) bufferPage = page;
    buffer += (buffer ? "\n" : "") + text;
    bufferIds.push(element.id);

    while (buffer.length >= MAX_CHARS) {
      const sentenceCut = buffer.lastIndexOf(". ", MAX_CHARS) + 1;
      const newlineCut = buffer.lastIndexOf("\n", MAX_CHARS) + 1;
      const candidate = sentenceCut || newlineCut || MAX_CHARS;
      // The overlap must still advance the cursor. A leading punctuation/newline
      // can otherwise yield cut=1 and slice from zero forever.
      const cut = candidate <= OVERLAP ? MAX_CHARS : candidate;
      out.push({
        seq: out.length,
        page: bufferPage,
        text: withHeading(heading, buffer.slice(0, cut).trim()),
        elementIds: [...bufferIds],
      });
      buffer = buffer.slice(Math.max(0, cut - OVERLAP));
      bufferPage = page;
    }

    if (buffer.trim().length >= MIN_CHARS) {
      out.push({
        seq: out.length,
        page: bufferPage,
        text: withHeading(heading, buffer.trim()),
        elementIds: [...bufferIds],
      });
      buffer = "";
      bufferIds = [];
    }
  }

  if (buffer.trim()) {
    out.push({ seq: out.length, page: bufferPage, text: withHeading(heading, buffer.trim()), elementIds: [...bufferIds] });
  }

  return out.map((chunk, index) => ({ ...chunk, seq: index }));
}
