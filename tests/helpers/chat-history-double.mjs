/**
 * `@/lib/chat/chat-history-*` 대역.
 *
 * 라우트는 이제 답을 만들기 전후로 기록을 거친다 — `beginChatTurn` 으로 턴을 열고,
 * `completeChatTurn` 으로 닫은 뒤 **저장된 턴에서** 응답 봉투를 되만든다. 저장소가 postgres
 * 라서, 이 대역이 없으면 인용 격리 규약 시험을 한 줄도 돌릴 수 없다. 저장소만 메모리로
 * 바꾸고 규약은 라우트에 그대로 남긴다.
 *
 * 진짜 저장소에서 라우트가 기대는 계약만 옮겨 온다.
 *   - 같은 commandId 는 다시 돌리지 않고 저장된 턴을 그대로 돌려준다(`replayed`).
 *   - 같은 commandId 가 다른 내용으로 오면 되돌린다. 한 대화에 처리 중인 턴은 하나뿐이다.
 *   - 끝난 턴은 **같은 결과로만** 다시 끝낼 수 있다.
 *   - 저장은 JSON 을 거친다. 도구 결과가 봉투로 돌아올 때 형태가 유지되는지도 여기서 걸린다.
 *
 * DB 몫(광고 잠금·묵은 pending 회수·스키마 확인)은 옮기지 않는다. 그건 저장소가 지킬 몫이지
 * 라우트가 지킬 몫이 아니다.
 */
import { randomUUID } from "node:crypto";

import { isChatToolCall } from "../../tmp/test-dist/lib/chat/chat-history-types.js";

export { buildPriorChatModelContext } from "../../tmp/test-dist/lib/chat/chat-history-types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_TITLE_LENGTH = 80;

/** 대역이 허용하는 현장. `chatRequest` 가 싣는 siteId 와 같은 값이다. */
export const TEST_SITE_ID = "44444444-4444-4444-8444-444444444444";

export class ChatHistoryAccessUnavailableError extends Error {
  constructor(message) { super(message); this.name = "ChatHistoryAccessUnavailableError"; }
}
export class ChatHistoryUnavailableError extends Error {
  constructor(message = "대화 기록 저장소를 사용할 수 없습니다.") { super(message); this.name = "ChatHistoryUnavailableError"; }
}
export class ChatConversationNotFoundError extends Error {
  constructor() { super("이 현장의 대화 기록을 찾지 못했습니다."); this.name = "ChatConversationNotFoundError"; }
}
export class ChatTurnInFlightError extends Error {
  constructor() { super("이 대화에는 아직 처리 중인 질문이 있습니다."); this.name = "ChatTurnInFlightError"; }
}
export class ChatTurnCommandReuseError extends Error {
  constructor() { super("같은 명령 식별자가 다른 대화 내용으로 다시 사용되었습니다."); this.name = "ChatTurnCommandReuseError"; }
}
export class ChatTurnTransitionConflictError extends Error {
  constructor() { super("처리 중인 대화 턴만 완료하거나 실패로 바꿀 수 있습니다."); this.name = "ChatTurnTransitionConflictError"; }
}

export function chatHistoryAccess() {
  return { actor: "local-console", siteIds: new Set([TEST_SITE_ID]) };
}

/** 대화방과 턴. `byCommand` 는 진짜의 `command_id` 유일 색인 자리다. */
const rooms = new Map();
const byCommand = new Map();

export function resetChatHistory() {
  rooms.clear();
  byCommand.clear();
}

/** jsonb 왕복. 저장 경계를 넘지 못하는 값(undefined·Map·함수)을 여기서 떨군다. */
const stored = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

function assertSiteId(siteId) { if (!UUID.test(siteId)) throw new TypeError("siteId 는 UUID 여야 합니다."); }
function assertConversationId(conversationId) { if (!UUID.test(conversationId)) throw new TypeError("conversationId 는 UUID 여야 합니다."); }
function assertToolCalls(value) { if (!Array.isArray(value) || !value.every(isChatToolCall)) throw new TypeError("toolCalls 형식이 올바르지 않습니다."); }

