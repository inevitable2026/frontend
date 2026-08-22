import { Fragment, type ReactNode } from "react";

type ListItem = {
  content: string;
  number?: number;
  ordered: boolean;
};

const INLINE_PATTERN_SOURCE = String.raw`(\*\*[^*\n]+?\*\*|__[^_\n]+?__|\x60[^\x60\n]+?\x60|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+)`;

function safeHref(value: string): string | undefined {
  if (value.startsWith("/") || value.startsWith("#")) return value;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function renderInlineLine(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const inlinePattern = new RegExp(INLINE_PATTERN_SOURCE, "g");
  let cursor = 0;
  let tokenIndex = 0;

  for (let match = inlinePattern.exec(text); match; match = inlinePattern.exec(text)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;

    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key}>
          {renderInlineLine(token.slice(2, -2), `${key}-strong`)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const separator = token.lastIndexOf("](");
      const label = token.slice(1, separator);
      const href = safeHref(token.slice(separator + 2, -1));
      nodes.push(href ? <a href={href} key={key} target="_blank" rel="noreferrer">{label}</a> : token);
    } else {
      const trailingPunctuation = token.match(/[.,;:!?]+$/)?.[0] ?? "";
      const rawHref = trailingPunctuation ? token.slice(0, -trailingPunctuation.length) : token;
      const href = safeHref(rawHref);
      nodes.push(
        <Fragment key={key}>
          {href ? <a href={href} target="_blank" rel="noreferrer">{rawHref}</a> : rawHref}
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

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split("\n");

  return lines.flatMap((line, index) => {
    const hardBreak = / {2,}$/.test(line);
    const content = hardBreak ? line.trimEnd() : line;
    const nodes = renderInlineLine(content, `${keyPrefix}-${index}`);

    if (index === lines.length - 1) return nodes;
    return [...nodes, hardBreak ? <br key={`${keyPrefix}-break-${index}`} /> : " "];
  });
}

function matchListItem(line: string): ListItem | null {
  const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
  if (ordered) {
    return { content: ordered[2], number: Number(ordered[1]), ordered: true };
  }

  const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
  return unordered ? { content: unordered[1], ordered: false } : null;
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed)
    || /^```/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    || matchListItem(line) !== null;
}

export function MarkdownContent({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
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
      blocks.push(<Heading key={key}>{renderInline(heading[2], key)}</Heading>);
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
      blocks.push(<blockquote key={key}><p>{renderInline(quote.join("\n"), key)}</p></blockquote>);
      continue;
    }

    const firstListItem = matchListItem(lines[index]);
    if (firstListItem) {
      const ordered = firstListItem.ordered;
      const start = firstListItem.number;
      const items: string[] = [];

      while (index < lines.length) {
        const current = matchListItem(lines[index]);
        if (!current || current.ordered !== ordered) break;

        const itemLines = [current.content];
        index += 1;

        while (index < lines.length) {
          if (!lines[index].trim()) {
            let next = index;
            while (next < lines.length && !lines[next].trim()) next += 1;
            const nextItem = next < lines.length ? matchListItem(lines[next]) : null;
            index = next;
            if (nextItem?.ordered === ordered) break;
            break;
          }

          const nextItem = matchListItem(lines[index]);
          if (nextItem?.ordered === ordered) break;
          if (nextItem) {
            itemLines.push(`${nextItem.ordered ? `${nextItem.number}.` : "•"} ${nextItem.content}`);
          } else {
            itemLines.push(lines[index].trimStart());
          }
          index += 1;
        }

        items.push(itemLines.join("\n"));
        const nextItem = index < lines.length ? matchListItem(lines[index]) : null;
        if (!nextItem || nextItem.ordered !== ordered) break;
      }

      const children = items.map((item, itemIndex) => (
        <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
      ));
      blocks.push(ordered ? <ol key={key} start={start}>{children}</ol> : <ul key={key}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && (paragraph.length === 0 || !isBlockStart(lines[index]))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key}>{renderInline(paragraph.join("\n"), key)}</p>);
  }

  return <div className="assistant-answer">{blocks}</div>;
}
