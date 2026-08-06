import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = [
  "packages/spark-artifacts/src/git/review-state.test.ts",
  "packages/spark-artifacts/src/git/review-state.ts",
  "packages/spark-host/src/system-prompt.ts",
  "packages/spark-roles/src/skill-extension.ts",
  "packages/spark-roles/src/spark-skill-agent.test.ts",
];

const formatted = spawnSync("pnpm", ["exec", "vp", "fmt", ...files, "--write"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: "inherit",
});
if (formatted.status !== 0) process.exit(formatted.status ?? 1);

for (const file of files) {
  console.log(`SPARK_FORMAT_FILE_BEGIN ${file}`);
  console.log(readFileSync(file).toString("base64"));
  console.log(`SPARK_FORMAT_FILE_END ${file}`);
}

process.exit(1);
