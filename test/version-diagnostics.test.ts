import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("version diagnostic quality", () => {
  it("does not add unreviewed low-information version errors", () => {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts", "check-version-diagnostics.mjs")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
  });
});
