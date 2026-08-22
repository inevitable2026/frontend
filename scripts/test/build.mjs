import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outputDir = resolve("tmp/test-dist");
rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });

execFileSync("npx", ["tsc", "--project", "tests/tsconfig.json"], { stdio: "inherit" });
writeFileSync(resolve(outputDir, "package.json"), '{"type":"module"}\n');
