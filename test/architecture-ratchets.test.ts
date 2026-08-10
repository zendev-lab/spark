import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The executable architecture script intentionally has no declaration surface.
import * as architectureRatchets from "../scripts/check-architecture-ratchets.mjs";

const {
  findLegacyDaemonClientViolations,
  findUnsafePiCompatibilityImports,
  findUnsafePiCompatibilityImportsInGraph,
  isLegacyDaemonClientBoundaryExempt,
  presentationDependencyDeclarations,
  workspacePackagePolicyViolations,
  workspaceImports,
} = architectureRatchets;

const requiredInventoryFields = ["layer", "owner", "stability", "stateWriter"] as const;
const invalidInventoryCases = [
  { field: "layer", value: "invalid" },
  { field: "owner", value: "   " },
  { field: "stability", value: "invalid" },
  { field: "stateWriter", value: "invalid" },
  { field: "distribution", value: "invalid" },
] as const;
interface ArchitectureInventory {
  packages: Record<string, Record<string, unknown>>;
}

function parseJson<T>(source: string, label: string): T {
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`Unable to parse ${label}`, { cause: error });
  }
}

async function readJson<T>(path: string): Promise<T> {
  return parseJson<T>(await readFile(path, "utf8"), path);
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
});

describe("workspace package validation policy", () => {
  it("rejects hidden package tests and malformed mutation ownership", () => {
    expect(
      workspacePackagePolicyViolations({
        path: "packages/example",
        manifest: {},
        hasTests: true,
        hasStrykerConfig: false,
      }),
    ).toEqual(["must expose package-local tests", "check script must run package-local tests"]);

    expect(
      workspacePackagePolicyViolations({
        path: "packages/example",
        manifest: {
          scripts: { test: "vp test run", check: "vp test run", "test:mutation": "custom" },
          devDependencies: {
            "@stryker-mutator/core": "1.0.0",
            "@stryker-mutator/vitest-runner": "1.0.0",
          },
        },
        hasTests: true,
        hasStrykerConfig: false,
      }),
    ).toEqual([
      "mutation command must be stryker run",
      "mutation core dependency must use catalog:",
      "mutation runner dependency must use catalog:",
      "mutation package must include stryker.config.json",
    ]);
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
