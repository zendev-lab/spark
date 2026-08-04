import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  captureWorkspaceRevision,
  TSC_PROVIDER_ID,
  TYPESCRIPT_DUAL_ROUTE_DIGEST,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  VITE_PLUS_PROVIDER_ID,
  type LensVerificationReceipt,
  type ProviderVersion,
} from "@zendev-lab/spark-lens";
import { describe, expect, test } from "vitest";

import { defaultEvidenceStore, type ArtifactRef, type JsonValue } from "../index.ts";
import { requireCurrentLensPass } from "./verification-gate.ts";

const execFileAsync = promisify(execFile);

test("Ready gate accepts only a current digest-bound Pass receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-lens-ready-gate-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, "index.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "index.ts"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Spark Lens",
      "-c",
      "user.email=lens@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  const gitChangeRef = "artifact:fixture" as ArtifactRef;
  const revision = await captureWorkspaceRevision({
    workspaceRoot: root,
    profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  });
  const receipt: LensVerificationReceipt = {
    schemaVersion: 1,
    gitChangeRef,
    workspaceRevision: revision,
    routeDigest: TYPESCRIPT_DUAL_ROUTE_DIGEST,
    profileDigest: revision.profileDigest,
    providers: [
      {
        id: TSC_PROVIDER_ID,
        version: "6.0.3" as ProviderVersion,
        status: "ok",
        durationMs: 10,
      },
      {
        id: VITE_PLUS_PROVIDER_ID,
        version: "0.2.6" as ProviderVersion,
        status: "ok",
        durationMs: 20,
      },
    ],
    obligations: ["owner", "verifier"],
    observationRefs: [],
    externalChecks: [
      {
        provider: "github-pr-checks",
        subjectRevision: revision.headOid!,
        verdict: "pass",
        obligations: ["required GitHub checks"],
        observedAt: "2026-07-31T00:00:00.000Z",
      },
    ],
    verdict: "pass",
    createdAt: "2026-07-31T00:00:00.000Z",
  };
  const { externalChecks: _externalChecks, ...receiptWithoutPrChecks } = receipt;
  await defaultEvidenceStore(root).put({
    kind: "record",
    title: "Lens pass without PR checks",
    format: "json",
    body: receiptWithoutPrChecks as unknown as JsonValue,
    provenance: {
      producer: "spark",
      note: "lens:typescript-dual-verification-v1",
    },
  });
  await expect(requireCurrentLensPass(root, gitChangeRef)).rejects.toThrow(
    /current Pass Lens receipt required/,
  );
  const evidence = await defaultEvidenceStore(root).put({
    kind: "record",
    title: "Lens pass",
    format: "json",
    body: receipt as unknown as JsonValue,
    provenance: {
      producer: "spark",
      note: "lens:typescript-dual-verification-v1",
    },
  });

  await expect(requireCurrentLensPass(root, gitChangeRef)).resolves.toBe(evidence.ref);

  await writeFile(join(root, "index.ts"), "export const value = 2;\n");
  await expect(requireCurrentLensPass(root, gitChangeRef)).rejects.toThrow(
    /current Pass Lens receipt required/,
  );
});
