export type ChatTurnStatus = "pending" | "completed" | "failed";
export type ChatToolCallStatus = "completed" | "failed";
export type ChatJsonValue = null | boolean | number | string | ChatJsonValue[] | { [key: string]: ChatJsonValue };

export type ChatSourceLink = { label: string; url: string };
export type ChatToolCall = {
  id: string;
  name: string;
  status: ChatToolCallStatus;
  input: ChatJsonValue;
  output: ChatJsonValue;
  sources: ChatSourceLink[];
};

export type ChatConversation = {
  conversationId: string;
  siteId: string;
  title: string;
  actor: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatTurn = {
  turnId: string;
  conversationId: string;
  siteId: string;
  commandId: string;
  sequence: number;
  question: string;
  status: ChatTurnStatus;
  assistantText: string | null;
  toolCalls: ChatToolCall[];
  failureMessage: string | null;
  actor: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatTurnCommand = {
  commandId: string;
  conversationId?: string;
  siteId: string;
  question: string;
  actor: string;
};

export type ChatTurnBeginResult = { conversation: ChatConversation; turn: ChatTurn; replayed: boolean };
export type ChatTurnCompletion = { siteId: string; conversationId: string; commandId: string; actor: string; assistantText: string; toolCalls: ChatToolCall[] };
export type ChatTurnFailure = { siteId: string; conversationId: string; commandId: string; actor: string; failureMessage: string; toolCalls?: ChatToolCall[] };
export type ChatModelContextMessage = { role: "user" | "assistant"; content: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown): value is ChatJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return true;
  return Array.isArray(value) ? value.every(json) : record(value) && Object.values(value).every(json);
}

function source(value: unknown): value is ChatSourceLink {
  return record(value) && typeof value.label === "string" && value.label.length > 0 && typeof value.url === "string" && /^https:\/\//.test(value.url);
}

export function isChatToolCall(value: unknown): value is ChatToolCall {
  return record(value) && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && value.name.length > 0 &&
    (value.status === "completed" || value.status === "failed") && json(value.input) && json(value.output) && Array.isArray(value.sources) && value.sources.every(source);
}

export function isChatConversation(value: unknown): value is ChatConversation {
  return record(value) && typeof value.conversationId === "string" && typeof value.siteId === "string" &&
    typeof value.title === "string" && value.title.length > 0 && typeof value.actor === "string" && value.actor.length > 0 &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

export function isChatTurn(value: unknown): value is ChatTurn {
  return record(value) && typeof value.turnId === "string" && typeof value.conversationId === "string" && typeof value.siteId === "string" &&
    typeof value.commandId === "string" && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0 && typeof value.question === "string" &&
    (value.status === "pending" || value.status === "completed" || value.status === "failed") &&
    (value.assistantText === null || typeof value.assistantText === "string") && Array.isArray(value.toolCalls) && value.toolCalls.every(isChatToolCall) &&
    (value.failureMessage === null || typeof value.failureMessage === "string") && typeof value.actor === "string" && value.actor.length > 0 && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

export function parseChatHistory(value: unknown): { conversation: ChatConversation; turns: ChatTurn[] } | null {
  if (!record(value) || !isChatConversation(value.conversation) || !Array.isArray(value.turns) || !value.turns.every(isChatTurn)) return null;
  return { conversation: value.conversation, turns: value.turns };
}

/** Sends only completed human/assistant text to the model; tool data is UI audit history. */
export function buildPriorChatModelContext(turns: ChatTurn[], limits: { maxTurns?: number; maxCharacters?: number } = {}): ChatModelContextMessage[] {
  const maxTurns = limits.maxTurns ?? 5;
  const maxCharacters = limits.maxCharacters ?? 8_000;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 0 || !Number.isSafeInteger(maxCharacters) || maxCharacters < 0) throw new TypeError("context limits 는 0 이상의 정수여야 합니다.");
  const pairs = turns.filter((item) => item.status === "completed" && item.question.trim() && item.assistantText?.trim())
    .slice(-maxTurns).map((item): ChatModelContextMessage[] => [{ role: "user", content: item.question.trim() }, { role: "assistant", content: item.assistantText!.trim() }]);
  const kept: ChatModelContextMessage[] = [];
  let used = 0;
  for (const pair of [...pairs].reverse()) {
    const length = pair[0].content.length + pair[1].content.length;
    if (used + length > maxCharacters) continue;
    kept.unshift(...pair); used += length;
  }
  return kept;
}
