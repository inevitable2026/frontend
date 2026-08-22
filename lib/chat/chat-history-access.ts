export type ChatHistoryAccess = {
  actor: "local-console";
  siteIds: Set<string>;
};

export class ChatHistoryAccessUnavailableError extends Error {
  readonly code = "unavailable";

  constructor(message: string) {
    super(message);
    this.name = "ChatHistoryAccessUnavailableError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Until the console has request-bound authentication, chat history is strictly
 * a local development convenience. Production must not accidentally create a
 * shared transcript merely because the database is configured.
 */
export function chatHistoryAccess(env: NodeJS.ProcessEnv = process.env): ChatHistoryAccess {
  if (env.NODE_ENV === "production") {
    throw new ChatHistoryAccessUnavailableError("로그인 기반 권한이 없어 production 대화 기록은 비활성화되어 있습니다.");
  }
  if (env.CHAT_HISTORY_LOCAL_ENABLED !== "true") {
    throw new ChatHistoryAccessUnavailableError("대화 기록을 쓰려면 CHAT_HISTORY_LOCAL_ENABLED=true 가 필요합니다.");
  }
  if (!env.DATABASE_URL) {
    throw new ChatHistoryAccessUnavailableError("대화 기록을 쓰려면 DATABASE_URL 이 필요합니다.");
  }
  const siteIds = new Set(
    (env.CONSOLE_SITE_IDS ?? "").split(",").map((value) => value.trim()).filter((value) => UUID.test(value)),
  );
  if (siteIds.size === 0) {
    throw new ChatHistoryAccessUnavailableError("CONSOLE_SITE_IDS 에 허용할 현장 UUID가 필요합니다.");
  }
  return { actor: "local-console", siteIds };
}
