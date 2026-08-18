import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvidenceStore } from "@zendev-lab/spark-artifacts";
import { contentHash } from "@zendev-lab/spark-core";
import { afterEach, describe, expect, it } from "vitest";

import { migrateRoleSessionStructuredData } from "./role-session-data-migration.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Role/Session v6 structured data migration", () => {
  it("maps structured RoleRefs, preserves free text and EvidenceRef, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-role-session-data-migration-"));
    roots.push(root);
    const sparkHome = join(root, "home");
    const workspace = join(root, "workspace");
    const sparkRoot = join(workspace, ".spark");
    const userRoleSettings = join(sparkHome, "role-model-settings.json");
    const roleSettings = join(sparkRoot, "role-model-settings.json");
    const workflowRuns = join(sparkRoot, "workflow-runs.json");
    const eventLog = join(sparkRoot, "dynamic-workflows", "run-demo", "events.jsonl");
    const repro = join(sparkRoot, "sessions", "sess_demo", "repro.json");
    await mkdir(join(eventLog, ".."), { recursive: true });
    await mkdir(join(repro, ".."), { recursive: true });
    await writeJson(roleSettings, {
      version: 1,
      roleModels: {
        "role:builtin-worker": "provider/executor",
        "role:builtin-reviewer": "provider/reviewer",
      },
    });
    await writeJson(userRoleSettings, {
      version: 2,
      modelTypes: {
        research: "provider/research",
      },
    });
    await writeJson(workflowRuns, {
      runs: [
        {
          roleRef: "role:builtin-scout",
          note: "free text keeps role:builtin-worker unchanged",
        },
      ],
    });
    await writeFile(
      eventLog,
      `${JSON.stringify({ type: "role_started", effectiveRoleRef: "role:builtin-researcher" })}\n`,
      "utf8",
    );
    await writeJson(repro, {
      subgoals: [{ workerRoleRef: "role:builtin-worker" }],
    });

    const evidenceStore = new EvidenceStore({ rootDir: join(sparkRoot, "evidence") });
    const evidence = await evidenceStore.put({
      kind: "trace",
      title: "legacy role run",
      format: "json",
      body: {
        roleRef: "role:builtin-worker",
        nested: { reviewerRoleRef: "role:builtin-researcher" },
        note: "free text keeps role:builtin-worker unchanged",
      },
      provenance: {
        producer: "role",
        roleRef: "role:builtin-worker",
      },
    });
    const oldHash = evidence.hash;

    const first = await migrateRoleSessionStructuredData({
      sparkHome,
      userRoleModelSettingsFile: userRoleSettings,
      workspaces: [{ workspaceId: "ws_demo", rootDir: workspace }],
      now: () => "2026-08-04T09:00:00.000Z",
    });
    expect(first).toMatchObject({ changed: true, migratedAt: "2026-08-04T09:00:00.000Z" });
    expect(first.evidenceRefs).toEqual([evidence.ref]);

    const migratedSettings = await readJson(roleSettings);
    expect(migratedSettings).toEqual({
      version: 2,
      modelTypes: {
        implementation: "provider/executor",
        verification: "provider/reviewer",
      },
    });
    expect(
      (await readJson<{ modelTypes: Record<string, string> }>(userRoleSettings)).modelTypes,
    ).toEqual({
      exploration: "provider/research",
    });
    const migratedWorkflow = await readJson<{ runs: Array<Record<string, unknown>> }>(workflowRuns);
    expect(migratedWorkflow.runs[0]).toEqual({
      roleRef: "role:builtin-explorer",
      note: "free text keeps role:builtin-worker unchanged",
    });
    expect(await readFile(eventLog, "utf8")).toContain(
      '"effectiveRoleRef":"role:builtin-explorer"',
    );
    expect(
      (await readJson<{ subgoals: Array<{ workerRoleRef: string }> }>(repro)).subgoals[0]
        ?.workerRoleRef,
    ).toBe("role:builtin-executor");

    const migratedEvidence = await evidenceStore.get(evidence.ref);
    expect(migratedEvidence.ref).toBe(evidence.ref);
    expect(migratedEvidence.hash).not.toBe(oldHash);
    expect(migratedEvidence.updatedAt).toBe("2026-08-04T09:00:00.000Z");
    expect(migratedEvidence.provenance.roleRef).toBe("role:builtin-executor");
    expect(migratedEvidence.body).toEqual({
      roleRef: "role:builtin-executor",
      nested: { reviewerRoleRef: "role:builtin-explorer" },
      note: "free text keeps role:builtin-worker unchanged",
    });

    const journal = await readJson(join(first.backupDir!, "journal.json"));
    expect(journal).toMatchObject({
      migration: "role-session-v6",
      status: "complete",
      migratedAt: "2026-08-04T09:00:00.000Z",
    });
    expect(await readFile(join(first.backupDir!, "restore.sh"), "utf8")).toContain("cp -p");

    await expect(
      migrateRoleSessionStructuredData({
        sparkHome,
        userRoleModelSettingsFile: join(sparkHome, "role-model-settings.json"),
        workspaces: [{ workspaceId: "ws_demo", rootDir: workspace }],
      }),
    ).resolves.toEqual({ changed: false, files: 0, evidenceRefs: [] });
  });

  it("fails before switching when legacy and current model selectors conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-role-session-data-conflict-"));
    roots.push(root);
    const roleSettings = join(root, "workspace", ".spark", "role-model-settings.json");
    await mkdir(join(roleSettings, ".."), { recursive: true });
    await writeJson(roleSettings, {
      version: 2,
      modelTypes: {
        research: "provider/old",
        exploration: "provider/current",
      },
    });
    const original = await readFile(roleSettings, "utf8");

    await expect(
      migrateRoleSessionStructuredData({
        sparkHome: join(root, "home"),
        userRoleModelSettingsFile: join(root, "home", "role-model-settings.json"),
        workspaces: [{ workspaceId: "ws_demo", rootDir: join(root, "workspace") }],
      }),
    ).rejects.toThrow(/Conflicting role model settings/u);
    expect(await readFile(roleSettings, "utf8")).toBe(original);
  });

  it("warns and preserves malformed legacy JSON Evidence bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-role-session-invalid-evidence-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const evidenceRoot = join(workspace, ".spark", "evidence");
    const evidenceStore = new EvidenceStore({ rootDir: evidenceRoot });
    const evidence = await evidenceStore.put({
      kind: "trace",
      title: "legacy invalid JSON",
      format: "json",
      body: { roleRef: "role:builtin-worker" },
      provenance: { producer: "role", roleRef: "role:builtin-worker" },
    });
    if (!evidence.blobPath) throw new Error("missing Evidence blobPath");
    const malformed = "not JSON";
    const blobPath = join(evidenceRoot, evidence.blobPath);
    const metadataPath = join(evidenceRoot, `${evidence.ref.slice("evidence:".length)}.json`);
    const metadata = await readJson<Record<string, unknown>>(metadataPath);
    await writeFile(blobPath, malformed, "utf8");
    await writeJson(metadataPath, {
      ...metadata,
      hash: contentHash(malformed),
      body: malformed,
    });
    const warnings: string[] = [];

    const result = await migrateRoleSessionStructuredData({
      sparkHome: join(root, "home"),
      userRoleModelSettingsFile: join(root, "home", "role-model-settings.json"),
      workspaces: [{ workspaceId: "ws_demo", rootDir: workspace }],
      onWarning: (message) => warnings.push(message),
    });

    expect(result.changed).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Skipping RoleRef rewrite for malformed JSON Evidence body");
    expect(await readFile(blobPath, "utf8")).toBe(malformed);
    expect(await readJson<Record<string, unknown>>(metadataPath)).toMatchObject({
      hash: contentHash(malformed),
      body: malformed,
      provenance: { producer: "role", roleRef: "role:builtin-executor" },
    });
  });

  it("skips the workspace walk after a complete sentinel", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-role-session-sentinel-"));
    roots.push(root);
    const sparkHome = join(root, "home");
    const workspace = join(root, "workspace");
    const userRoleSettings = join(sparkHome, "role-model-settings.json");
    await migrateRoleSessionStructuredData({
      sparkHome,
      userRoleModelSettingsFile: userRoleSettings,
      workspaces: [{ workspaceId: "ws_demo", rootDir: workspace }],
      now: () => "2026-08-18T00:00:00.000Z",
    });
    const planted = join(workspace, ".spark", "role-model-settings.json");
    await mkdir(join(planted, ".."), { recursive: true });
    await writeJson(planted, {
      version: 1,
      roleModels: { "role:builtin-worker": "provider/executor" },
    });

    await expect(
      migrateRoleSessionStructuredData({
        sparkHome,
        userRoleModelSettingsFile: userRoleSettings,
        workspaces: [{ workspaceId: "ws_demo", rootDir: workspace }],
      }),
    ).resolves.toEqual({ changed: false, files: 0, evidenceRefs: [] });
    expect(await readJson(planted)).toEqual({
      version: 1,
      roleModels: { "role:builtin-worker": "provider/executor" },
    });
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
