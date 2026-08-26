import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cueSkillsRoot } from "@zendev-lab/cue";
import {
  installManagedCuePresets,
  readDshPackageVersion,
  retireLegacyManagedCuePresets,
  sparkPresetSourceRoot,
  verifySparkPresetSources,
} from "./cue-presets.ts";

const dshPackageDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "presets",
  "upstream-package",
);
const skillDir = cueSkillsRoot;

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "spark-web-presets-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("packaged preset sources", () => {
  it("verify the versioned preset root structurally", () => {
    expect(verifySparkPresetSources()).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reject a preset root with extra or missing presets", () => {
    withTempHome((home) => {
      const root = join(home, "agent-presets");
      mkdirSync(root, { recursive: true });
      expect(() => verifySparkPresetSources(root)).toThrow(/must hold exactly/u);
      cpSync(sparkPresetSourceRoot(), root, { recursive: true });
      mkdirSync(join(root, "extra"));
      expect(() => verifySparkPresetSources(root)).toThrow(/must hold exactly/u);
    });
  });

  it("reject compositions that drift from the Cue-first contract", () => {
    withTempHome((home) => {
      const root = join(home, "agent-presets");
      cpSync(sparkPresetSourceRoot(), root, { recursive: true });
      const composition = join(root, "spark-standard", "agent.cordis.yml");
      const original = readFileSync(composition, "utf8");

      writeFileSync(
        composition,
        `${original}- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n`,
      );
      expect(() => verifySparkPresetSources(root)).toThrow(/must not mount id: tool-bash/u);

      writeFileSync(
        composition,
        original.replace("backgroundMode: one-shot", "backgroundMode: continuable"),
      );
      expect(() => verifySparkPresetSources(root)).toThrow(/one-shot/u);

      writeFileSync(
        composition,
        original.replace('bundledSkillDir: ""', "bundledSkillDir: /tmp/cue"),
      );
      expect(() => verifySparkPresetSources(root)).toThrow(/exactly one cue Skill placeholder/u);

      writeFileSync(
        composition,
        original.replace(
          'name: "@deepseek-ai/dsh-tool-todo"',
          'name: "@deepseek-ai/dsh-tool-invented"',
        ),
      );
      expect(() => verifySparkPresetSources(root)).toThrow(/never reference/u);

      writeFileSync(composition, original);
      expect(verifySparkPresetSources(root)).toMatch(/^[a-f0-9]{64}$/u);
    });
  });
});

