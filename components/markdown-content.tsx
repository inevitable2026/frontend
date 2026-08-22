import { Fragment, type ReactNode } from "react";

/**
 * 각주가 어느 계열의 근거인지. 계열을 지우면 화면이 거짓말을 한다 — 사내 문서 본문에도
 * "제334조(콘크리트의 타설작업)" 같은 조문 문자열이 그대로 들어 있어(시드 문서 16건이
 * 그렇다), 계열을 보지 않으면 합성 사내 문서가 "국가법령정보센터 원문" 링크를 달고
 * 공식 법령으로 둔갑한다. 그래서 선택 필드가 아니라 필수다.
 */
export type CitationKind = "법령" | "사내문서" | "위험성평가";

export type CitationSource = {
  kind: CitationKind;
  title: string;
  url: string;
  authority?: string;
  version?: string;
  excerpt?: string;
};

type ListItem = {
  content: string;
  indent: number;
  number?: number;
  ordered: boolean;
};

type InlineContext = {
  citationNumbers: Map<string, number>;
  sources: CitationSource[];
};

type CitationMatch = {
  source: CitationSource;
  directlyMentioned: boolean;
};

const LEGAL_REFERENCE_SOURCE = String.raw`(?:제\d+조(?:의\d+)?(?:제\d+항)?(?:제\d+호)?|별표\s*\d+(?:의\s*\d+)?)`;
const INLINE_PATTERN_SOURCE = [
  String.raw`\*\*[^*\n]+?\*\*`,
  String.raw`__[^_\n]+?__`,
  String.raw`\x60[^\x60\n]+?\x60`,
  String.raw`\[[^\]\n]+\]\([^)\s]+\)`,
  String.raw`https?:\/\/[^\s<>()]+`,
  LEGAL_REFERENCE_SOURCE,
].join("|");
const LEGAL_REFERENCE_PATTERN = new RegExp(`^(?:${LEGAL_REFERENCE_SOURCE})$`);

function safeHref(value: string): string | undefined {
  if (value.startsWith("/") || value.startsWith("#")) return value;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeReference(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * 조문 각주가 딛고 설 근거를 고른다. 순서가 규약이다.
 *
 * 1. 법령 출처 가운데 그 조문을 실제로 담은 원문. 법적 주장의 각주는 여기서만 나와야 한다.
 * 2. 법령 출처가 하나뿐이면 그것. 읽은 원문이 조문 제목만 담고 번호를 안 담는 경우가 있어
 *    남겨 둔 폴백이다. **법령 출처에만** 적용한다 — 사내 문서 한 건뿐인 답변에 이 폴백을
 *    허용하면 답변의 모든 조문 언급이 그 합성 문서로 연결된다.
 * 3. 그래도 없으면 그 조문을 글자 그대로 담은 사내·평가 근거. 여기는 "법이 이렇다" 가
 *    아니라 "우리 자료가 이 조문을 언급한다" 는 각주이므로 링크 문구도 갈라진다.
 */
function findCitationSource(
  reference: string,
  sources: CitationSource[],
): CitationMatch | undefined {
  const normalizedReference = normalizeReference(reference);
  const mentions = (source: CitationSource) =>
    Boolean(source.excerpt) && normalizeReference(source.excerpt!).includes(normalizedReference);
  const official = sources.filter((source) => source.kind === "법령");

  const officialSource = official.find(mentions);
  if (officialSource) return { source: officialSource, directlyMentioned: true };
  if (official.length === 1) return { source: official[0], directlyMentioned: false };

  const companySource = sources.find((source) => source.kind !== "법령" && mentions(source));
  if (companySource) return { source: companySource, directlyMentioned: true };
  return undefined;
}

function formatVersion(value?: string): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/[^0-9]/g, "");
  if (!/^\d{8}$/.test(compact)) return value;
  return `${Number(compact.slice(0, 4))}. ${Number(compact.slice(4, 6))}. ${Number(compact.slice(6, 8))}. 기준`;
}

function collectCitationNumbers(
  content: string,
  sources: CitationSource[],
): Map<string, number> {
  const numbers = new Map<string, number>();
  const pattern = new RegExp(LEGAL_REFERENCE_SOURCE, "g");

  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    const reference = normalizeReference(match[0]);
    if (!numbers.has(reference) && findCitationSource(reference, sources)) {
      numbers.set(reference, numbers.size + 1);
    }
  }

  return numbers;
}

