import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkspaceRevision } from "@zendev-lab/spark-lens";
import { expect, test } from "vitest";

import { DaemonLensCodeIntelligence } from "./code-intelligence.ts";
import { DaemonLensCodeIntelligenceStore } from "./code-intelligence-store.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";

test("indexes changed files plus reverse dependencies without stale graph reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lens-intelligence-"));
  await writeFile(
    join(root, "a.ts"),
    'import { beta } from "./b";\nexport function alpha() { return beta(); }\n',
  );
  await writeFile(join(root, "b.ts"), "export function beta() { return 1; }\n");
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const intelligence = new DaemonLensCodeIntelligence(new DaemonLensCodeIntelligenceStore(db));
  const first = revision(root, "revision-1");

  await expect(intelligence.index({ revision: first })).resolves.toMatchObject({
    indexedPaths: ["a.ts", "b.ts"],
  });
  expect(intelligence.search(first, "beta")).toHaveLength(1);
  expect(intelligence.search(first, "beta")[0]?.read).toMatchObject({
    path: "b.ts",
    offset: 1,
  });
  expect(intelligence.impact(first, "b.ts")).toContainEqual(
    expect.objectContaining({ fromPath: "a.ts", toPath: "b.ts", source: expect.any(String) }),
  );
  await expect(
    intelligence.structuralSearch({
      revision: first,
      pattern: "function $F() { $$$BODY }",
    }),
  ).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "a.ts", source: "@ast-grep/napi" })]),
  );

  await writeFile(join(root, "b.ts"), "export function beta() { return 2; }\n");
  const second = revision(root, "revision-2");
  await expect(intelligence.index({ revision: second })).resolves.toMatchObject({
    indexedPaths: ["a.ts", "b.ts"],
  });
  expect(() => intelligence.search(first, "beta")).toThrow(/graph is stale/);
  expect(intelligence.search(second, "beta")[0]?.revisionDigest).toBe("revision-2");
  db.close();
});

function revision(workspaceRoot: string, digest: string): WorkspaceRevision {
  return {
    schemaVersion: 1,
    workspaceRoot,
    headOid: null,
    trackedDiffDigest: "tracked",
    stagedDiffDigest: "staged",
    untrackedContentDigest: digest,
    profileDigest: "intelligence",
    digest,
    observedAt: "2026-07-31T00:00:00.000Z",
  };
}
