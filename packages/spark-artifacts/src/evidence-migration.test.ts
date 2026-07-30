import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEvidenceStore } from "./index.ts";
import {
  EvidenceMigrationApplyError,
  EvidenceMigrationBlockedError,
  applyEvidenceNamespaceMigration,
  planEvidenceNamespaceMigration,
  restoreEvidenceNamespaceMigrationBackup,
} from "./evidence-migration.ts";
import { defaultArtifactStore } from "./artifact/store.ts";

const roots: string[] = [];
const createdAt = "2026-07-29T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Evidence namespace migration", () => {
  it("discovers multiple workspace fixtures with byte-stable, write-free dry runs", async () => {
    const first = await workspaceFixture("dry-a");
    const second = await workspaceFixture("dry-b");
    const firstHash = await directoryHash(first.root);
    const secondHash = await directoryHash(second.root);

    const left = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:b", rootDir: second.root },
      { workspaceId: "workspace:a", rootDir: first.root },
    ]);
    const right = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:a", rootDir: first.root },
      { workspaceId: "workspace:b", rootDir: second.root },
    ]);

    expect(reportHash(left.report)).toBe(reportHash(right.report));
    expect(left.report).toEqual(right.report);
    expect(Object.keys(left)).toEqual(["report"]);
    expect(JSON.stringify(left)).not.toContain("legacy body");
    expect(left.report.blocked).toBe(false);
    expect(left.report.totals).toMatchObject({
      discovered: 10,
      migrated: 8,
      artifactPreserved: 2,
      dangling: 0,
      invalid: 0,
      ambiguous: 0,
      artifactMisclassified: 0,
    });
    expect(await directoryHash(first.root)).toBe(firstHash);
    expect(await directoryHash(second.root)).toBe(secondHash);
    console.log(
      "SPARK_EVIDENCE_MIGRATION_DRY_RUN",
      JSON.stringify({
        reportSha256: reportHash(left.report),
        repeatedReportSha256: reportHash(right.report),
        planHash: left.report.planHash,
        fixtureDirectoryHashes: [firstHash, secondHash],
      }),
    );
    await expect(missing(join(first.root, ".spark", "evidence", "legacy-a.json"))).resolves.toBe(
      true,
    );
  });

  it("applies deterministic refs, preserves Artifacts, supports zero-change replay and restore", async () => {
    const fixture = await workspaceFixture("apply");
    const artifactMetadataHash = await fileHash(fixture.artifactMetadataPath);
    const artifactBlobHash = await fileHash(fixture.artifactBlobPath);
    const legacyMetadataHash = await fileHash(fixture.legacyMetadataPath);
    const plan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:apply", rootDir: fixture.root },
    ]);
    const beforeHash = plan.report.workspaces[0]!.beforeHash;

    const applied = await applyEvidenceNamespaceMigration(plan, {
      now: () => new Date("2026-07-29T01:00:00.000Z"),
    });
    const workspace = applied.workspaces[0]!;
    expect(workspace.backupPath).toContain(".spark/backups/evidence-namespace");
    expect(workspace.artifactHashAfter).toBe(workspace.artifactHashBefore);
    expect(await fileHash(fixture.artifactMetadataPath)).toBe(artifactMetadataHash);
    expect(await fileHash(fixture.artifactBlobPath)).toBe(artifactBlobHash);
    await expect(missing(fixture.legacyMetadataPath)).resolves.toBe(true);

    const migratedMetadataPath = join(fixture.root, ".spark", "evidence", "legacy-a.json");
    const migratedMetadataHash = await fileHash(migratedMetadataPath);
    const migrated = await defaultEvidenceStore(fixture.root).get("evidence:legacy-a" as never);
    expect(migrated.ref).toBe("evidence:legacy-a");
    expect(migrated.links).toEqual([
      { from: "evidence:legacy-a", to: "evidence:legacy-b", relation: "derived-from" },
    ]);
    expect(migrated.body).toMatchObject({ evidenceRefs: ["evidence:legacy-b"] });
    expect(
      JSON.parse(
        await readFile(
          join(fixture.root, ".spark", "memory", "learnings", "learning-memory.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      ref: "evidence:learning-memory",
      body: { evidenceRefs: ["evidence:legacy-a"] },
    });
    const task = JSON.parse(await readFile(fixture.taskPath, "utf8")) as {
      inputArtifacts: string[];
      outputArtifacts: string[];
    };
    expect(task.inputArtifacts).toEqual(["evidence:legacy-a"]);
    expect(task.outputArtifacts).toEqual(["evidence:legacy-b"]);
    expect(JSON.parse(await readFile(fixture.legacyRunPath, "utf8"))).toMatchObject({
      version: 1,
      completionSummary: { artifactRefs: ["evidence:legacy-a"] },
    });
    const v2Run = JSON.parse(await readFile(fixture.v2RunPath, "utf8"));
    expect(v2Run).toMatchObject({
      version: 2,
      completionSummary: { evidenceRefs: ["evidence:legacy-a"] },
    });
    expect(v2Run.completionSummary).not.toHaveProperty("artifactRefs");
    const workflow = JSON.parse(await readFile(fixture.workflowPath, "utf8"));
    expect(workflow).toMatchObject({
      runs: [
        {
          completionDigest: [{ evidenceRefs: ["evidence:legacy-a"] }],
          completionFollowUp: {
            completionDigest: [{ evidenceRefs: ["evidence:legacy-b"] }],
          },
        },
      ],
    });
    expect(workflow.runs[0].completionDigest[0]).not.toHaveProperty("artifactRefs");
    expect(workflow.runs[0].completionFollowUp.completionDigest[0]).not.toHaveProperty(
      "artifactRefs",
    );
    expect(JSON.parse(await readFile(fixture.reviewPath, "utf8"))).toMatchObject({
      evidenceRef: "evidence:legacy-a",
      reviewPacket: { evidenceRefs: ["evidence:legacy-a", "evidence:legacy-b"] },
    });
    expect(JSON.parse(await readFile(fixture.reviewIndexPath, "utf8"))).toMatchObject({
      reviews: [{ evidenceRef: "evidence:legacy-a" }],
    });
    expect(JSON.parse(await readFile(fixture.askReceiptPath, "utf8"))).toMatchObject({
      evidenceRef: "evidence:legacy-a",
    });
    expect(JSON.parse(await readFile(fixture.activityEventsPath, "utf8"))).toMatchObject({
      events: [{ evidenceRefs: ["evidence:legacy-a"] }],
    });
    expect(JSON.parse(await readFile(fixture.goalPath, "utf8"))).toMatchObject({
      goal: { lastReviewArtifactRef: "evidence:legacy-a" },
    });
    expect(
      JSON.parse(
        await readFile(
          join(
            fixture.root,
            ".spark",
            "sessions",
            "session-demo",
            "goal-reviews",
            "review-demo",
            "artifact-goal-review-demo.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      evidenceRef: "evidence:goal-review-demo",
      reviewPacket: { evidenceRefs: ["evidence:legacy-a"] },
    });
    expect(
      JSON.parse(
        await readFile(
          join(fixture.root, ".spark", "sessions", "session-demo", "goal.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ goal: { lastReviewArtifactRef: "evidence:goal-review-demo" } });
    expect(JSON.parse(await readFile(fixture.reproPath, "utf8"))).toMatchObject({
      requirements: [{ proof: { evidenceRefs: ["evidence:legacy-b"] } }],
    });
    expect(JSON.parse(await readFile(fixture.memoryPath, "utf8"))).toMatchObject({
      candidates: [{ evidenceRefs: ["evidence:legacy-a"] }],
    });

    const replayPlan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:apply", rootDir: fixture.root },
    ]);
    expect(replayPlan.report.totals).toMatchObject({ migrated: 0, changedFiles: 0 });
    expect(replayPlan.report.blocked, JSON.stringify(replayPlan.report.workspaces[0])).toBe(false);
    const replay = await applyEvidenceNamespaceMigration(replayPlan);
    expect(replay.workspaces[0]!.backupPath).toBeNull();

    const restored = await restoreEvidenceNamespaceMigrationBackup(workspace.backupPath!);
    expect(restored.treeHash).toBe(beforeHash);
    expect(restored.manifest.status).toBe("restored");
    await expect(missing(fixture.legacyMetadataPath)).resolves.toBe(false);
    await expect(missing(join(fixture.root, ".spark", "evidence", "legacy-a.json"))).resolves.toBe(
      true,
    );
    expect(JSON.parse(await readFile(fixture.legacyMetadataPath, "utf8"))).toMatchObject({
      ref: "artifact:legacy-a",
      kind: "record",
    });
    expect(await fileHash(fixture.legacyMetadataPath)).toBe(legacyMetadataHash);
    console.log(
      "SPARK_EVIDENCE_MIGRATION_APPLY_RESTORE",
      JSON.stringify({
        planHash: workspace.planHash,
        beforeHash,
        appliedHash: workspace.afterHash,
        legacyMetadataHash,
        migratedMetadataHash,
        artifactMetadataHash,
        artifactBlobHash,
        backupEntryCount: restored.manifest.entries.length,
        restoredTreeHash: restored.treeHash,
        replayChangedFiles: replay.totals.changedFiles,
      }),
    );
  });

  it("rolls back a write interruption and leaves the legacy store readable", async () => {
    const fixture = await workspaceFixture("write-interruption");
    const plan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:write", rootDir: fixture.root },
    ]);

    await expect(
      applyEvidenceNamespaceMigration(plan, {
        faultInjector(point, context) {
          if (point === "after-operation" && context.operationIndex === 0) {
            throw new Error("injected write interruption");
          }
        },
      }),
    ).rejects.toMatchObject({
      name: "EvidenceMigrationApplyError",
      rolledBack: true,
    } satisfies Partial<EvidenceMigrationApplyError>);
    const replay = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:write", rootDir: fixture.root },
    ]);
    expect(replay.report.workspaces[0]!.beforeHash).toBe(plan.report.workspaces[0]!.beforeHash);
    expect(JSON.parse(await readFile(fixture.legacyMetadataPath, "utf8"))).toMatchObject({
      ref: "artifact:legacy-a",
    });
    await expect(missing(join(fixture.root, ".spark", "evidence", "legacy-a.json"))).resolves.toBe(
      true,
    );
  });

  it("rolls back an injected rename failure without changing the planned tree hash", async () => {
    const fixture = await workspaceFixture("rename-failure");
    const plan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:rename", rootDir: fixture.root },
    ]);
    let failed = false;

    await expect(
      applyEvidenceNamespaceMigration(plan, {
        faultInjector(point, context) {
          if (!failed && point === "before-rename" && context.phase === "apply") {
            failed = true;
            throw new Error("injected rename failure");
          }
        },
      }),
    ).rejects.toMatchObject({ rolledBack: true } satisfies Partial<EvidenceMigrationApplyError>);
    const replay = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:rename", rootDir: fixture.root },
    ]);
    expect(replay.report.workspaces[0]!.beforeHash).toBe(plan.report.workspaces[0]!.beforeHash);
    expect(JSON.parse(await readFile(fixture.legacyMetadataPath, "utf8"))).toMatchObject({
      ref: "artifact:legacy-a",
    });
  });

  it("rolls back already-applied workspaces when a later workspace fails", async () => {
    const first = await workspaceFixture("cross-workspace-a");
    const second = await workspaceFixture("cross-workspace-b");
    const plan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:a", rootDir: first.root },
      { workspaceId: "workspace:b", rootDir: second.root },
    ]);

    await expect(
      applyEvidenceNamespaceMigration(plan, {
        faultInjector(point, context) {
          if (
            context.workspaceId === "workspace:b" &&
            point === "after-operation" &&
            context.operationIndex === 0
          ) {
            throw new Error("injected second-workspace failure");
          }
        },
      }),
    ).rejects.toMatchObject({ rolledBack: true } satisfies Partial<EvidenceMigrationApplyError>);
    const replay = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:a", rootDir: first.root },
      { workspaceId: "workspace:b", rootDir: second.root },
    ]);
    expect(replay.report.workspaces.map((workspace) => workspace.beforeHash)).toEqual(
      plan.report.workspaces.map((workspace) => workspace.beforeHash),
    );
    await expect(missing(first.legacyMetadataPath)).resolves.toBe(false);
    await expect(missing(second.legacyMetadataPath)).resolves.toBe(false);
  });

  it("rejects symlinked workspace state before planning any mutation", async () => {
    const fixture = await workspaceFixture("symlink");
    const evidenceRoot = join(fixture.root, ".spark", "evidence");
    const symlinkTarget = join(fixture.root, "symlink-target");
    await rm(evidenceRoot, { recursive: true, force: true });
    await mkdir(symlinkTarget, { recursive: true });
    await symlink(symlinkTarget, evidenceRoot, "dir");

    await expect(
      planEvidenceNamespaceMigration([{ workspaceId: "workspace:symlink", rootDir: fixture.root }]),
    ).rejects.toThrow(/symlinked workspace state is not supported/u);
    expect(await regularFiles(symlinkTarget)).toEqual([]);
  });

  it("fails closed on a missing evidence reference without writing", async () => {
    const fixture = await workspaceFixture("dangling");
    await writeJson(join(fixture.root, ".spark", "dangling.json"), {
      evidenceRefs: ["artifact:missing-evidence"],
    });
    const before = await directoryHash(fixture.root);
    const plan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:dangling", rootDir: fixture.root },
    ]);

    expect(plan.report.blocked).toBe(true);
    expect(plan.report.totals.dangling).toBe(1);
    await expect(applyEvidenceNamespaceMigration(plan)).rejects.toBeInstanceOf(
      EvidenceMigrationBlockedError,
    );
    expect(await directoryHash(fixture.root)).toBe(before);
  });

  it("fails closed on invalid legacy metadata and Artifact refs in evidence fields", async () => {
    const fixture = await workspaceFixture("invalid");
    await writeJson(join(fixture.root, ".spark", "artifacts", "invalid.json"), {
      kind: "record",
      title: "missing ref",
    });
    await writeJson(join(fixture.root, ".spark", "artifact-in-evidence.json"), {
      evidenceRefs: [fixture.artifactRef],
    });
    const plan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:invalid", rootDir: fixture.root },
    ]);

    expect(plan.report.blocked).toBe(true);
    expect(plan.report.totals.invalid).toBe(1);
    expect(plan.report.totals.artifactMisclassified).toBe(1);
    await expect(applyEvidenceNamespaceMigration(plan)).rejects.toBeInstanceOf(
      EvidenceMigrationBlockedError,
    );
  });

  it("fails closed when legacy and canonical Evidence field names collide", async () => {
    const fixture = await workspaceFixture("field-collision");
    await writeJson(fixture.reviewPath, {
      artifactRef: "artifact:legacy-a",
      evidenceRef: "artifact:legacy-b",
    });
    const plan = await planEvidenceNamespaceMigration([
      { workspaceId: "workspace:field-collision", rootDir: fixture.root },
    ]);

    expect(plan.report.blocked).toBe(true);
    expect(plan.report.workspaces[0]!.artifactMisclassified).toContainEqual(
      expect.objectContaining({ code: "legacy_evidence_field_collision" }),
    );
    await expect(applyEvidenceNamespaceMigration(plan)).rejects.toBeInstanceOf(
      EvidenceMigrationBlockedError,
    );
  });
});