/** 링크가 실제로 가는 곳. 사내 근거는 이 앱 안의 원본 보기이지 법령 원문이 아니다. */
const CITATION_LINK_LABEL: Record<CitationKind, string> = {
  법령: "국가법령정보센터 원문",
  사내문서: "사내 문서 본문",
  위험성평가: "위험성평가 원본",
};

/** 스크린리더가 읽을 각주의 성격. "공식 원문" 은 법령 계열에만 쓴다. */
const CITATION_ROLE_LABEL: Record<CitationKind, string> = {
  법령: "확인한 공식 원문",
  사내문서: "조문을 언급한 사내 문서",
  위험성평가: "조문을 언급한 위험성평가 기록",
};

function CitationNote({
  context,
  keyPrefix,
  reference,
}: {
  context: InlineContext;
  keyPrefix: string;
  reference: string;
}) {
  const number = context.citationNumbers.get(normalizeReference(reference));
  const match = findCitationSource(reference, context.sources);
  if (!number || !match) return null;

  const { directlyMentioned, source } = match;

  const tooltipId = `citation-${keyPrefix.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const metadata = [source.authority, formatVersion(source.version)].filter(Boolean).join(" · ");

  return (
    <span className="citation-note">
      <button
        className="citation-trigger"
        type="button"
        aria-label={`각주 ${number}: ${CITATION_ROLE_LABEL[source.kind]}, ${reference}`}
        aria-describedby={tooltipId}
      >
        {number}
      </button>
      <span className="citation-popover" id={tooltipId} role="note">
        <span className="citation-popover-label">답변 근거 원문 {number}</span>
        <strong>{source.title}</strong>
        <span className="citation-popover-reference">
          {directlyMentioned ? "본문 내 언급" : "답변 인용"} · {reference}
        </span>
        {metadata ? <span className="citation-popover-meta">{metadata}</span> : null}
        <a href={source.url} target="_blank" rel="noreferrer">
          {CITATION_LINK_LABEL[source.kind]}
          <span aria-hidden="true">↗</span>
        </a>
      </span>
    </span>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  const officialLaw = /(^|\.)law\.go\.kr$/i.test(new URL(href, "https://local.invalid").hostname);
  const visibleLabel = officialLaw && label === href ? "공식 법령 원문" : label;

  return (
    <a className={officialLaw ? "official-law-link" : undefined} href={href} target="_blank" rel="noreferrer">
      {visibleLabel}
      {officialLaw ? <span aria-hidden="true">↗</span> : null}
    </a>
  );
}

function renderInlineLine(text: string, keyPrefix: string, context: InlineContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  const inlinePattern = new RegExp(`(?:${INLINE_PATTERN_SOURCE})`, "g");
  let cursor = 0;
  let tokenIndex = 0;

  for (let match = inlinePattern.exec(text); match; match = inlinePattern.exec(text)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;

    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key}>
          {renderInlineLine(token.slice(2, -2), `${key}-strong`, context)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const separator = token.lastIndexOf("](");
      const label = token.slice(1, separator);
      const href = safeHref(token.slice(separator + 2, -1));
      nodes.push(href ? <ExternalLink href={href} key={key} label={label} /> : token);
    } else if (LEGAL_REFERENCE_PATTERN.test(token)) {
      nodes.push(
        <Fragment key={key}>
          {token}
          <CitationNote context={context} keyPrefix={key} reference={token} />
        </Fragment>,
      );
    } else {
      const trailingPunctuation = token.match(/[.,;:!?]+$/)?.[0] ?? "";
      const rawHref = trailingPunctuation ? token.slice(0, -trailingPunctuation.length) : token;
      const href = safeHref(rawHref);
      nodes.push(
        <Fragment key={key}>
          {href ? <ExternalLink href={href} label={rawHref} /> : rawHref}
          {trailingPunctuation}
        </Fragment>,
      );
    }

    cursor = match.index + token.length;
    tokenIndex += 1;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderInline(text: string, keyPrefix: string, context: InlineContext): ReactNode[] {
  const lines = text.split("\n");

  return lines.flatMap((line, index) => {
    const hardBreak = / {2,}$/.test(line);
    const content = hardBreak ? line.trimEnd() : line;
    const nodes = renderInlineLine(content, `${keyPrefix}-${index}`, context);

    if (index === lines.length - 1) return nodes;
    return [...nodes, hardBreak ? <br key={`${keyPrefix}-break-${index}`} /> : " "];
  });
}

function matchListItem(line: string): ListItem | null {
  const ordered = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (ordered) {
    return {
      content: ordered[3],
      indent: ordered[1].replace(/\t/g, "    ").length,
      number: Number(ordered[2]),
      ordered: true,
    };
  }

  const unordered = line.match(/^(\s*)[-+*]\s+(.+)$/);
  return unordered ? {
    content: unordered[2],
    indent: unordered[1].replace(/\t/g, "    ").length,
    ordered: false,
  } : null;
}

function parseList(
  lines: string[],
  startIndex: number,
  context: InlineContext,
  keyPrefix: string,
): { node: ReactNode; nextIndex: number } {
  const first = matchListItem(lines[startIndex]);
  if (!first) return { node: null, nextIndex: startIndex + 1 };

  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items: ReactNode[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const current = matchListItem(lines[index]);
    if (!current || current.indent !== baseIndent || current.ordered !== ordered) break;

    const itemKey = `${keyPrefix}-item-${items.length}`;
    const itemChildren: ReactNode[] = [];
    const copyLines = [current.content];
    index += 1;

    while (index < lines.length && lines[index].trim() && !matchListItem(lines[index])) {
      copyLines.push(lines[index].trimStart());
      index += 1;
    }

    itemChildren.push(
      <div className="markdown-list-copy" key={`${itemKey}-copy`}>
        {renderInline(copyLines.join("\n"), `${itemKey}-copy`, context)}
      </div>,
    );

    while (index < lines.length) {
      if (!lines[index].trim()) {
        let nextContent = index;
        while (nextContent < lines.length && !lines[nextContent].trim()) nextContent += 1;
        const nextItem = nextContent < lines.length ? matchListItem(lines[nextContent]) : null;
        if (!nextItem || nextItem.indent <= baseIndent) break;
        index = nextContent;
      }

      const nextItem = matchListItem(lines[index]);
      if (!nextItem || nextItem.indent <= baseIndent) break;

      const nested = parseList(lines, index, context, `${itemKey}-nested-${itemChildren.length}`);
      itemChildren.push(nested.node);
      index = nested.nextIndex;
    }

    items.push(<li key={itemKey}>{itemChildren}</li>);

    if (!lines[index]?.trim()) {
      let nextContent = index;
      while (nextContent < lines.length && !lines[nextContent].trim()) nextContent += 1;
      const nextItem = nextContent < lines.length ? matchListItem(lines[nextContent]) : null;
      if (nextItem?.indent === baseIndent && nextItem.ordered === ordered) index = nextContent;
    }
  }

  return {
    node: ordered
      ? <ol key={keyPrefix} start={first.number}>{items}</ol>
      : <ul key={keyPrefix}>{items}</ul>,
    nextIndex: index,
  };
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed)
    || /^```/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    || matchListItem(line) !== null;
}

export function MarkdownContent({
  content,
  sources = [],
}: {
  content: string;
  sources?: CitationSource[];
}) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const context: InlineContext = {
    citationNumbers: collectCitationNumbers(content, sources),
    sources,
  };
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const trimmed = lines[index].trim();
    const key = `markdown-block-${blockIndex}`;
    blockIndex += 1;

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim();
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={key}><code data-language={language || undefined}>{code.join("\n")}</code></pre>);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      const Heading = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Heading key={key}>{renderInline(heading[2], key, context)}</Heading>);
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={key} />);
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={key}><p>{renderInline(quote.join("\n"), key, context)}</p></blockquote>);
      continue;
    }

    if (matchListItem(lines[index])) {
      const list = parseList(lines, index, context, key);
      blocks.push(list.node);
      index = list.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && (paragraph.length === 0 || !isBlockStart(lines[index]))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key}>{renderInline(paragraph.join("\n"), key, context)}</p>);
  }

  return <div className="assistant-answer">{blocks}</div>;
}
