import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import {
  capabilityRoute,
  captureWorkspaceRevision,
  aggregateDiagnosticFindings,
  evaluateLensVerdict,
  isWorkspaceRevisionCurrent,
  providersForRoute,
  type Observation,
  type ProviderId,
  type ProviderResult,
  type ProviderVersion,
  type WorkspaceRevision,
} from "./index.ts";

const execFileAsync = promisify(execFile);
const provider = (id: string) => id as ProviderId;
const version = (value: string) => value as ProviderVersion;

describe("capability routes", () => {
  test("encode one legal routing strategy at a time", () => {
    const route = capabilityRoute.verify("diagnostics", provider("tsc"), [provider("vite-plus")]);
    expect(providersForRoute(route)).toEqual(["tsc", "vite-plus"]);
  });

  test("reject duplicate or owner verifier entries", () => {
    expect(() => capabilityRoute.verify("diagnostics", provider("tsc"), [provider("tsc")])).toThrow(
      /must not contain the owner/,
    );
    expect(() => capabilityRoute.merge("diagnostics", [provider("tsc"), provider("tsc")])).toThrow(
      /distinct/,
    );
  });
});

describe("workspace revisions", () => {
  test("bind HEAD, tracked, staged, untracked, and profile state", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-lens-revision-"));
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), "export const value = 1;\n");
    await execFileAsync("git", ["add", "tracked.ts"], { cwd: root });
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

    const clean = await captureWorkspaceRevision({ workspaceRoot: root, profile: { id: "ts" } });
    expect(await isWorkspaceRevisionCurrent(clean, { id: "ts" })).toBe(true);

    await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");
    const tracked = await captureWorkspaceRevision({
      workspaceRoot: root,
      profile: { id: "ts" },
    });
    expect(tracked.digest).not.toBe(clean.digest);

    await execFileAsync("git", ["add", "tracked.ts"], { cwd: root });
    const staged = await captureWorkspaceRevision({ workspaceRoot: root, profile: { id: "ts" } });
    expect(staged.digest).not.toBe(tracked.digest);

    await writeFile(join(root, "untracked.ts"), "export const extra = true;\n");
    const untracked = await captureWorkspaceRevision({
      workspaceRoot: root,
      profile: { id: "ts" },
    });
    expect(untracked.digest).not.toBe(staged.digest);

    const otherProfile = await captureWorkspaceRevision({
      workspaceRoot: root,
      profile: { id: "strict-ts" },
    });
    expect(otherProfile.digest).not.toBe(untracked.digest);
  });
});

describe("fail-closed verdicts", () => {
  const revision = {
    schemaVersion: 1,
    workspaceRoot: "/tmp/workspace",
    headOid: "abc",
    trackedDiffDigest: "tracked",
    stagedDiffDigest: "staged",
    untrackedContentDigest: "untracked",
    profileDigest: "profile",
    digest: "revision",
    observedAt: "2026-07-31T00:00:00.000Z",
  } satisfies WorkspaceRevision;
  const result = (overrides: Partial<ProviderResult> = {}): ProviderResult => ({
    providerId: provider("tsc"),
    providerVersion: version("6.0.3"),
    capability: "diagnostics",
    revisionDigest: revision.digest,
    status: "ok",
    producedAt: "2026-07-31T00:00:01.000Z",
    durationMs: 20,
    ...overrides,
  });
  const observation = (overrides: Partial<Observation> = {}): Observation => ({
    ref: "observation:test",
    revisionDigest: revision.digest,
    capability: "diagnostics",
    subject: { path: "src/index.ts" },
    category: "type",
    severity: "error",
    summary: "invalid assignment",
    disposition: "open",
    agreement: "single_source",
    observations: [
      {
        providerId: provider("tsc"),
        providerVersion: version("6.0.3"),
        message: "invalid assignment",
        durationMs: 20,
      },
    ],
    ...overrides,
  });

  test("requires affirmative current results from every required provider", () => {
    expect(
      evaluateLensVerdict({
        revision,
        results: [],
        observations: [],
        requiredProviderIds: [provider("tsc")],
      }),
    ).toBe("inconclusive");
    expect(
      evaluateLensVerdict({
        revision,
        results: [result({ status: "silent" })],
        observations: [],
        requiredProviderIds: [provider("tsc")],
      }),
    ).toBe("inconclusive");
    expect(
      evaluateLensVerdict({
        revision,
        results: [result({ revisionDigest: "old" })],
        observations: [],
        requiredProviderIds: [provider("tsc")],
      }),
    ).toBe("stale");
  });

  test("distinguishes current failures, conflicts, and clean passes", () => {
    expect(
      evaluateLensVerdict({
        revision,
        results: [result()],
        observations: [observation()],
        requiredProviderIds: [provider("tsc")],
      }),
    ).toBe("fail");
    expect(
      evaluateLensVerdict({
        revision,
        results: [result()],
        observations: [
          observation({
            severity: "warning",
            agreement: "conflicting",
          }),
        ],
        requiredProviderIds: [provider("tsc")],
      }),
    ).toBe("inconclusive");
    expect(
      evaluateLensVerdict({
        revision,
        results: [result()],
        observations: [],
        requiredProviderIds: [provider("tsc")],
      }),
    ).toBe("pass");
  });
});

describe("diagnostic aggregation", () => {
  test("keeps provider provenance on one corroborated Observation", () => {
    const findings = aggregateDiagnosticFindings("revision", [
      {
        providerId: provider("tsc"),
        providerVersion: version("6.0.3"),
        path: "src/index.ts",
        line: 4,
        character: 2,
        code: "TS2322",
        severity: "error",
        message: "Type string is not assignable to number",
        fingerprint: "src/index.ts:4:assignment",
        durationMs: 10,
      },
      {
        providerId: provider("vite-plus"),
        providerVersion: version("0.2.6"),
        path: "src/index.ts",
        line: 4,
        character: 2,
        code: "TS2322",
        severity: "error",
        message: "Type string is not assignable to number",
        fingerprint: "src/index.ts:4:assignment",
        durationMs: 20,
      },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      agreement: "corroborated",
      observations: [{ providerId: "tsc" }, { providerId: "vite-plus" }],
    });
  });
});
