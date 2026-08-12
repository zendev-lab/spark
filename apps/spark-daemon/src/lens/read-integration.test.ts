import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentVersion, readRegularFileSnapshot } from "@zendev-lab/spark-files";
import {
  OXFMT_PROVIDER_ID,
  type LensDiagnosticReport,
  type ProviderId,
  type WorkspaceRevision,
} from "@zendev-lab/spark-lens";
import { expect, test } from "vitest";

import { DaemonLensPatchService } from "./patch-service.ts";
import { DaemonLensPatchStore } from "./patch-store.ts";
import { DaemonLensReadIntegration, requireSuccessfulProviderRun } from "./read-integration.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";

test("read preflight previews a provider fix without modifying or persisting a proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lens-read-annotation-"));
  const path = join(root, "value.ts");
  await writeFile(path, "export const  value=1\n", "utf8");
  const snapshot = await readRegularFileSnapshot(path);
  const revision = await revisionFor(root, path);
  let proposals = 0;
  const integration = new DaemonLensReadIntegration({
    verification: {
      async diagnostics() {
        return { report: passingReport(revision) };
      },
    },
    intelligence: {
      async index() {},
      outline() {
        return [];
      },
    },
    patches: {
      async propose() {
        proposals += 1;
        throw new Error("preflight must not persist proposals");
      },
      async apply() {
        throw new Error("preflight must not apply proposals");
      },
    },
    async formatSource() {
      return "export const value = 1;\n";
    },
    async safeFixSource({ source }) {
      return source;
    },
  });

  const annotation = await integration.annotate({
    workspaceRoot: root,
    path: "value.ts",
    fileVersion: snapshot.version,
    startLine: 1,
    endLine: 1,
    mode: "fresh",
  });

  expect(annotation?.fileVersion).toBe(snapshot.version);
  expect(annotation?.format.status).toBe("changes_available");
  expect(annotation?.fixes).toHaveLength(1);
  expect(await readFile(path, "utf8")).toBe("export const  value=1\n");
  expect(proposals).toBe(0);
});

test("read repair promotes the provider patch by CAS and returns the final version", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lens-read-repair-"));
  const path = join(root, "value.ts");
  await writeFile(path, "export const  value=1\n", "utf8");
  const snapshot = await readRegularFileSnapshot(path);
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const patches = new DaemonLensPatchService({
    store: new DaemonLensPatchStore(db),
    captureRevision: async (workspaceRoot) => await revisionFor(workspaceRoot, path),
    async verifyOverlay() {
      return { verdict: "pass" };
    },
    async verifyPromoted() {
      return { verdict: "pass", evidenceRef: "evidence:read-repair" };
    },
  });
  const integration = new DaemonLensReadIntegration({
    verification: {
      async diagnostics() {
        return { report: passingReport(await revisionFor(root, path)) };
      },
    },
    intelligence: {
      async index() {},
      outline() {
        return [];
      },
    },
    patches,
    async formatSource() {
      return "export const value = 1;\n";
    },
  });

  const repaired = await integration.repair({
    workspaceRoot: root,
    path: "value.ts",
    expectedVersion: snapshot.version,
    mode: "format",
  });

  expect(repaired.unchanged).toBe(false);
  expect(repaired.proposal?.provider).toBe(OXFMT_PROVIDER_ID);
  expect(repaired.receipt?.previousVersion).toBe(snapshot.version);
  expect(repaired.receipt?.verificationVerdict).toBe("pass");
  expect(await readFile(path, "utf8")).toBe("export const value = 1;\n");
  expect((await readRegularFileSnapshot(path)).version).toBe(repaired.receipt?.version);
  db.close();
});

test("read repair fails closed when the safe-fix provider exits non-zero", () => {
  expect(() =>
    requireSuccessfulProviderRun(
      { code: 2, stderr: "configuration failed before fixes completed" },
      "Vite+ safe lint fix",
    ),
  ).toThrow(/configuration failed before fixes completed/u);
});

function passingReport(revision: WorkspaceRevision): LensDiagnosticReport {
  return {
    schemaVersion: 1,
    profile: "test",
    routeDigest: "test-route",
    revision,
    verdict: "pass",
    providerResults: [],
    observations: [],
    createdAt: new Date().toISOString(),
  };
}

async function revisionFor(workspaceRoot: string, filePath: string): Promise<WorkspaceRevision> {
  const content = await readFile(filePath);
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    schemaVersion: 1,
    workspaceRoot,
    headOid: "head",
    trackedDiffDigest: contentVersion(content),
    stagedDiffDigest: "staged",
    untrackedContentDigest: "untracked",
    profileDigest: "profile",
    digest,
    observedAt: new Date().toISOString(),
  };
}
