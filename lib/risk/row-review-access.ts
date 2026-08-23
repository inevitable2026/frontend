export type RiskRowReviewAccess = {
  actor: "local-console";
  siteIds: Set<string>;
};

export class RiskRowReviewAccessUnavailableError extends Error {
  /**
   * `detail` 은 **화면에 나가지 않는다.** 라우트가 `message` 만 응답에 싣는다.
   *
   * 예전에는 「localhost 행 검토를 쓰려면 RISK_ROW_REVIEW_LOCAL_ENABLED=true 가
   * 필요합니다」 가 그대로 서랍에 떴다 — 그것도 두 줄씩. 읽는 사람은 배포 설정을 만질 수
   * 없고, 그렇다고 그 사실을 버리면 담당자가 무엇을 켜야 하는지 알 길이 없다.
   */
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "RiskRowReviewAccessUnavailableError";
    if (detail) console.error("[risk-row-review-access]", detail);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The console has no authenticated user session yet. Persisted safety decisions
 * therefore stay disabled in production by default; localhost needs an explicit
 * opt-in and a server-side site allowlist. The audit actor is deliberately a
 * surface identity, not a fabricated person's name.
 *
 * Production can be opened only by an explicit deployment-level consent
 * (`RISK_ROW_REVIEW_PRODUCTION_ENABLED=true`) — the same two-party shape as the
 * live-readiness receipts: the code alone cannot open it, and neither can a
 * request. Whoever sets that variable owns the decision that an unauthenticated
 * demo console may persist row approvals for the allowlisted sites.
 */
export function riskRowReviewAccess(
  env: NodeJS.ProcessEnv = process.env,
): RiskRowReviewAccess {
  if (env.NODE_ENV === "production") {
    if (env.RISK_ROW_REVIEW_PRODUCTION_ENABLED !== "true") {
      throw new RiskRowReviewAccessUnavailableError(
        "이 서버에서는 행 검토를 저장할 수 없습니다. 시스템 담당자에게 문의해 주세요.",
        "production row review needs RISK_ROW_REVIEW_PRODUCTION_ENABLED=true",
      );
    }
  } else if (env.RISK_ROW_REVIEW_LOCAL_ENABLED !== "true") {
    throw new RiskRowReviewAccessUnavailableError(
      "이 서버에서는 행 검토를 저장할 수 없습니다. 시스템 담당자에게 문의해 주세요.",
      "local row review needs RISK_ROW_REVIEW_LOCAL_ENABLED=true",
    );
  }
  if (env.BOARD_STORE !== "pg") {
    throw new RiskRowReviewAccessUnavailableError(
      "행 검토를 저장할 곳이 준비되지 않았습니다. 시스템 담당자에게 문의해 주세요.",
      "row review needs BOARD_STORE=pg so the board and reviews share one Postgres",
    );
  }
  const siteIds = new Set(
    (env.CONSOLE_SITE_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => UUID.test(value)),
  );
  if (siteIds.size === 0) {
    throw new RiskRowReviewAccessUnavailableError(
      "이 현장에서 행 검토를 저장할 수 있는지 확인되지 않았습니다. 시스템 담당자에게 문의해 주세요.",
      "row review needs CONSOLE_SITE_IDS with at least one site uuid",
    );
  }
  return { actor: "local-console", siteIds };
}
