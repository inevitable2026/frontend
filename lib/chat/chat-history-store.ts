import { db } from "@/lib/context/db";
import type {
  ChatConversation,
  ChatToolCall,
  ChatTurn,
  ChatTurnBeginResult,
  ChatTurnCommand,
  ChatTurnCompletion,
  ChatTurnFailure,
} from "@/lib/chat/chat-history-types";
import { isChatToolCall } from "@/lib/chat/chat-history-types";

export { buildPriorChatModelContext } from "@/lib/chat/chat-history-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 80;
const PENDING_STALE_MS = 10 * 60 * 1_000;
const STALE_FAILURE_MESSAGE = "처리가 중단된 질문입니다. 새 질문으로 다시 시도해 주세요.";

type ConversationRow = Omit<ChatConversation, "createdAt" | "updatedAt"> & { createdAt: Date | string; updatedAt: Date | string };
type TurnRow = Omit<ChatTurn, "createdAt" | "updatedAt" | "toolCalls"> & { createdAt: Date | string; updatedAt: Date | string; toolCalls: unknown };

export class ChatHistoryUnavailableError extends Error {
  readonly code = "unavailable";
  readonly status = 503;
  constructor(message = "대화 기록 저장소를 사용할 수 없습니다.") { super(message); this.name = "ChatHistoryUnavailableError"; }
}

export class ChatConversationNotFoundError extends Error {
  readonly code = "conversation_not_found";
  readonly status = 404;
  constructor() { super("이 현장의 대화 기록을 찾지 못했습니다."); this.name = "ChatConversationNotFoundError"; }
}

export class ChatTurnInFlightError extends Error {
  readonly code = "turn_in_flight";
  readonly status = 409;
  constructor() { super("이 대화에는 아직 처리 중인 질문이 있습니다."); this.name = "ChatTurnInFlightError"; }
}

export class ChatTurnCommandReuseError extends Error {
  readonly code = "command_reuse";
  readonly status = 409;
  constructor() { super("같은 명령 식별자가 다른 대화 내용으로 다시 사용되었습니다."); this.name = "ChatTurnCommandReuseError"; }
}

export class ChatTurnTransitionConflictError extends Error {
  readonly code = "turn_transition_conflict";
  readonly status = 409;
  constructor() { super("처리 중인 대화 턴만 완료하거나 실패로 바꿀 수 있습니다."); this.name = "ChatTurnTransitionConflictError"; }
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ChatHistoryUnavailableError("저장된 대화 시각이 올바르지 않습니다.");
  return date.toISOString();
}

function sequence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ChatHistoryUnavailableError("저장된 대화 순서가 올바르지 않습니다.");
  return parsed;
}

function toolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value) || !value.every(isChatToolCall)) throw new ChatHistoryUnavailableError("저장된 도구 실행 기록의 형식이 올바르지 않습니다.");
  return value;
}

function conversation(row: ConversationRow): ChatConversation {
  return {
    conversationId: row.conversationId,
    siteId: row.siteId,
    title: row.title,
    actor: row.actor,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function turn(row: TurnRow): ChatTurn {
  return {
    turnId: row.turnId, conversationId: row.conversationId, siteId: row.siteId, commandId: row.commandId,
    sequence: sequence(row.sequence), question: row.question, status: row.status, assistantText: row.assistantText,
    toolCalls: toolCalls(row.toolCalls), failureMessage: row.failureMessage, actor: row.actor, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
  };
}

function assertSiteId(siteId: string): void {
  if (!UUID.test(siteId)) throw new TypeError("siteId 는 UUID 여야 합니다.");
}

function assertConversationId(conversationId: string): void {
  if (!UUID.test(conversationId)) throw new TypeError("conversationId 는 UUID 여야 합니다.");
}

function assertCommand(command: ChatTurnCommand): void {
  assertSiteId(command.siteId);
  if (command.conversationId !== undefined) assertConversationId(command.conversationId);
  if (!UUID.test(command.commandId)) throw new TypeError("commandId 는 UUID 여야 합니다.");
  const question = command.question.trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) throw new TypeError(`question 은 ${MAX_QUESTION_LENGTH}자 이하의 내용이 필요합니다.`);
  if (!command.actor.trim()) throw new TypeError("actor 가 필요합니다.");
}

function titleFromQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
}

function assertToolCalls(value: ChatToolCall[]): void {
  if (!Array.isArray(value) || !value.every(isChatToolCall)) throw new TypeError("toolCalls 형식이 올바르지 않습니다.");
}

async function ensureSchema(): Promise<void> {
  const [row] = await db()<{ ready: boolean }[]>`
    select to_regclass('public.chat_conversations') is not null
       and to_regclass('public.chat_turns') is not null as ready
  `;
  if (!row?.ready) throw new ChatHistoryUnavailableError("대화 기록 마이그레이션이 적용되지 않았습니다.");
}

