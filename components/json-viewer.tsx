type JsonViewerProps = {
  label: string;
  value: unknown;
};

const JSON_TOKEN_PATTERN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;

function serialize(value: unknown): { isJson: boolean; text: string } {
  if (typeof value === "string") {
    try {
      return { isJson: true, text: JSON.stringify(JSON.parse(value) as unknown, null, 2) };
    } catch {
      return { isJson: false, text: value };
    }
  }

  try {
    const text = JSON.stringify(value, null, 2);
    return { isJson: true, text: text ?? String(value) };
  } catch {
    return { isJson: false, text: String(value) };
  }
}

function renderTokens(line: string, lineIndex: number) {
  const tokens = [];
  let cursor = 0;
  let tokenIndex = 0;

  JSON_TOKEN_PATTERN.lastIndex = 0;
  for (let match = JSON_TOKEN_PATTERN.exec(line); match; match = JSON_TOKEN_PATTERN.exec(line)) {
    if (match.index > cursor) tokens.push(line.slice(cursor, match.index));

    const className = match[2]
      ? "is-key"
      : match[1]
        ? "is-string"
        : match[3] === "true" || match[3] === "false"
          ? "is-boolean"
          : match[3] === "null"
            ? "is-null"
            : "is-number";

    tokens.push(
      <span className={className} key={`${lineIndex}-${tokenIndex}`}>
        {match[0]}
      </span>,
    );
    cursor = match.index + match[0].length;
    tokenIndex += 1;
  }

  if (cursor < line.length) tokens.push(line.slice(cursor));
  return tokens.length > 0 ? tokens : " ";
}

export function JsonViewer({ label, value }: JsonViewerProps) {
  const serialized = serialize(value);
  const lines = serialized.text.split("\n");

  return (
    <div className={`json-viewer${serialized.isJson ? " is-json" : ""}`}>
      <pre aria-label={label}>
        <code>
          {lines.map((line, index) => (
            <span className="json-line" key={`${index}-${line}`}>
              <span className="json-line-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="json-line-content">
                {serialized.isJson ? renderTokens(line, index) : line || " "}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
