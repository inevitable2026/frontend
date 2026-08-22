import assert from "node:assert/strict";
import test from "node:test";

import { unquoteEnvValue } from "../scripts/apply-board-migration.mjs";

test("reads unquoted and consistently quoted environment values", () => {
  assert.equal(unquoteEnvValue("postgres://localhost/database"), "postgres://localhost/database");
  assert.equal(unquoteEnvValue("'postgres://localhost/database'"), "postgres://localhost/database");
  assert.equal(unquoteEnvValue('"postgres://localhost/database"'), "postgres://localhost/database");
  assert.equal(unquoteEnvValue("'mismatched\""), "'mismatched\"");
});
