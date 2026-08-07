import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The executable architecture script intentionally has no declaration surface.
import * as architectureRatchets from "../scripts/check-architecture-ratchets.mjs";

const {
  findLegacyDaemonClientViolations,
  findUnsafePiCompatibilityImports,
  findUnsafePiCompatibilityImportsInGraph,
  isLegacyDaemonClientBoundaryExempt,
  presentationDependencyDeclarations,
  workspaceImports,
} = architectureRatchets;

const architectureGovernanceFixtureSha256 =
  "71ad59c4019e784f59da02d73c0b378f2a0605cef2545f74259830d26c22c4a9";
const requiredInventoryFields = ["layer", "owner", "stability", "stateWriter"] as const;
const invalidInventoryCases = [
  { field: "layer", value: "invalid" },
  { field: "owner", value: "   " },
  { field: "stability", value: "invalid" },
  { field: "stateWriter", value: "invalid" },
  { field: "distribution", value: "invalid" },
] as const;
const removedCheckerRuleIds = [
  "layer-enum",
  "owner-nonempty",
  "stability-enum",
  "state-writer-enum",
  "distribution-enum",
  "mutation-script-ownership",
] as const;

interface ArchitectureInventory {
  packages: Record<string, Record<string, unknown>>;
}

interface GovernanceFixture {
  governanceTools: Array<{
    name: string;
    concerns: string[];
    primarySource: string;
  }>;
  retainedSparkChecks: string[];
  removedCheckerRules: Array<{
    id: string;
    removedSource: string;
    rule: string;
    authority: string;
    independentDefect: string;
  }>;
  scriptsInventory: Array<{
    path: string;
    lineCount: number;
    domainOwner: string;
    callers: string[];
    replacementAssessment: string;
  }>;
  removedScriptSourceLines: number;
  removedScriptCount: number;
  removedScripts: string[];
  changeBase: string;
  changeHead: string;
  changedFiles: string[];
  remainingCandidates: Array<{ path: string; assessment: string; blocker: string }>;
  blockers: string[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function workspaceManifestPaths(): Promise<string[]> {
  const manifests: string[] = [];
  for (const root of ["apps", "packages"]) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(join(root, entry.name, "package.json"), "utf8");
        manifests.push(join(root, entry.name, "package.json"));
      } catch {
        // Non-workspace directories are outside the active package inventory.
      }
    }
  }
  return manifests.sort();
}

function gitCommitExists(sha: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      encoding: "utf8",
      stdio: "ignore",
    }).status === 0
  );
}

function shouldCrossCheckHistoricalGitObjects(
  base: string,
  head: string,
  commitExists: (sha: string) => boolean = gitCommitExists,
): boolean {
  return commitExists(base) && commitExists(head);
}

