import { db } from "./db.ts";

/**
 * 회수기가 **지금** 살아 있는지 읽는다.
 *
 * **왜 영수증에서 읽지 않는가.** 영수증은 발급 시점에 굳는다. 거기 적힌
 * `sweeper.checkedAt` 은 "그때 살아 있었다" 는 기록이지 "지금 살아 있다" 가 아니다.
 * 그런데 게이트가 보증하려는 것은 지금이다 — 지금 올린 계약서가 지워질 것인가.
 *
 * 얼려붙은 값으로 그 질문에 답하려면 영수증을 아주 짧게 만들 수밖에 없고, 실제로
 * 그렇게 돼 있었다(15분). 그러면 배포된 환경에서는 **15분 뒤 저절로 꺼진다** —
 * 환경변수를 15분마다 갈아 끼울 수는 없다.
 *
 * 그래서 갈랐다. 영수증은 **잘 변하지 않는 사실**을 지고 간다 — 에이전트 신원, config 핀,
 * 매니페스트 지문, 정리 마이그레이션 버전. 회수기가 지금 도는지는 **살아 있는 값**이므로
 * 매 요청마다 여기서 읽는다.
 *
 * 이건 게이트를 느슨하게 하는 것이 아니다. 오히려 반대다 — 예전에는 15분 전에 한 번
 * 확인하면 그 뒤로 회수기가 죽어도 창이 닫힐 때까지 몰랐다. 지금은 회수기가 멎으면
 * 다음 요청에서 바로 막힌다.
 */

export type SweeperHeartbeat = {
  checkedAt: string;
  /** 우리 회수기만 이 칸을 쓴다. 마이그레이션 전이거나 남이 마지막에 썼으면 null 이다. */
  recoveryPolicy: string | null;
};

export type SweeperProbe = () => Promise<SweeperHeartbeat | null>;

/** 실제 DB 를 읽는 기본 프로브. 행이 없거나 컬럼이 없으면 `null` — 지어내지 않는다. */
export async function readSweeperHeartbeat(): Promise<SweeperHeartbeat | null> {
  const sql = db();
  try {
    const [row] = await sql<Array<{ last_success_at: Date | string | null; recovery_policy: string | null }>>`
      select last_success_at, recovery_policy from studio_sweeper_health order by id limit 1
    `;
    if (!row?.last_success_at) return null;
    const checkedAt = row.last_success_at instanceof Date
      ? row.last_success_at.toISOString()
      : String(row.last_success_at);
    return { checkedAt, recoveryPolicy: row.recovery_policy };
  } catch {
    // 표나 컬럼이 없으면 "회수기가 도는지 모른다" 는 뜻이다. 모르면 열지 않는다.
    return null;
  }
}
