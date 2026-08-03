import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentVersion } from "@zendev-lab/spark-files";
import type { ProviderId, WorkspaceRevision } from "@zendev-lab/spark-lens";
import { expect, test } from "vitest";

import { DaemonLensPatchService } from "./patch-service.ts";
import { DaemonLensPatchStore } from "./patch-store.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";

test("verifies a patch in an overlay before CAS promotion and returns a new receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lens-patch-"));
  const path = join(root, "value.ts");
  await writeFile(path, "export const value = 1;\n");
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  let overlayChecks = 0;
  const service = new DaemonLensPatchService({
    store: new DaemonLensPatchStore(db),
    captureRevision: async (workspaceRoot) => await revisionFor(workspaceRoot, path),
    async verifyOverlay({ overlayRoot }) {
      overlayChecks += 1;
      expect(await readFile(join(overlayRoot, "value.ts"), "utf8")).toContain("value = 2");
      expect(await readFile(path, "utf8")).toContain("value = 1");
      return { verdict: "pass" };
    },
    async verifyPromoted() {
      expect(await readFile(path, "utf8")).toContain("value = 2");
      return { verdict: "pass", evidenceRef: "evidence:patch-pass" };
    },
  });
  const proposal = await service.propose({
    workspaceRoot: root,
    provider: "test-formatter" as ProviderId,
    edits: [{ path: "value.ts", startOffset: 21, endOffset: 22, newText: "2" }],
  });
  const promotion = await service.apply({
    workspaceRoot: root,
    proposalRef: proposal.ref,
  });

  expect(overlayChecks).toBe(1);
  expect(promotion.verdict).toBe("pass");
  expect(promotion.verificationEvidenceRef).toBe("evidence:patch-pass");
  expect(promotion.promotedRevision.digest).not.toBe(proposal.baseRevision.digest);

  const suppression = service.triage(root, {
    observationRef: "observation:fixed",
    revisionDigest: promotion.promotedRevision.digest,
    disposition: "suppressed",
    patchProposalRef: proposal.ref,
  });
  expect(suppression.patchProposalRef).toBe(proposal.ref);
  db.close();
});

test("rejects stale and unselected non-safe proposals before overlay verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lens-patch-stale-"));
  const path = join(root, "value.ts");
  await writeFile(path, "export const value = 1;\n");
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  let overlayChecks = 0;
  const service = new DaemonLensPatchService({
    store: new DaemonLensPatchStore(db),
    captureRevision: async (workspaceRoot) => await revisionFor(workspaceRoot, path),
    async verifyOverlay() {
      overlayChecks += 1;
      return { verdict: "pass" };
    },
    async verifyPromoted() {
      return { verdict: "pass" };
    },
  });
  const selected = await service.propose({
    workspaceRoot: root,
    provider: "test-code-action" as ProviderId,
    edits: [{ path: "value.ts", startOffset: 21, endOffset: 22, newText: "2" }],
    safety: { kind: "requires_selection", reasons: ["unsafe"] },
  });
  await expect(service.apply({ workspaceRoot: root, proposalRef: selected.ref })).rejects.toThrow(
    /explicit selection/,
  );

  await writeFile(path, "export const value = 3;\n");
  await expect(
    service.apply({
      workspaceRoot: root,
      proposalRef: selected.ref,
      explicitSelection: true,
    }),
  ).rejects.toThrow(/base revision is stale/);
  expect(overlayChecks).toBe(0);
  db.close();
});

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