function sameCommand(row: TurnRow, command: ChatTurnCommand): boolean {
  return row.siteId === command.siteId && row.question === command.question.trim() && row.actor === command.actor.trim() &&
    (command.conversationId === undefined || row.conversationId === command.conversationId);
}

export async function beginChatTurn(command: ChatTurnCommand): Promise<ChatTurnBeginResult> {
  assertCommand(command);
  await ensureSchema();
  const sql = db();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    const commands = await tx<TurnRow[]>`
      select turn_id as "turnId", conversation_id as "conversationId", site_id as "siteId",
             command_id as "commandId", sequence, question, status,
             assistant_text as "assistantText", tool_calls as "toolCalls",
             failure_message as "failureMessage", actor,
             created_at as "createdAt", updated_at as "updatedAt"
        from chat_turns
       where command_id = ${command.commandId}::uuid for update
    `;
    if (commands[0]) {
      if (!sameCommand(commands[0], command)) throw new ChatTurnCommandReuseError();
      if (commands[0].status === "pending") {
        const expired = await tx<TurnRow[]>`
          update chat_turns
             set status = 'failed', failure_message = ${STALE_FAILURE_MESSAGE}, updated_at = now()
           where command_id = ${command.commandId}::uuid and status = 'pending'
             and updated_at < now() - (${PENDING_STALE_MS} * interval '1 millisecond')
          returning turn_id as "turnId", conversation_id as "conversationId", site_id as "siteId",
                    command_id as "commandId", sequence, question, status,
                    assistant_text as "assistantText", tool_calls as "toolCalls",
                    failure_message as "failureMessage", actor,
                    created_at as "createdAt", updated_at as "updatedAt"
        `;
        if (!expired[0]) throw new ChatTurnInFlightError();
        commands[0] = expired[0];
      }
      const conversations = await tx<ConversationRow[]>`
        select conversation_id as "conversationId", site_id as "siteId", title, actor,
               created_at as "createdAt", updated_at as "updatedAt"
          from chat_conversations
         where conversation_id = ${commands[0].conversationId}::uuid and site_id = ${command.siteId}::uuid
      `;
      if (!conversations[0]) throw new ChatHistoryUnavailableError("대화 턴의 대화가 없습니다.");
      return { conversation: conversation(conversations[0]), turn: turn(commands[0]), replayed: true };
    }

    const conversationId = command.conversationId ?? crypto.randomUUID();
    await tx`select pg_advisory_xact_lock(hashtextextended(${conversationId}, 0))`;
    const conversations = command.conversationId
      ? await tx<ConversationRow[]>`
          select conversation_id as "conversationId", site_id as "siteId", title, actor,
                 created_at as "createdAt", updated_at as "updatedAt"
            from chat_conversations
           where conversation_id = ${conversationId}::uuid and site_id = ${command.siteId}::uuid for update
        `
      : await tx<ConversationRow[]>`
          insert into chat_conversations (conversation_id, site_id, title, actor)
          values (${conversationId}::uuid, ${command.siteId}::uuid, ${titleFromQuestion(command.question)}, ${command.actor.trim()})
          returning conversation_id as "conversationId", site_id as "siteId", title, actor,
                    created_at as "createdAt", updated_at as "updatedAt"
        `;
    if (!conversations[0]) throw new ChatConversationNotFoundError();

    await tx`
      update chat_turns
         set status = 'failed', failure_message = ${STALE_FAILURE_MESSAGE}, updated_at = now()
       where conversation_id = ${conversationId}::uuid and status = 'pending'
         and updated_at < now() - (${PENDING_STALE_MS} * interval '1 millisecond')
    `;
    const pending = await tx<{ exists: boolean }[]>`
      select exists(select 1 from chat_turns where conversation_id = ${conversationId}::uuid and status = 'pending') as exists
    `;
    if (pending[0]?.exists) throw new ChatTurnInFlightError();
    const saved = await tx<TurnRow[]>`
      insert into chat_turns (turn_id, conversation_id, site_id, command_id, sequence, question, status, actor)
      values (${crypto.randomUUID()}::uuid, ${conversationId}::uuid, ${command.siteId}::uuid, ${command.commandId}::uuid,
        (select coalesce(max(sequence), 0) + 1 from chat_turns where conversation_id = ${conversationId}::uuid),
        ${command.question.trim()}, 'pending', ${command.actor.trim()})
      returning turn_id as "turnId", conversation_id as "conversationId", site_id as "siteId",
                command_id as "commandId", sequence, question, status,
                assistant_text as "assistantText", tool_calls as "toolCalls",
                failure_message as "failureMessage", actor,
                created_at as "createdAt", updated_at as "updatedAt"
    `;
    if (!saved[0]) throw new ChatHistoryUnavailableError();
    return { conversation: conversation(conversations[0]), turn: turn(saved[0]), replayed: false };
  });
}

