import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const syncpack = join(process.cwd(), "node_modules/syncpack/index.cjs");

it("keeps the pinned package-consistency tool fail-closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-syncpack-ratchet-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    writeFileSync(
      join(dir, ".syncpackrc.json"),
      JSON.stringify({ source: ["package.json", "packages/*/package.json"] }),
    );
    for (const [name, version] of [
      ["one", "1.0.0"],
      ["two", "2.0.0"],
    ]) {
      const packageDir = join(dir, "packages", name);
      execFileSync(process.execPath, [
        "-e",
        `require("node:fs").mkdirSync(${JSON.stringify(packageDir)}, { recursive: true })`,
      ]);
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: `@spark/${name}`,
          version: "0.0.0",
          devDependencies: { vitest: version },
        }),
      );
    }
    expect(() =>
      execFileSync(
        process.execPath,
        [syncpack, "lint", "--config", join(dir, ".syncpackrc.json"), "--no-ansi"],
        { cwd: dir, stdio: "pipe" },
      ),
    ).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
