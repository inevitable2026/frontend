/**
 * 시연용으로 되풀이할 수 있게 열어 둔 카드.
 *
 * **왜 하나만인가.** 「위험성평가 이슈」 섹션은 한 번 반영하면 사라진다. 고장이 아니다 —
 * `이슈카드인가()`(`lib/board/risk-issue.ts`)가 미확정 카드만 이슈로 보기 때문이고,
 * 반영 버튼이 행 쓰기와 카드 확정을 한 트랜잭션으로 끝낸다. 처리된 일이 「처리할 일」에
 * 남아 있으면 그게 거짓말이다.
 *
 * 그런데 시연은 여러 번 돌려야 한다. 그래서 **이 카드 하나에만** 예외를 둔다. 상수로
 * 박아 두는 이유가 그것이다 — 조건식으로 두면 언젠가 다른 카드도 걸린다.
 *
 * 이 예외는 `demo` 가 켜져 있을 때만 산다(`lib/console-url.ts`). 꺼져 있으면 어떤 카드도
 * 다르게 동작하지 않는다.
 */
export const DEMO_ISSUE_CARD_ID = "card_reeval_crane_radius";

/** 이 카드에 시연 예외를 걸어도 되는가. 플래그와 카드가 **둘 다** 맞아야 한다. */
export function 시연대상인가(demo: boolean, cardId: string | null | undefined): boolean {
  return demo === true && cardId === DEMO_ISSUE_CARD_ID;
}