function assertCommand(command) {
  assertSiteId(command.siteId);
  if (command.conversationId !== undefined) assertConversationId(command.conversationId);
  if (!UUID.test(command.commandId)) throw new TypeError("commandId 는 UUID 여야 합니다.");
  const question = command.question.trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) throw new TypeError(`question 은 ${MAX_QUESTION_LENGTH}자 이하의 내용이 필요합니다.`);
  if (!command.actor.trim()) throw new TypeError("actor 가 필요합니다.");
}

function sameCommand(turn, command) {
  return turn.siteId === command.siteId && turn.question === command.question.trim() && turn.actor === command.actor.trim() &&
    (command.conversationId === undefined || turn.conversationId === command.conversationId);
}

export async function beginChatTurn(command) {
  assertCommand(command);
  const replay = byCommand.get(command.commandId);
  if (replay) {
    if (!sameCommand(replay, command)) throw new ChatTurnCommandReuseError();
    const room = rooms.get(replay.conversationId);
    if (!room || room.conversation.siteId !== command.siteId) throw new ChatHistoryUnavailableError("대화 턴의 대화가 없습니다.");
    return { conversation: stored(room.conversation), turn: stored(replay), replayed: true };
  }

  const conversationId = command.conversationId ?? randomUUID();
  let room = rooms.get(conversationId);
  if (command.conversationId) {
    if (!room || room.conversation.siteId !== command.siteId) throw new ChatConversationNotFoundError();
  } else {
    const stamp = now();
    room = {
      conversation: {
        conversationId, siteId: command.siteId, title: command.question.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH),
        actor: command.actor.trim(), createdAt: stamp, updatedAt: stamp,
      },
      turns: [],
    };
    rooms.set(conversationId, room);
  }
  if (room.turns.some((turn) => turn.status === "pending")) throw new ChatTurnInFlightError();

  const stamp = now();
  const turn = {
    turnId: randomUUID(), conversationId, siteId: command.siteId, commandId: command.commandId,
    sequence: room.turns.length + 1, question: command.question.trim(), status: "pending",
    assistantText: null, toolCalls: [], failureMessage: null, actor: command.actor.trim(), createdAt: stamp, updatedAt: stamp,
  };
  room.turns.push(turn);
  byCommand.set(command.commandId, turn);
  return { conversation: stored(room.conversation), turn: stored(turn), replayed: false };
}

async function finishChatTurn(input, status) {
  assertSiteId(input.siteId);
  assertConversationId(input.conversationId);
  if (!UUID.test(input.commandId)) throw new TypeError("commandId 는 UUID 여야 합니다.");
  if (!input.actor.trim()) throw new TypeError("actor 가 필요합니다.");
  const text = (status === "completed" ? input.assistantText : input.failureMessage).trim();
  if (!text) throw new TypeError(status === "completed" ? "assistantText 가 필요합니다." : "failureMessage 가 필요합니다.");
  const calls = input.toolCalls ?? [];
  assertToolCalls(calls);

  const turn = byCommand.get(input.commandId);
  if (!turn || turn.conversationId !== input.conversationId || turn.siteId !== input.siteId) throw new ChatConversationNotFoundError();
  if (turn.status !== "pending") {
    const sameResult = status === "completed"
      ? turn.assistantText === text && JSON.stringify(turn.toolCalls) === JSON.stringify(calls)
      : turn.failureMessage === text && JSON.stringify(turn.toolCalls) === JSON.stringify(calls);
    if (turn.status === status && turn.actor === input.actor.trim() && sameResult) return { turn: stored(turn), replayed: true };
    throw new ChatTurnTransitionConflictError();
  }

  turn.status = status;
  if (status === "completed") turn.assistantText = text;
  else turn.failureMessage = text;
  turn.toolCalls = stored(calls);
  turn.updatedAt = now();
  rooms.get(turn.conversationId).conversation.updatedAt = turn.updatedAt;
  return { turn: stored(turn), replayed: false };
}

export function completeChatTurn(input) { return finishChatTurn(input, "completed"); }
export function failChatTurn(input) { return finishChatTurn(input, "failed"); }

export async function hydrateChatHistory(input) {
  assertSiteId(input.siteId);
  assertConversationId(input.conversationId);
  const room = rooms.get(input.conversationId);
  if (!room || room.conversation.siteId !== input.siteId) throw new ChatConversationNotFoundError();
  return { conversation: stored(room.conversation), turns: room.turns.map(stored) };
}
