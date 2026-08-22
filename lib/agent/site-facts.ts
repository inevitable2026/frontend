// 현장 사실 도구 — 챗봇이 공공데이터와 공정·인원 수치를 읽는 자리.
//
// 이 도구만 검색·읽기 2단이 아니라 단일 도구인 이유는 값의 성격이다. 강우량·공정률·
// 출역인원은 문장이 아니라 수치이고, 그 수치를 옳게 만드는 것은 어휘의 유사도가 아니라
// 관측 시각이다. 임베딩해서 벡터로 찾으면 지난주 41mm 와 오늘 0mm 가 같은 점수로 올라오고,
// 모델은 둘 중 위에 뜬 것을 오늘 값이라고 읽는다. 그래서 여기서는 색인을 만들지 않고
// 저장소가 들고 있는 관측 이력을 시각 순으로 그대로 준다.
//
// 읽기는 반드시 boardStore() 를 거친다. 저장소가 JSON·Postgres 두 벌이라
// (lib/board/store.ts 의 주석) 여기서 SQL 을 직접 치면 BOARD_STORE 가 json 인 설정에서
// 곧바로 죽는다. 어느 구현이 도는지는 이 파일이 알 필요가 없다.

import { BOARD_SITE_ID } from "@/lib/board/site";
import { boardStoreDriver, boardStore, isBoardStoreError } from "@/lib/board/store";
import { FACT_TYPES, type FactType, type SnapshotFact } from "@/lib/board/types";
import { kstStamp } from "@/lib/connect/types";

/**
 * 챗봇에게 건네는 사실 한 줄.
 *
 * `source` 가 문자열 한 칸인 것은 심사에서 반드시 나오는 질문("이거 진짜 데이터입니까")이
 * 답변까지 닿아야 하기 때문이다. 등급과 출처 문서를 한 칸에 붙여 두면 모델이 값만 옮겨
 * 적고 출처를 빠뜨리는 경로가 없다.
 */
export type SiteFact = {
  factType: string;
  key: string;
  value: unknown;
  /** 관측 시각. ISO8601 (KST) */
  observedAt: string;
  source: string;
};

/** 한 번에 돌려주는 사실 수. 모델의 맥락을 이 도구 하나로 채우지 않으려는 값이다. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// 이 레포에서 실제로 바깥 세상을 다녀온 사실은 기상청 단기예보 하나뿐이다.
// lib/connect/weather.ts 가 실연동에 성공했을 때만 sourceDocId 를 이 접두로 짓고,
// 시드로 내려가면 seed_ 로 짓는다. 그 갈림이 여기서 등급이 된다.
const LIVE_SOURCE_PREFIX = "kma_";

function 출처표기(sourceDocId: string | null): string {
  if (!sourceDocId) return "합성 — 출처 문서 없음(시나리오 시드)";
  const 등급 = sourceDocId.startsWith(LIVE_SOURCE_PREFIX) ? "실데이터" : "합성";
  return `${등급} — ${sourceDocId}`;
}

/**
 * 관측 시각을 밀리초로 읽는다.
 *
 * `SnapshotFact.observedAt` 의 타입은 string 이지만 Postgres 구현에서는 timestamptz 열이
 * 드라이버를 거치며 Date 객체로 실려 온다(app/api/board/weather/route.ts 가 같은 이유로
 * 같은 함수를 들고 있다). 문자열이라고 믿고 비교하면 그 자리에서 순서가 뒤집힌다.
 * 읽을 수 없는 값은 0 으로 두어 최신 판정에서 지게 한다.
 */
function 관측밀리초(observedAt: unknown): number {
  const 밀리초 = Date.parse(String(observedAt));
  return Number.isFinite(밀리초) ? 밀리초 : 0;
}

function 관측시각표기(observedAt: unknown): string {
  const 밀리초 = Date.parse(String(observedAt));
  // 파싱에 실패한 값을 지금 시각으로 메우지 않는다. 시각을 지어내는 순간 이 도구가
  // 막으려던 사고("41mm 가 언제 값인지 모른 채 오늘 비가 온다고 읽는 것")가 그대로 난다.
  if (!Number.isFinite(밀리초)) return String(observedAt);
  return kstStamp(new Date(밀리초));
}