interface WorkspaceFixture {
  root: string;
  legacyMetadataPath: string;
  artifactMetadataPath: string;
  artifactBlobPath: string;
  artifactRef: string;
  taskPath: string;
  legacyRunPath: string;
  v2RunPath: string;
  workflowPath: string;
  reviewPath: string;
  reviewIndexPath: string;
  askReceiptPath: string;
  activityEventsPath: string;
  goalPath: string;
  reproPath: string;
  memoryPath: string;
}

async function workspaceFixture(name: string): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), `spark-evidence-migration-${name}-`));
  roots.push(root);
  const artifactsRoot = join(root, ".spark", "artifacts");
  const blobsRoot = join(artifactsRoot, "blobs");
  await mkdir(blobsRoot, { recursive: true });

  await writeLegacyEvidence(root, {
    id: "legacy-b",
    kind: "trace",
    body: { status: "complete", evidenceRefs: [] },
  });
  const legacyMetadataPath = await writeLegacyEvidence(root, {
    id: "legacy-a",
    kind: "record",
    body: { summary: "legacy body", evidenceRefs: ["artifact:legacy-b"] },
    links: [
      {
        from: "artifact:legacy-a",
        to: "artifact:legacy-b",
        relation: "derived-from",
      },
    ],
    parentArtifactRefs: ["artifact:legacy-b"],
  });

  await writeLegacyEvidence(root, {
    id: "learning-memory",
    kind: "knowledge",
    body: { statement: "memory", evidenceRefs: ["artifact:legacy-a"] },
    storeRelative: join(".spark", "memory", "learnings"),
  });

  const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-29T17:09:18.138Z"));
  const artifact = await defaultArtifactStore(root)
    .put({
      ref: "artifact:product-preview" as never,
      kind: "preview",
      title: "Preserved preview",
      format: "markdown",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "md",
        content: "Product body contains artifact:legacy-a and must remain byte-identical.",
        version: 1,
      },
    })
    .finally(() => dateNow.mockRestore());
  const artifactMetadataPath = join(
    artifactsRoot,
    `${artifact.ref.slice("artifact:".length)}.json`,
  );
  const artifactBlobPath = join(artifactsRoot, artifact.blobPath!);

  await defaultEvidenceStore(root).put({
    ref: "evidence:current" as never,
    kind: "record",
    title: "Current evidence",
    format: "json",
    body: { evidenceRefs: ["artifact:legacy-a"] },
    provenance: { producer: "spark" },
  });

  const taskPath = join(root, ".spark", "projects", "proj-demo", "tasks", "task-demo", "task.json");
  await writeJson(taskPath, {
    version: 1,
    ref: "task:demo",
    inputArtifacts: ["artifact:legacy-a"],
    outputArtifacts: ["artifact:legacy-b"],
  });
  const legacyRunPath = join(
    root,
    ".spark",
    "projects",
    "proj-demo",
    "tasks",
    "task-demo",
    "runs",
    "run-demo.json",
  );
  await writeJson(legacyRunPath, {
    version: 1,
    ref: "run:demo",
    outputArtifacts: ["artifact:legacy-b"],
    completionSummary: { artifactRefs: ["artifact:legacy-a"] },
  });
  const v2RunPath = join(
    root,
    ".spark",
    "projects",
    "proj-demo",
    "tasks",
    "task-demo",
    "runs",
    "run-v2.json",
  );
  await writeJson(v2RunPath, {
    version: 2,
    ref: "run:v2",
    outputEvidenceRefs: ["artifact:legacy-b"],
    completionSummary: { artifactRefs: ["artifact:legacy-a"] },
  });
  const workflowPath = join(root, ".spark", "workflow-runs.json");
  await writeJson(workflowPath, {
    version: 1,
    manager: { status: "idle" },
    runs: [
      {
        ref: "run:workflow",
        completionDigest: [{ artifactRefs: ["artifact:legacy-a"] }],
        completionFollowUp: {
          completionDigest: [{ artifactRefs: ["artifact:legacy-b"] }],
        },
      },
    ],
  });
  const reviewPath = join(root, ".spark", "reviews", "review.json");
  await writeJson(reviewPath, {
    artifactRef: "artifact:legacy-a",
    reviewPacket: {
      evidenceRefs: ["artifact:legacy-a", "artifact:legacy-b"],
      evidencePreviews: [{ ref: "artifact:legacy-a", title: "preview" }],
    },
  });
  const reviewIndexPath = join(root, ".spark", "reviews", "index.json");
  await writeJson(reviewIndexPath, {
    version: 1,
    reviews: [{ artifactRef: "artifact:legacy-a" }],
  });
  const askReceiptPath = join(root, ".spark", "asks", "evidence-receipts", "legacy-a.json");
  await writeJson(askReceiptPath, {
    schema: "spark.ask.evidence-receipt/v1",
    artifactRef: "artifact:legacy-a",
  });
  const activityEventsPath = join(root, ".spark", "role-run-activity-events.json");
  await writeJson(activityEventsPath, {
    version: 1,
    events: [{ runRef: "run:demo", artifactRefs: ["artifact:legacy-a"] }],
  });
  const goalPath = join(root, ".spark", "session-goals", "goal.json");
  await writeJson(goalPath, {
    goal: {
      lastReviewRef: "artifact:legacy-a",
      lastReviewArtifactRef: "artifact:legacy-a",
    },
  });
  await writeJson(
    join(
      root,
      ".spark",
      "sessions",
      "session-demo",
      "goal-reviews",
      "review-demo",
      "artifact-goal-review-demo.json",
    ),
    {
      artifactRef: "artifact:goal-review-demo",
      reviewPacket: { evidenceRefs: ["artifact:legacy-a"] },
    },
  );
  await writeJson(join(root, ".spark", "sessions", "session-demo", "goal.json"), {
    goal: { lastReviewArtifactRef: "artifact:goal-review-demo" },
  });
  const reproPath = join(root, ".spark", "repro.json");
  await writeJson(reproPath, {
    requirements: [{ proof: { kind: "evidence", evidenceRefs: ["artifact:legacy-b"] } }],
  });
  const memoryPath = join(root, ".spark", "memory", "recall-candidates.json");
  await writeJson(memoryPath, {
    candidates: [{ id: "candidate", evidenceRefs: ["artifact:legacy-a"] }],
  });

  return {
    root,
    legacyMetadataPath,
    artifactMetadataPath,
    artifactBlobPath,
    artifactRef: artifact.ref,
    taskPath,
    legacyRunPath,
    v2RunPath,
    workflowPath,
    reviewPath,
    reviewIndexPath,
    askReceiptPath,
    activityEventsPath,
    goalPath,
    reproPath,
    memoryPath,
  };
}

