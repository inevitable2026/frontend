// 커넥터 실행기.
//
// 커넥터를 한 번에 돌려 사실을 모은다. 하나가 넘어져도 나머지는 계속 간다 —
// 기상 API 가 죽었다고 출역 명부가 사라지면 감지가 통째로 멈춘다. 넘어진
// 커넥터는 결과에 오류로 남아 브리핑의 "불확실성" 칸에 그대로 옮겨 적을 수 있다.

import type { FactType, SnapshotFact } from "@/lib/board/types";
import {
  type ConnectRun,
  type Connector,
  type ConnectorResult,
  factKey,
  kstStamp,
} from "./types";
import { rosterConnector } from "./roster";
import { scheduleConnector } from "./schedule";
import { weatherConnector } from "./weather";

export * from "./types";
export { weatherConnector, isWeatherApiConfigured } from "./weather";
export { scheduleConnector } from "./schedule";
export { rosterConnector } from "./roster";

// 커넥터 하나가 매달리면 전체가 그 지연에 묶인다. 개별 상한을 둔다.
const CONNECTOR_TIMEOUT_MS = 15_000;

export const CONNECTORS: Connector[] = [weatherConnector, scheduleConnector, rosterConnector];

/** 그 사실 종류를 내보내겠다고 선언한 커넥터들. */
export function connectorsFor(
  factType: FactType,
  connectors: Connector[] = CONNECTORS,
): Connector[] {
  return connectors.filter((connector) => connector.factTypes.includes(factType));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function withTimeout<T>(work: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CONNECTOR_TIMEOUT:${id}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runOne(
  connector: Connector,
  siteId: string,
  at: Date,
): Promise<ConnectorResult> {
  const 시작 = Date.now();
  try {
    const facts = await withTimeout(connector.fetch(siteId, at), CONNECTOR_TIMEOUT_MS, connector.id);
    return {
      connectorId: connector.id,
      label: connector.label,
      상태: "성공",
      facts,
      사유: null,
      소요ms: Date.now() - 시작,
    };
  } catch (error) {
    return {
      connectorId: connector.id,
      label: connector.label,
      상태: "실패",
      facts: [],
      사유: describe(error),
      소요ms: Date.now() - 시작,
    };
  }
}

/**
 * 커넥터를 모두 돌려 SnapshotFact 를 한 배열로 모은다.
 *
 * - 실패는 던지지 않고 결과에 남는다.
 * - 같은 (factType, key) 가 둘 이상이면 커넥터 목록에서 먼저 온 쪽이 이기고,
 *   진 쪽의 자리는 중복키에 적힌다. 사실이 조용히 덮이면 델타가 흔들린다.
 * - 요청한 현장이 아닌 사실은 버린다.
 */
export async function collectFacts(
  siteId: string,
  at: Date = new Date(),
  connectors: Connector[] = CONNECTORS,
): Promise<ConnectRun> {
  const 결과 = await Promise.all(
    connectors.map((connector) => runOne(connector, siteId, at)),
  );

  const facts: SnapshotFact[] = [];
  const 자리 = new Set<string>();
  const 중복키: string[] = [];
  let 버린사실수 = 0;

  for (const one of 결과) {
    for (const fact of one.facts) {
      if (fact.siteId !== siteId) {
        버린사실수 += 1;
        continue;
      }
      const 자리이름 = factKey(fact);
      if (자리.has(자리이름)) {
        중복키.push(`${자리이름} (${one.connectorId})`);
        continue;
      }
      자리.add(자리이름);
      facts.push(fact);
    }
  }

  return {
    siteId,
    수집시각: kstStamp(at),
    facts,
    결과,
    성공수: 결과.filter((one) => one.상태 === "성공").length,
    실패수: 결과.filter((one) => one.상태 === "실패").length,
    중복키,
    버린사실수,
  };
}
