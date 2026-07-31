import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const repoRoot = resolve(webRoot, "../..");

const removedSparkCoordinationFacades = [
  "agents-product.ts",
  "artifact-cache.ts",
  "command-submission.ts",
  "events.ts",
  "liveness.ts",
  "project-cockpit.ts",
  "projection-services.ts",
  "runtime-registration.ts",
  "runtime-ws.ts",
  "session-activity.ts",
];

describe("package boundaries", () => {
  it("does not keep empty spark-coordination facade re-exports under lib/server", () => {
    for (const facade of removedSparkCoordinationFacades) {
      expect(existsSync(join(webRoot, "src/lib/server", facade))).toBe(false);
    }
  });

  it("keeps SvelteKit page loads behind spark-coordination query APIs", () => {
    const pageServers = collectSourceFiles(join(webRoot, "src/routes")).filter((file) =>
      file.endsWith("+page.server.ts"),
    );
    const directSql = pageServers.filter((file) =>
      /\.prepare\s*\(/u.test(readFileSync(file, "utf8")),
    );
    expect(directSql).toEqual([]);
  });

  it("keeps Cockpit UI outside lib/server from importing spark-cockpit-db directly", () => {
    const uiFiles = collectSourceFiles(join(webRoot, "src")).filter(
      (file) => !file.includes("/src/lib/server/"),
    );
    const violations = uiFiles.filter((file) =>
      /from\s+["']@zendev-lab\/spark-cockpit-db/u.test(readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("keeps Cockpit source from bypassing daemon/protocol workspace artifact access", () => {
    const productionFiles = collectSourceFiles(join(webRoot, "src")).filter(
      (file) => !file.endsWith(".test.ts"),
    );
    const violations = productionFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes('resolveSparkPaths({ app: "daemon" })') ||
        source.includes('".spark", "artifacts"') ||
        source.includes("'.spark', 'artifacts'") ||
        source.includes(".spark/artifacts")
      );
    });
    expect(violations).toEqual([]);
  });

  it("keeps artifact fallback out of daemon/local workspace files", () => {
    const sourceFile = ts.createSourceFile(
      "agents-product.ts",
      readFileSync(
        join(repoRoot, "packages/spark-cockpit-coordination/src/agents-product.ts"),
        "utf8",
      ),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const structure = collectTypeScriptStructure(sourceFile);
    expect(structure.calls).not.toContain("resolveSparkPaths");
    expect(structure.calls).not.toContain("readFileSync");
    expect(structure.constructors).not.toContain("DatabaseSync");
    expect(structure.stringLiterals.some((value) => value.includes(".spark"))).toBe(false);
  });

  it("keeps the artifacts route focused on the read-only artifact library", () => {
    const artifactsRoute = join(webRoot, "src/routes/(workbench)/[workspaceId]/artifacts");
    const pageServer = ts.createSourceFile(
      "+page.server.ts",
      readFileSync(join(artifactsRoute, "+page.server.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const serverStructure = collectTypeScriptStructure(pageServer);
    const pageStructure = collectSvelteNodeNames(
      parse(readFileSync(join(artifactsRoute, "+page.svelte"), "utf8"), {
        modern: true,
        filename: "+page.svelte",
      }),
    );

    expect(serverStructure.imports).toContain("loadArtifactsPage");
    expect(serverStructure.variables).toContain("load");
    expect(serverStructure.variables).not.toContain("actions");
    expect(serverStructure.stringLiterals).not.toContain("task.start.request");
    expect(serverStructure.stringLiterals).not.toContain("invocation.cancel.request");
    expect(pageStructure).not.toContain("WorkspaceAgentProduct");
  });

  it("does not import Spark daemon internals from the cockpit app", () => {
    const sourceFiles = collectSourceFiles(join(webRoot, "src"));
    const violations = sourceFiles.filter((file) =>
      /from\s+["']@zendev-lab\/spark-daemon(?:\/|["'])/u.test(readFileSync(file, "utf8")),
    );

    expect(violations).toEqual([]);
  });

  it("keeps client session mutations behind daemon local RPC", () => {
    const clientRoots = [
      join(webRoot, "src"),
      join(repoRoot, "packages/spark-cockpit-coordination/src"),
    ];
    const violations = clientRoots.flatMap((root) =>
      collectSourceFiles(root)
        .filter((file) => !file.endsWith(".test.ts"))
        .filter((file) => {
          const source = readFileSync(file, "utf8");
          return (
            source.includes("@zendev-lab/spark-session") ||
            source.includes("session-registry/v1") ||
            /(?:writeFile[\s\S]*session-registry|session-registry[\s\S]*writeFile)/u.test(source)
          );
        }),
    );

    expect(violations).toEqual([]);
  });
});

function collectTypeScriptStructure(sourceFile: ts.SourceFile): {
  calls: string[];
  constructors: string[];
  imports: string[];
  stringLiterals: string[];
  variables: string[];
} {
  const calls = new Set<string>();
  const constructors = new Set<string>();
  const imports = new Set<string>();
  const stringLiterals = new Set<string>();
  const variables = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.add(node.expression.getText(sourceFile));
    if (ts.isNewExpression(node)) constructors.add(node.expression.getText(sourceFile));
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      stringLiterals.add(node.text);
    }
    if (ts.isImportDeclaration(node) && node.importClause) {
      if (node.importClause.name) imports.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imports.add(element.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.add(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return {
    calls: [...calls],
    constructors: [...constructors],
    imports: [...imports],
    stringLiterals: [...stringLiterals],
    variables: [...variables],
  };
}

function collectSvelteNodeNames(root: unknown): string[] {
  const names = new Set<string>();
  const seen = new Set<object>();
  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") names.add(record.name);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(root);
  return [...names];
}

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (/\.(svelte|ts)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}
