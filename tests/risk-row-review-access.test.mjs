import assert from "node:assert/strict";
import test from "node:test";

import {
  riskRowReviewAccess,
  RiskRowReviewAccessUnavailableError,
} from "../tmp/test-dist/lib/risk/row-review-access.js";

const siteId = "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae";
test("production review access stays fail-closed without request-bound authentication", () => {
  assert.throws(
    () => riskRowReviewAccess({ NODE_ENV: "production", BOARD_STORE: "pg", RISK_ROW_REVIEW_LOCAL_ENABLED: "true", CONSOLE_SITE_IDS: siteId }),
    RiskRowReviewAccessUnavailableError,
  );
});

test("production opens only with an explicit deployment-level consent variable", () => {
  // 로컬용 opt-in 은 production 을 열지 못한다(위 테스트). 여는 것은 배포 설정의
  // RISK_ROW_REVIEW_PRODUCTION_ENABLED 뿐이고, 그때도 저장소·현장 목록 조건은 그대로다.
  const access = riskRowReviewAccess({
    NODE_ENV: "production", BOARD_STORE: "pg", RISK_ROW_REVIEW_PRODUCTION_ENABLED: "true", CONSOLE_SITE_IDS: siteId,
  });
  assert.equal(access.actor, "local-console");
  assert.deepEqual([...access.siteIds], [siteId]);
  assert.throws(
    () => riskRowReviewAccess({ NODE_ENV: "production", BOARD_STORE: "json", RISK_ROW_REVIEW_PRODUCTION_ENABLED: "true", CONSOLE_SITE_IDS: siteId }),
    RiskRowReviewAccessUnavailableError,
  );
  assert.throws(
    () => riskRowReviewAccess({ NODE_ENV: "production", BOARD_STORE: "pg", RISK_ROW_REVIEW_PRODUCTION_ENABLED: "true", CONSOLE_SITE_IDS: "" }),
    RiskRowReviewAccessUnavailableError,
  );
});

test("localhost review access requires explicit opt-in and a valid site allowlist", () => {
  assert.throws(() => riskRowReviewAccess({ NODE_ENV: "development", CONSOLE_SITE_IDS: siteId }), RiskRowReviewAccessUnavailableError);
  assert.throws(
    () => riskRowReviewAccess({ NODE_ENV: "development", BOARD_STORE: "pg", RISK_ROW_REVIEW_LOCAL_ENABLED: "true", CONSOLE_SITE_IDS: "bad" }),
    RiskRowReviewAccessUnavailableError,
  );
  const access = riskRowReviewAccess({
    NODE_ENV: "development", BOARD_STORE: "pg", RISK_ROW_REVIEW_LOCAL_ENABLED: "true", CONSOLE_SITE_IDS: `${siteId},bad`,
  });
  assert.equal(access.actor, "local-console");
  assert.deepEqual([...access.siteIds], [siteId]);
});

test("local review access requires the authoritative Postgres board", () => {
  assert.throws(
    () => riskRowReviewAccess({
      NODE_ENV: "development", BOARD_STORE: "json", RISK_ROW_REVIEW_LOCAL_ENABLED: "true", CONSOLE_SITE_IDS: siteId,
    }),
    RiskRowReviewAccessUnavailableError,
  );
});
