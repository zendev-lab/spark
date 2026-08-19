import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSupportedDshPackage,
  installManagedCuePresets,
  removeDshShellAndJobsRows,
  verifyDshPresetSources,
} from "./presets.ts";

const dshPackageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "presets",
  "upstream-package",
);

describe("managed rc.7 Cue-first presets", () => {
  it("verifies the installed package metadata and committed upstream digests", () => {
    expect(() => assertSupportedDshPackage(dshPackageDir)).not.toThrow();
    expect(verifyDshPresetSources(dshPackageDir)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects every DSH version except rc.7 before preset generation", () => {
    const packageDir = mkdtempSync(join(tmpdir(), "spark-cue-dsh-version-"));
    try {
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.8" }),
      );
      expect(() => assertSupportedDshPackage(packageDir)).toThrow(
        /supports exactly @deepseek-ai\/dsh@0\.1\.0-rc\.7/u,
      );
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });

  it("installs deterministic presets, is idempotent, and removes DSH execution tools", () => {
    const home = mkdtempSync(join(tmpdir(), "spark-cue-presets-"));
    try {
      const first = installManagedCuePresets(home, dshPackageDir);
      expect(first.map((item) => item.updated)).toEqual([true, true]);
      for (const item of first) {
        const composition = readFileSync(join(item.path, "agent.cordis.yml"), "utf8");
        expect(composition).not.toContain("id: tool-bash");
        expect(composition).not.toContain("id: tool-pwsh");
        expect(composition).not.toContain("id: tool-jobs");
        expect(readFileSync(join(item.path, ".spark-managed.json"), "utf8")).toContain(
          "@zendev-lab/dsh-tool-cue",
        );
      }
      expect(installManagedCuePresets(home, dshPackageDir).map((item) => item.updated)).toEqual([
        false,
        false,
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses unmarked and user-modified preset directories", () => {
    const unmarked = mkdtempSync(join(tmpdir(), "spark-cue-unmarked-"));
    const modified = mkdtempSync(join(tmpdir(), "spark-cue-modified-"));
    try {
      mkdirSync(join(unmarked, ".agent-presets", "spark-standard"), { recursive: true });
      expect(() => installManagedCuePresets(unmarked, dshPackageDir)).toThrow(
        /refusing to overwrite unmarked preset/u,
      );

      const [standard] = installManagedCuePresets(modified, dshPackageDir);
      writeFileSync(join(standard!.path, "preset.yml"), "name: user change\n");
      expect(() => installManagedCuePresets(modified, dshPackageDir)).toThrow(
        /refusing to overwrite user-modified managed preset/u,
      );
    } finally {
      rmSync(unmarked, { recursive: true, force: true });
      rmSync(modified, { recursive: true, force: true });
    }
  });

  it("removes complete top-level rows without aliases", () => {
    expect(
      removeDshShellAndJobsRows(
        "- id: keep\n  name: keep\n- id: tool-bash\n  name: bash\n- id: next\n  name: next\n",
      ),
    ).toBe("- id: keep\n  name: keep\n- id: next\n  name: next\n");
  });
});
