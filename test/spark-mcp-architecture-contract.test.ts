import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const root = resolve(".");
const retiredIdentity = "spark-mcp-spike";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<string, unknown>;
}

function workspacePatterns(source: string): string[] {
  return [...source.matchAll(/^\s*-\s+["']([^"']+)["']\s*$/gmu)].map((match) => match[1]!);
}

test("supported MCP adapter is registered and the sealed spike is fully retired", () => {
  const manifest = readJson("packages/spark-mcp/package.json") as {
    name?: string;
    private?: boolean;
    bin?: Record<string, string>;
  };
  const architecture = readJson("architecture/packages.json") as {
    packages?: Record<
      string,
      { path?: string; layer?: string; owner?: string; stability?: string; stateWriter?: string }
    >;
  };
  const workspaceSource = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
  const patterns = workspacePatterns(workspaceSource);
  const declaration = architecture.packages?.["@zendev-lab/spark-mcp"];

  assert.equal(manifest.name, "@zendev-lab/spark-mcp");
  assert.equal(manifest.private, true);
  assert.equal(manifest.bin?.["spark-mcp"], "./scripts/stdio.ts");
  assert.deepEqual(declaration, {
    path: "packages/spark-mcp",
    layer: "adapter",
    owner: "mcp",
    stability: "supported",
    stateWriter: "none",
  });
  assert.equal(patterns.includes("packages/*"), true);
  assert.equal(
    patterns.some((pattern) => pattern.includes(retiredIdentity)),
    false,
  );

  assert.equal(existsSync(resolve(root, "packages", retiredIdentity)), false);
  assert.equal(existsSync(resolve(root, ".eslintignore")), false);
  for (const path of [
    "docs/specs/package-architecture.md",
    "scripts/sync-workspace-versions.mjs",
  ]) {
    assert.equal(readFileSync(resolve(root, path), "utf8").includes(retiredIdentity), false, path);
  }
});
