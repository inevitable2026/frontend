import type {
  BoardPage,
  BoardQuery,
  BoardStore,
  Detection,
  DetectionRun,
  DraftEdit,
  FactDelta,
  FactType,
  ItemPatch,
  SnapshotFact,
  WorkItem,
} from "./types";
import { createJsonBoardStore } from "./store-json";

// 저장소 구현이 두 벌인 이유는 스키마가 아직 남의 레포에서 합의되지 않았기 때문이다.
// 지금 실제로 도는 것은 JSON 구현이고, Postgres 구현은 테이블이 생기는 날 스위치 한 번으로
// 바꿔 끼우려고 미리 써 둔 것이다. 고르는 값은 BOARD_STORE 하나뿐이다.

export type BoardStoreDriver = "json" | "pg";

/**
 * 라우트가 상태 코드로 옮겨 적을 수 있게 오류를 네 갈래로만 나눈다.
 * 문구는 계약대로 한국어 완결 문장이고 마침표로 끝난다.
 */
export type BoardStoreErrorCode = "invalid" | "notFound" | "conflict" | "unavailable";

export class BoardStoreError extends Error {
  readonly code: BoardStoreErrorCode;

  constructor(code: BoardStoreErrorCode, message: string) {
    super(message);
    this.name = "BoardStoreError";
    this.code = code;
  }
}

/**
 * `instanceof` 대신 이 판별자를 쓴다. 라우트와 저장소가 서로 다른 번들 경계에 놓여도
 * 이름과 code 만 보면 갈라지므로 클래스 동일성에 기대지 않는다.
 */
export function isBoardStoreError(error: unknown): error is BoardStoreError {
  if (!(error instanceof Error)) return false;
  if (error.name !== "BoardStoreError") return false;
  return typeof (error as BoardStoreError).code === "string";
}

/** `{ error }` 응답에 붙일 상태 코드. 계약 2절이 쓰는 코드만 담는다. */
export const BOARD_STORE_ERROR_STATUS: Record<BoardStoreErrorCode, number> = {
  invalid: 400,
  notFound: 404,
  conflict: 409,
  unavailable: 503,
};

export function boardStoreDriver(): BoardStoreDriver {
  return process.env.BOARD_STORE === "pg" ? "pg" : "json";
}

/**
 * Postgres 구현을 첫 호출까지 미뤄 놓는 껍데기다.
 *
 * 정적으로 import 하면 `store-pg` → `lib/context/db` → `postgres` 가 모듈 평가 시점에 딸려
 * 들어온다. 지금 이 레포에는 `postgres` 가 설치되어 있지 않아서(package.json 에는 있지만
 * node_modules 에는 없다) JSON 으로 돌 때조차 보드 전체가 import 에서 죽는다.
 * 동적 import 로 미루면 BOARD_STORE=pg 인 사람만 그 대가를 치른다.
 */
function lazyPgBoardStore(): BoardStore {
  let pending: Promise<BoardStore> | null = null;

  function real(): Promise<BoardStore> {
    pending ??= import("./store-pg").then((module) => module.createPgBoardStore());
    return pending;
  }

  return {
    async listItems(query: BoardQuery): Promise<BoardPage> {
      return (await real()).listItems(query);
    },
    async getItem(itemId: string): Promise<WorkItem | null> {
      return (await real()).getItem(itemId);
    },
    async upsertItems(items: WorkItem[]): Promise<WorkItem[]> {
      return (await real()).upsertItems(items);
    },
    async moveItem(itemId: string, patch: ItemPatch): Promise<WorkItem> {
      return (await real()).moveItem(itemId, patch);
    },
    async rejectItem(itemId: string, reason: string, actor: string): Promise<WorkItem> {
      return (await real()).rejectItem(itemId, reason, actor);
    },
    async listFacts(siteId: string, factType?: FactType): Promise<SnapshotFact[]> {
      return (await real()).listFacts(siteId, factType);
    },
    async appendFacts(facts: SnapshotFact[]): Promise<FactDelta[]> {
      return (await real()).appendFacts(facts);
    },
    async latestSnapshotAt(siteId: string): Promise<string | null> {
      return (await real()).latestSnapshotAt(siteId);
    },
    async appendDetections(run: DetectionRun): Promise<void> {
      return (await real()).appendDetections(run);
    },
    async listDetections(siteId: string, since?: string): Promise<Detection[]> {
      return (await real()).listDetections(siteId, since);
    },
    async recordDraftEdits(itemId: string, actor: string, edits: DraftEdit[]): Promise<void> {
      return (await real()).recordDraftEdits(itemId, actor, edits);
    },
  };
}

declare global {
  var __boardStore: { driver: BoardStoreDriver; store: BoardStore } | undefined;
}

/**
 * 얇은 선택기. `BOARD_STORE=pg` 일 때만 Postgres 구현이고 그 밖에는 전부 JSON 구현이다.
 * 개발 중 HMR 로 모듈이 다시 평가되어도 같은 인스턴스를 쓰도록 전역에 얹는다
 * (`lib/context/db.ts` 의 `__contextSql` 과 같은 방식이고 이름만 달리 잡았다).
 */
export function boardStore(): BoardStore {
  const driver = boardStoreDriver();
  const cached = globalThis.__boardStore;
  if (cached && cached.driver === driver) return cached.store;

  const store = driver === "pg" ? lazyPgBoardStore() : createJsonBoardStore();
  globalThis.__boardStore = { driver, store };
  return store;
}