function toSiteFact(fact: SnapshotFact): SiteFact {
  return {
    factType: fact.factType,
    key: fact.key,
    value: fact.value,
    observedAt: 관측시각표기(fact.observedAt),
    source: 출처표기(fact.sourceDocId),
  };
}

function 정한limit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

function 정한factType(raw: string | undefined): FactType | undefined {
  if (raw === undefined) return undefined;
  const 값 = raw.trim();
  if (!값) return undefined;
  // 모르는 종류를 빈 배열로 돌려주면 모델은 "그런 사실이 없다" 로 읽고 답변에 그렇게 쓴다.
  // 오타와 부재는 다른 사실이라 오류로 드러낸다. 고를 수 있는 값을 문구에 같이 실어
  // 모델이 한 번에 고쳐 다시 부를 수 있게 한다.
  if (!(FACT_TYPES as string[]).includes(값)) {
    throw new Error(`알 수 없는 사실 종류입니다: ${값}. 고를 수 있는 값은 ${FACT_TYPES.join(", ")} 입니다.`);
  }
  return 값 as FactType;
}

/**
 * 보드 저장소가 사실을 돌려줄 수 있는 상태인지.
 *
 * JSON 구현은 data/board/seed-*.json 이 레포에 함께 있어 언제나 읽힌다. `BOARD_STORE=pg`
 * 로 골랐을 때만 DATABASE_URL 이 실제 조건이 된다 — 없으면 첫 질의에서 커넥션이 터지고,
 * 그 오류는 도구를 부른 뒤에야 드러나 답변 한 번을 통째로 버리게 된다.
 */
export function isSiteFactsConfigured(): boolean {
  if (boardStoreDriver() === "pg") return Boolean(process.env.DATABASE_URL?.trim());
  return true;
}

/**
 * 현장 사실을 최신 관측 순으로 읽는다.
 *
 * 같은 (factType, key) 의 이력을 접지 않고 그대로 둔다. 접으면 "0mm 였다가 41mm 가 됐다"
 * 는 변화가 사라지는데, 현장에서 판단을 바꾸는 것은 값 자체가 아니라 그 변화이기 때문이다.
 * 대신 언제나 최신이 먼저 오므로 모델이 맨 앞을 현재 값으로 읽어도 틀리지 않는다.
 */
export async function readSiteFacts(
  options?: { factType?: string; siteId?: string; limit?: number },
): Promise<SiteFact[]> {
  const siteId = options?.siteId?.trim() || BOARD_SITE_ID;
  const factType = 정한factType(options?.factType);
  const limit = 정한limit(options?.limit);

  let facts: SnapshotFact[];
  try {
    facts = await boardStore().listFacts(siteId, factType);
  } catch (error) {
    // 저장소가 스스로 판정한 오류(잘못된 siteId · 저장소 없음)는 코드를 달고 오므로
    // 그대로 흘려보낸다. 라우트가 BOARD_STORE_ERROR_STATUS 로 상태 코드를 옮겨 적는다.
    // 그 밖의 오류는 여기서 무엇을 하다 났는지 한 겹 씌워 넘긴다 — 커넥션 오류 원문만
    // 올라가면 도구 실패가 챗봇 전체 장애처럼 읽힌다.
    if (isBoardStoreError(error)) throw error;
    throw new Error(`현장 사실을 읽지 못했습니다: ${siteId}`, { cause: error });
  }

  return facts
    .map(toSiteFact)
    .sort((a, b) => {
      const 차 = 관측밀리초(b.observedAt) - 관측밀리초(a.observedAt);
      if (차 !== 0) return 차;
      // 같은 시각에 들어온 사실끼리는 순서가 매번 달라지면 안 된다. 같은 질문에 답이
      // 흔들리는 것으로 보이기 때문에 자리 이름으로 못 박는다.
      if (a.factType !== b.factType) return a.factType < b.factType ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, limit);
}
