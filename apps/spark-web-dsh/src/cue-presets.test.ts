import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addCueSkillProvider,
  installManagedCuePresets,
  mapSubagentDelegationToOneShot,
  readDshPackageVersion,
  removeDshShellAndJobsRows,
  replaceDshToolFsRow,
  verifyDshPresetSources,
} from "./cue-presets.ts";

const dshPackageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "presets",
  "upstream-package",
);
const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../vendor/cue/skills");

describe("managed Cue-first presets", () => {
  it("verifies the installed package metadata and committed upstream digests", () => {
    expect(readDshPackageVersion(dshPackageDir)).toBe("fixture-release");
    expect(verifyDshPresetSources(dshPackageDir)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects invalid package metadata without duplicating the supported release", () => {
    const packageDir = mkdtempSync(join(tmpdir(), "spark-cue-dsh-version-"));
    try {
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@deepseek-ai/not-dsh", version: "fixture-release" }),
      );
      expect(() => readDshPackageVersion(packageDir)).toThrow(
        /expected installed @deepseek-ai\/dsh package metadata/u,
      );
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@deepseek-ai/dsh", version: "" }),
      );
      expect(() => readDshPackageVersion(packageDir)).toThrow(/package has no version/u);
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });

  it("rejects a missing product-bundled cue Skill", () => {
    const home = mkdtempSync(join(tmpdir(), "cue-missing-skill-"));
    try {
      const missingSkillDir = join(home, "missing");
      expect(() => installManagedCuePresets(home, dshPackageDir, missingSkillDir)).toThrow(
        /bundled cue Skill is not a regular file/u,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("installs deterministic presets, is idempotent, and removes DSH execution tools", () => {
    const home = mkdtempSync(join(tmpdir(), "spark-cue-presets-"));
    const options = {
      toolFsPluginSpecifier: "../../profiles/web/plugins/spark-files/index.mjs",
    };
    try {
      const first = installManagedCuePresets(home, dshPackageDir, skillDir, options);
      expect(first.map((item) => item.updated)).toEqual([true, true]);
      for (const item of first) {
        const composition = readFileSync(join(item.path, "agent.cordis.yml"), "utf8");
        expect(composition).not.toContain("id: tool-bash");
        expect(composition).not.toContain("id: tool-pwsh");
        expect(composition).not.toContain("id: tool-jobs");
        expect(composition).toContain(
          [
            "- id: cue-skill",
            "  name: '@deepseek-ai/dsh-skill-filesystem'",
            "  config:",
            "    providerName: spark-web-dsh",
            "    includeDefaultRoots: false",
            `    bundledSkillDir: ${JSON.stringify(skillDir)}`,
            "    watch: false",
          ].join("\n"),
        );
        expect(composition).not.toContain("name: '@deepseek-ai/dsh-tool-fs'");
        expect(composition).toContain('name: "../../profiles/web/plugins/spark-files/index.mjs"');
        expect(composition).toContain("toolName: subagent\n        backgroundMode: one-shot");
        expect(composition).toContain("toolName: subagent_fork\n        backgroundMode: one-shot");
        expect(composition).not.toContain(
          "toolName: subagent\n        backgroundMode: continuable",
        );
        expect(readFileSync(join(item.path, ".spark-managed.json"), "utf8")).toContain(
          "@zendev-lab/spark-web-dsh",
        );
        expect(readFileSync(join(item.path, ".spark-managed.json"), "utf8")).toContain(
          '"dshVersion": "fixture-release"',
        );
      }
      expect(
        installManagedCuePresets(home, dshPackageDir, skillDir, options).map(
          (item) => item.updated,
        ),
      ).toEqual([false, false]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses unmarked and user-modified preset directories", () => {
    const unmarked = mkdtempSync(join(tmpdir(), "spark-cue-unmarked-"));
    const modified = mkdtempSync(join(tmpdir(), "spark-cue-modified-"));
    try {
      mkdirSync(join(unmarked, ".agent-presets", "spark-standard"), { recursive: true });
      expect(() => installManagedCuePresets(unmarked, dshPackageDir, skillDir)).toThrow(
        /refusing to overwrite unmarked preset/u,
      );

      const [standard] = installManagedCuePresets(modified, dshPackageDir, skillDir);
      writeFileSync(join(standard!.path, "preset.yml"), "name: user change\n");
      expect(() => installManagedCuePresets(modified, dshPackageDir, skillDir)).toThrow(
        /refusing to overwrite user-modified managed preset/u,
      );
    } finally {
      rmSync(unmarked, { recursive: true, force: true });
      rmSync(modified, { recursive: true, force: true });
    }
  });

  it("maps official spawn/fork subagent tools onto one-shot", () => {
    expect(
      mapSubagentDelegationToOneShot(
        "        toolName: subagent\n        backgroundMode: continuable\n        toolName: subagent_fork\n        backgroundMode: continuable\n",
      ),
    ).toBe(
      "        toolName: subagent\n        backgroundMode: one-shot\n        toolName: subagent_fork\n        backgroundMode: one-shot\n",
    );
  });

  it("removes complete top-level rows without aliases", () => {
    expect(
      removeDshShellAndJobsRows(
        "- id: keep\n  name: keep\n- id: tool-bash\n  name: bash\n- id: next\n  name: next\n",
      ),
    ).toBe("- id: keep\n  name: keep\n- id: next\n  name: next\n");
  });

  it("requires exactly one DSH skill-filesystem row", () => {
    expect(() => addCueSkillProvider("- id: keep\n", skillDir)).toThrow(
      /expected one DSH skill-filesystem row/u,
    );
  });

  it("safely adopts unmodified presets from the former adapter owner", () => {
    const home = mkdtempSync(join(tmpdir(), "spark-cue-legacy-presets-"));
    try {
      const installed = installManagedCuePresets(home, dshPackageDir, skillDir);
      for (const preset of installed) {
        const markerPath = join(preset.path, ".spark-managed.json");
        const marker = readFileSync(markerPath, "utf8").replace(
          "@zendev-lab/spark-web-dsh",
          "@zendev-lab/dsh-tool-cue",
        );
        writeFileSync(markerPath, marker);
      }
      expect(
        installManagedCuePresets(home, dshPackageDir, skillDir).map((item) => item.updated),
      ).toEqual([true, true]);
      for (const preset of installed) {
        expect(readFileSync(join(preset.path, ".spark-managed.json"), "utf8")).toContain(
          "@zendev-lab/spark-web-dsh",
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("replaces exactly one upstream file-tool row", () => {
    expect(
      replaceDshToolFsRow(
        "- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n",
        "./spark-files.mjs",
      ),
    ).toBe('- id: tool-fs\n  name: "./spark-files.mjs"\n');
    expect(() => replaceDshToolFsRow("- id: other\n  name: other\n", "./plugin.mjs")).toThrow(
      /expected one upstream dsh-tool-fs row/u,
    );
  });
});