async function finishChatTurn(input: ChatTurnCompletion | ChatTurnFailure, status: "completed" | "failed"): Promise<{ turn: ChatTurn; replayed: boolean }> {
  assertSiteId(input.siteId); assertConversationId(input.conversationId);
  if (!UUID.test(input.commandId)) throw new TypeError("commandId 는 UUID 여야 합니다.");
  if (!input.actor.trim()) throw new TypeError("actor 가 필요합니다.");
  const text = status === "completed"
    ? (input as ChatTurnCompletion).assistantText.trim()
    : (input as ChatTurnFailure).failureMessage.trim();
  if (!text) throw new TypeError(status === "completed" ? "assistantText 가 필요합니다." : "failureMessage 가 필요합니다.");
  assertToolCalls(input.toolCalls ?? []);
  await ensureSchema();
  const sql = db();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${input.commandId}, 0))`;
    const current = await tx<TurnRow[]>`
      select turn_id as "turnId", conversation_id as "conversationId", site_id as "siteId", command_id as "commandId", sequence, question, status, assistant_text as "assistantText", tool_calls as "toolCalls", failure_message as "failureMessage", actor, created_at as "createdAt", updated_at as "updatedAt" from chat_turns
       where command_id = ${input.commandId}::uuid and conversation_id = ${input.conversationId}::uuid and site_id = ${input.siteId}::uuid for update
    `;
    if (!current[0]) throw new ChatConversationNotFoundError();
    if (current[0].status !== "pending") {
      const prior = turn(current[0]);
      const sameResult = status === "completed"
        ? prior.assistantText === text && JSON.stringify(prior.toolCalls) === JSON.stringify(input.toolCalls)
        : prior.failureMessage === text && JSON.stringify(prior.toolCalls) === JSON.stringify(input.toolCalls ?? []);
      if (current[0].status === status && current[0].actor === input.actor.trim() && sameResult) {
        return { turn: prior, replayed: true };
      }
      throw new ChatTurnTransitionConflictError();
    }
    const saved = status === "completed"
      ? await tx<TurnRow[]>`
          update chat_turns set status = 'completed', assistant_text = ${text}, tool_calls = ${JSON.stringify(input.toolCalls)}::text::jsonb, updated_at = now()
           where command_id = ${input.commandId}::uuid returning turn_id as "turnId", conversation_id as "conversationId", site_id as "siteId", command_id as "commandId", sequence, question, status, assistant_text as "assistantText", tool_calls as "toolCalls", failure_message as "failureMessage", actor, created_at as "createdAt", updated_at as "updatedAt"
        `
      : await tx<TurnRow[]>`
          update chat_turns set status = 'failed', failure_message = ${text}, tool_calls = ${JSON.stringify(input.toolCalls ?? [])}::text::jsonb, updated_at = now()
           where command_id = ${input.commandId}::uuid returning turn_id as "turnId", conversation_id as "conversationId", site_id as "siteId", command_id as "commandId", sequence, question, status, assistant_text as "assistantText", tool_calls as "toolCalls", failure_message as "failureMessage", actor, created_at as "createdAt", updated_at as "updatedAt"
        `;
    await tx`update chat_conversations set updated_at = now() where conversation_id = ${input.conversationId}::uuid`;
    if (!saved[0]) throw new ChatHistoryUnavailableError();
    return { turn: turn(saved[0]), replayed: false };
  });
}

export function completeChatTurn(input: ChatTurnCompletion): Promise<{ turn: ChatTurn; replayed: boolean }> { return finishChatTurn(input, "completed"); }
export function failChatTurn(input: ChatTurnFailure): Promise<{ turn: ChatTurn; replayed: boolean }> { return finishChatTurn(input, "failed"); }

export async function hydrateChatHistory(input: { siteId: string; conversationId: string }): Promise<{ conversation: ChatConversation; turns: ChatTurn[] }> {
  assertSiteId(input.siteId); assertConversationId(input.conversationId); await ensureSchema();
  const sql = db();
  const conversations = await sql<ConversationRow[]>`
    select conversation_id as "conversationId", site_id as "siteId", title, actor,
           created_at as "createdAt", updated_at as "updatedAt"
      from chat_conversations
     where conversation_id = ${input.conversationId}::uuid and site_id = ${input.siteId}::uuid
  `;
  if (!conversations[0]) throw new ChatConversationNotFoundError();
  await sql`
    update chat_turns
       set status = 'failed', failure_message = ${STALE_FAILURE_MESSAGE}, updated_at = now()
     where conversation_id = ${input.conversationId}::uuid and site_id = ${input.siteId}::uuid
       and status = 'pending'
       and updated_at < now() - (${PENDING_STALE_MS} * interval '1 millisecond')
  `;
  const rows = await sql<TurnRow[]>`select turn_id as "turnId", conversation_id as "conversationId", site_id as "siteId", command_id as "commandId", sequence, question, status, assistant_text as "assistantText", tool_calls as "toolCalls", failure_message as "failureMessage", actor, created_at as "createdAt", updated_at as "updatedAt" from chat_turns where conversation_id = ${input.conversationId}::uuid and site_id = ${input.siteId}::uuid order by sequence asc`;
  return { conversation: conversation(conversations[0]), turns: rows.map(turn) };
}