describe("managed Cue-first presets", () => {
  it("verifies the installed package metadata", () => {
    expect(readDshPackageVersion(dshPackageDir)).toBe("fixture-release");
  });

  it("rejects invalid package metadata without duplicating the supported release", () => {
    const packageDir = mkdtempSync(join(tmpdir(), "dsh-cue-dsh-version-"));
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
    withTempHome((home) => {
      expect(() => installManagedCuePresets(home, dshPackageDir, join(home, "missing"))).toThrow(
        /bundled cue Skill is not a regular file/u,
      );
    });
  });

  it("installs the packaged presets with the cue Skill path filled in, idempotently", () => {
    withTempHome((home) => {
      const first = installManagedCuePresets(home, dshPackageDir, skillDir);
      expect(first.map((item) => item.id)).toEqual(["spark-standard", "spark-ptc"]);
      expect(first.map((item) => item.updated)).toEqual([true, true]);
      for (const item of first) {
        const composition = readFileSync(join(item.path, "agent.cordis.yml"), "utf8");
        expect(composition).not.toContain("id: tool-bash");
        expect(composition).not.toContain("id: tool-pwsh");
        expect(composition).not.toContain("id: tool-jobs");
        expect(composition).not.toContain('bundledSkillDir: ""');
        expect(composition).toContain(
          [
            "- id: cue-skill",
            '  name: "@deepseek-ai/dsh-skill-filesystem"',
            "  config:",
            "    providerName: spark-web-dsh",
            "    includeDefaultRoots: false",
            `    bundledSkillDir: ${JSON.stringify(skillDir)}`,
            "    watch: false",
          ].join("\n"),
        );
        expect(composition).toContain('name: "../../profiles/web/plugins/spark-files/index.mjs"');
        expect(composition).toContain("toolName: subagent\n        backgroundMode: one-shot");
        expect(composition).toContain("toolName: subagent_fork\n        backgroundMode: one-shot");
        expect(composition).not.toContain("backgroundMode: continuable");
        const marker = readFileSync(join(item.path, ".spark-managed.json"), "utf8");
        expect(marker).toContain("@zendev-lab/spark-web-dsh");
        expect(marker).toContain('"dshVersion": "fixture-release"');
      }
      expect(readFileSync(join(first[0]!.path, "preset.yml"), "utf8")).toContain(
        "name: Spark Standard",
      );
      expect(readFileSync(join(first[1]!.path, "preset.yml"), "utf8")).toContain("name: Spark PTC");
      // Only the PTC preset composes the Code Mode presentation row.
      expect(readFileSync(join(first[0]!.path, "agent.cordis.yml"), "utf8")).not.toContain(
        "id: tool-presentation",
      );
      expect(readFileSync(join(first[1]!.path, "agent.cordis.yml"), "utf8")).toContain(
        "id: tool-presentation",
      );
      expect(
        installManagedCuePresets(home, dshPackageDir, skillDir).map((item) => item.updated),
      ).toEqual([false, false]);
    });
  });

  it("refuses unmarked and user-modified preset directories", () => {
    const unmarked = mkdtempSync(join(tmpdir(), "dsh-cue-unmarked-"));
    const modified = mkdtempSync(join(tmpdir(), "dsh-cue-modified-"));
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

  it("safely adopts unmodified presets from the former adapter owner", () => {
    withTempHome((home) => {
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
    });
  });
});

describe("retireLegacyManagedCuePresets", () => {
  /** Recreate a retired-id install by renaming a freshly installed managed preset. */
  function plantLegacyPreset(home: string, legacyId: string): string {
    const [standard] = installManagedCuePresets(home, dshPackageDir, skillDir);
    const legacyPath = join(home, ".agent-presets", legacyId);
    renameSync(standard!.path, legacyPath);
    return legacyPath;
  }

  it("removes a marker-owned, untouched retired preset and leaves live presets alone", () => {
    withTempHome((home) => {
      plantLegacyPreset(home, "spark-code");
      const results = retireLegacyManagedCuePresets(home);
      expect(results).toEqual([
        {
          id: "spark-code",
          path: join(home, ".agent-presets", "spark-code"),
          removed: true,
        },
      ]);
      expect(
        installManagedCuePresets(home, dshPackageDir, skillDir).map((item) => item.id),
      ).toEqual(["spark-standard", "spark-ptc"]);
      // Idempotent: nothing left to retire.
      expect(retireLegacyManagedCuePresets(home)).toEqual([]);
    });
  });

  it("keeps unmarked and user-modified retired directories", () => {
    withTempHome((home) => {
      const unmarked = join(home, ".agent-presets", "spark-code");
      mkdirSync(unmarked, { recursive: true });
      const first = retireLegacyManagedCuePresets(home);
      expect(first).toEqual([
        { id: "spark-code", path: unmarked, removed: false, reason: "unmarked" },
      ]);
      rmSync(unmarked, { recursive: true, force: true });

      const legacyPath = plantLegacyPreset(home, "spark-code");
      writeFileSync(join(legacyPath, "preset.yml"), "name: user change\n");
      const second = retireLegacyManagedCuePresets(home);
      expect(second).toEqual([
        { id: "spark-code", path: legacyPath, removed: false, reason: "modified" },
      ]);
      expect(readFileSync(join(legacyPath, "preset.yml"), "utf8")).toBe("name: user change\n");
    });
  });

  it("keeps retired ids that are not plain directories", () => {
    withTempHome((home) => {
      const filePath = join(home, ".agent-presets", "spark-code");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "not a directory\n");
      expect(retireLegacyManagedCuePresets(home)).toEqual([
        { id: "spark-code", path: filePath, removed: false, reason: "not-a-directory" },
      ]);
    });
  });

  it("removes a retired preset owned by the legacy adapter marker", () => {
    withTempHome((home) => {
      const legacyPath = plantLegacyPreset(home, "spark-code");
      const markerPath = join(legacyPath, ".spark-managed.json");
      writeFileSync(
        markerPath,
        readFileSync(markerPath, "utf8").replace(
          "@zendev-lab/spark-web-dsh",
          "@zendev-lab/dsh-tool-cue",
        ),
      );
      expect(retireLegacyManagedCuePresets(home).map((item) => item.removed)).toEqual([true]);
    });
  });
});