function lineCount(source: string): number {
  return source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

describe("workspace dependency declaration ratchet", () => {
  it("extracts root package names from static and dynamic workspace imports", () => {
    expect(
      workspaceImports(`
        import { value } from "@zendev-lab/spark-memory";
        import("@zendev-lab/spark-protocol/session");
        export { helper } from "@zendev-lab/spark-memory/helpers";
      `),
    ).toEqual(new Set(["@zendev-lab/spark-memory", "@zendev-lab/spark-protocol"]));
  });
});

describe("architecture governance contracts", () => {
  it("uses the sealed fixture when a shallow checkout omits historical Git objects", () => {
    const observed: string[] = [];
    expect(
      shouldCrossCheckHistoricalGitObjects("base", "head", (sha) => {
        observed.push(sha);
        return false;
      }),
    ).toBe(false);
    expect(observed).toEqual(["base"]);
  });

  it("requires every active workspace declaration to carry every ownership field", async () => {
    const inventory = await readJson<ArchitectureInventory>("architecture/packages.json");
    const workspacePaths = await workspaceManifestPaths();
    expect(workspacePaths).not.toHaveLength(0);
    for (const workspacePath of workspacePaths) {
      const manifest = await readJson<{ name: string }>(workspacePath);
      const declaration = inventory.packages[manifest.name];
      expect(declaration, manifest.name).toBeDefined();
      for (const field of requiredInventoryFields) {
        expect(declaration?.[field], `${manifest.name}.${field}`).toBeTruthy();
      }
    }
  });

  it.each(requiredInventoryFields)("rejects an independently missing %s field", async (field) => {
    const root = await mkdtemp(join(tmpdir(), `spark-architecture-${field}-`));
    try {
      const source = await readJson<ArchitectureInventory>("architecture/packages.json");
      const declaration = { ...source.packages["@zendev-lab/spark-cli"] };
      delete declaration[field];
      await writeFile(
        join(root, "packages.json"),
        JSON.stringify({ ...source, packages: { "@zendev-lab/spark-invalid": declaration } }),
      );
      expect(() =>
        execFileSync(
          "pnpm",
          [
            "exec",
            "ajv",
            "validate",
            "--spec=draft2020",
            "--strict=true",
            "--all-errors",
            "--errors=text",
            "-s",
            "architecture/packages.schema.json",
            "-d",
            join(root, "packages.json"),
          ],
          { cwd: ".", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow(new RegExp(field));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(invalidInventoryCases)(
    "rejects an independently invalid $field value",
    async ({ field, value }) => {
      const root = await mkdtemp(join(tmpdir(), `spark-architecture-invalid-${field}-`));
      try {
        const source = await readJson<ArchitectureInventory>("architecture/packages.json");
        const declaration = {
          ...source.packages["@zendev-lab/spark-cli"],
          [field]: value,
        };
        await writeFile(
          join(root, "packages.json"),
          JSON.stringify({ ...source, packages: { "@zendev-lab/spark-invalid": declaration } }),
        );
        expect(() =>
          execFileSync(
            "pnpm",
            [
              "exec",
              "ajv",
              "validate",
              "--spec=draft2020",
              "--strict=true",
              "--all-errors",
              "--errors=text",
              "-s",
              "architecture/packages.schema.json",
              "-d",
              join(root, "packages.json"),
            ],
            { cwd: ".", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          ),
        ).toThrow(new RegExp(field));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("checks the governance documentation against the checked tool contract", async () => {
    const governance = await readJson<GovernanceFixture>(
      "test/fixtures/architecture-governance.json",
    );
    const docs = await readFile("docs/specs/package-architecture.md", "utf8");
    for (const tool of governance.governanceTools) {
      expect(docs).toContain(tool.name);
      expect(docs).toContain(tool.primarySource);
      for (const concern of tool.concerns) expect(docs).toContain(concern);
    }
    for (const retained of governance.retainedSparkChecks) expect(docs).toContain(retained);
  });

  it("checks the removed generic-rule mapping and exact script inventory", async () => {
    const fixtureSource = await readFile("test/fixtures/architecture-governance.json", "utf8");
    expect(createHash("sha256").update(fixtureSource).digest("hex")).toBe(
      architectureGovernanceFixtureSha256,
    );
    const governance = JSON.parse(fixtureSource) as GovernanceFixture;
    expect(governance.removedCheckerRules.map((rule) => rule.id)).toEqual([
      ...removedCheckerRuleIds,
    ]);
    for (const rule of governance.removedCheckerRules) {
      expect(rule.removedSource).toContain("scripts/check-architecture-ratchets.mjs");
      expect(rule.rule).toBeTruthy();
      expect(rule.authority).toBeTruthy();
      expect(rule.independentDefect).toMatch(/^test\//u);
      await expect(readFile(rule.independentDefect.split(" ")[0]!, "utf8")).resolves.toBeTruthy();
    }
    expect(governance.removedScriptSourceLines).toBe(3150);
    expect(governance.removedScriptCount).toBe(governance.removedScripts.length);
    if (shouldCrossCheckHistoricalGitObjects(governance.changeBase, governance.changeHead)) {
      expect(
        execFileSync(
          "git",
          ["diff", "--name-only", `${governance.changeBase}..${governance.changeHead}`],
          {
            encoding: "utf8",
          },
        )
          .trim()
          .split("\n")
          .filter(Boolean),
      ).toEqual(governance.changedFiles);
      const removedScriptStatus = execFileSync(
        "git",
        [
          "diff",
          "--name-status",
          `${governance.changeBase}..${governance.changeHead}`,
          "--",
          "scripts",
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t"))
        .filter(([status]) => status === "D")
        .map(([, path]) => path!);
      expect(removedScriptStatus).toEqual(governance.removedScripts);
      const removedSourceLines = governance.removedScripts.reduce((total, path) => {
        const source = execFileSync("git", ["show", `${governance.changeBase}:${path}`], {
          encoding: "utf8",
        });
        return total + lineCount(source);
      }, 0);
      expect(removedSourceLines).toBe(governance.removedScriptSourceLines);
    }
    const actualScripts = (await readdir("scripts", { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => `scripts/${entry.name}`)
      .sort();
    expect(actualScripts).toEqual(governance.scriptsInventory.map((entry) => entry.path).sort());
    expect(governance.removedScripts).toHaveLength(18);
    expect(governance.remainingCandidates).toHaveLength(1);
    expect(governance.blockers).toHaveLength(2);
    for (const entry of governance.scriptsInventory) {
      expect(entry.path).toMatch(/^scripts\//u);
      const source = await readFile(entry.path, "utf8");
      expect(lineCount(source), `${entry.path} line count`).toBe(entry.lineCount);
      expect(entry.domainOwner).toBeTruthy();
      expect(entry.callers.length).toBeGreaterThan(0);
      expect(entry.replacementAssessment).toBeTruthy();
      for (const caller of entry.callers) {
        if (caller === "operator/manual entrypoint") continue;
        const callerSource = await readFile(caller, "utf8");
        const callerToken = entry.path.endsWith(".d.mts")
          ? basename(entry.path, ".d.mts")
          : basename(entry.path);
        expect(callerSource, `${caller} must call or type ${entry.path}`).toContain(callerToken);
      }
    }
  });
});

describe("presentation dependency manifest ownership", () => {
  it("allows the UI owner and rejects every dependency field elsewhere", () => {
    const manifest = {
      dependencies: { "@lucide/svelte": "catalog:" },
      devDependencies: { "bits-ui": "catalog:" },
      peerDependencies: { "svelte-streamdown": "catalog:" },
    };
    expect(presentationDependencyDeclarations("packages/spark-ui", manifest)).toEqual([]);
    expect(presentationDependencyDeclarations("apps/example", manifest)).toEqual([
      "@lucide/svelte",
      "bits-ui",
      "svelte-streamdown",
    ]);
  });
});

describe("legacy daemon client architecture ratchet", () => {
  it("rejects the compatibility subpath and legacy request symbols", () => {
    expect(
      findLegacyDaemonClientViolations(`
        import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-daemon-client/local-rpc";
        await requestSparkDaemonLocalRpc("daemon.status", {});
      `),
    ).toEqual(["legacy local-rpc subpath import", "legacy request symbol"]);
    expect(
      findLegacyDaemonClientViolations(
        `await requestSparkDaemonLocalRpcWire({ id: "1", method: "daemon.status" });`,
      ),
    ).toEqual(["legacy request symbol"]);
  });

  it("allows the typed facade, comments, and string data", () => {
    expect(
      findLegacyDaemonClientViolations(`
        import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
        // requestSparkDaemonLocalRpc is a retired compatibility symbol.
        const migrationNote = "requestSparkDaemonLocalRpcWire";
        await requestSparkDaemon("daemon.status", {});
      `),
    ).toEqual([]);
  });

  it("exempts only tests, fixtures, and the two compatibility implementation files", () => {
    for (const path of [
      "apps/example/src/__fixtures__/legacy.ts",
      "apps/example/src/legacy.fixture.ts",
      "apps/example/src/legacy.test.ts",
      "packages/spark-daemon-client/src/daemon-client.ts",
      "packages/spark-daemon-client/src/daemon-local-rpc.ts",
    ]) {
      expect(isLegacyDaemonClientBoundaryExempt(path), path).toBe(true);
    }
    for (const path of [
      "apps/spark-daemon/src/local-rpc/transport.ts",
      "packages/spark-daemon-client/src/daemon-local-rpc-orpc.ts",
      "packages/spark-session/src/action-tool.ts",
    ]) {
      expect(isLegacyDaemonClientBoundaryExempt(path), path).toBe(false);
    }
    expect(
      findLegacyDaemonClientViolations(`
        export function handleLocalRpcLine(line: string) {
          return dispatchLegacyEnvelope(JSON.parse(line));
        }
      `),
    ).toEqual([]);
  });
});

describe("Pi compatibility extension architecture ratchet", () => {
  it("rejects static and dynamic imports that the compatibility loader rewrites as root-prefixed paths", () => {
    expect(
      findUnsafePiCompatibilityImports(`
        import * as piAi from "@earendil-works/pi-ai";
        import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
        export { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
        import legacyPiAi from "@mariozechner/pi-ai";
        piAi.lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses"));
      `),
    ).toEqual([
      "@earendil-works/pi-ai/api/anthropic-messages.lazy",
      "@earendil-works/pi-ai/api/openai-responses",
      "@earendil-works/pi-ai/providers/openai-codex",
      "@mariozechner/pi-ai",
    ]);
  });

  it("allows only Pi entries virtualized by the production compatibility loader", () => {
    expect(
      findUnsafePiCompatibilityImports(`
        import * as piAi from "@earendil-works/pi-ai";
        import { getModels } from "@earendil-works/pi-ai/compat";
        import type { OAuthProviderInterface } from "@earendil-works/pi-ai/oauth";
        import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
      `),
    ).toEqual([]);
  });

  it("follows workspace package exports from a compatibility entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-pi-workspace-import-ratchet-"));
    try {
      const entry = join(dir, "extension.ts");
      await writeFile(entry, 'import "@zendev-lab/spark-ai/baidu-oneapi-provider";\n', "utf8");

      expect(findUnsafePiCompatibilityImportsInGraph(entry)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("follows relative imports from a compatibility entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-pi-import-ratchet-"));
    try {
      const entry = join(dir, "extension.ts");
      const helper = join(dir, "helper.ts");
      await writeFile(entry, 'import "./helper.ts";\n', "utf8");
      await writeFile(
        helper,
        'await import("@earendil-works/pi-ai/api/openai-responses");\n',
        "utf8",
      );

      expect(findUnsafePiCompatibilityImportsInGraph(entry)).toEqual([
        `${relative(process.cwd(), helper)}: @earendil-works/pi-ai/api/openai-responses`,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
