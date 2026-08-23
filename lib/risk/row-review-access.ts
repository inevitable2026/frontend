export type RiskRowReviewAccess = {
  actor: "local-console";
  siteIds: Set<string>;
};

export class RiskRowReviewAccessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskRowReviewAccessUnavailableError";
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
        "로그인 기반 검토 권한이 없어 production 행 검토는 기본 비활성입니다. 배포 설정이 RISK_ROW_REVIEW_PRODUCTION_ENABLED=true 로 명시해야 열립니다.",
      );
    }
  } else if (env.RISK_ROW_REVIEW_LOCAL_ENABLED !== "true") {
    throw new RiskRowReviewAccessUnavailableError("localhost 행 검토를 쓰려면 RISK_ROW_REVIEW_LOCAL_ENABLED=true 가 필요합니다.");
  }
  if (env.BOARD_STORE !== "pg") {
    throw new RiskRowReviewAccessUnavailableError("행 검토를 쓰려면 보드와 검토가 같은 Postgres 를 보도록 BOARD_STORE=pg 가 필요합니다.");
  }
  const siteIds = new Set(
    (env.CONSOLE_SITE_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => UUID.test(value)),
  );
  if (siteIds.size === 0) {
    throw new RiskRowReviewAccessUnavailableError("CONSOLE_SITE_IDS 에 허용할 현장 UUID가 필요합니다.");
  }
  return { actor: "local-console", siteIds };
}