async function writeLegacyEvidence(
  root: string,
  options: {
    id: string;
    kind: "knowledge" | "record" | "trace";
    body: Record<string, unknown>;
    storeRelative?: string;
    links?: Array<Record<string, unknown>>;
    parentArtifactRefs?: string[];
  },
): Promise<string> {
  const artifactsRoot = join(root, options.storeRelative ?? join(".spark", "artifacts"));
  const serialized = JSON.stringify(options.body, null, 2);
  const hash = createHash("sha256").update(serialized).digest("hex");
  const blobPath = join("blobs", `${hash}.json`);
  await mkdir(join(artifactsRoot, "blobs"), { recursive: true });
  await writeFile(join(artifactsRoot, blobPath), serialized, "utf8");
  const metadataPath = join(artifactsRoot, `${options.id}.json`);
  await writeJson(metadataPath, {
    ref: `artifact:${options.id}`,
    kind: options.kind,
    title: `Legacy ${options.id}`,
    format: "json",
    body: options.body,
    curation: { status: "curated", retention: "project" },
    hash,
    blobPath,
    links: options.links ?? [],
    provenance: {
      producer: "task",
      ...(options.parentArtifactRefs ? { parentArtifactRefs: options.parentArtifactRefs } : {}),
    },
    createdAt,
    updatedAt: createdAt,
  });
  return metadataPath;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function directoryHash(root: string): Promise<string> {
  const files = await regularFiles(root);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function regularFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) output.push(child);
    }
  }
  await visit(root);
  return output;
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function reportHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}
