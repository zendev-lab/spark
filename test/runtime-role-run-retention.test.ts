import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type { JsonValue, RoleRef, RunRef, TaskRef, ProjectRef } from "@zendev-lab/spark-core";
import {
  collectRoleRunEvidenceRetentionPlan,
  isRoleRunEvidenceBody,
  readRoleRunEvidencePreview,
} from "@zendev-lab/spark-runtime";

test("runtime role-run Evidence body guard owns compact Evidence shape", () => {
  const valid = {
    schemaVersion: 1,
    runRef: "run:guard" as RunRef,
    taskRef: "task:guard" as TaskRef,
    roleRef: "role:builtin-executor" as RoleRef,
    status: "succeeded",
    summary: "guarded body",
    record: {
      ref: "run:guard" as RunRef,
      roleRef: "role:builtin-executor" as RoleRef,
      status: "succeeded",
    },
    stdout: { bytes: 12, tail: "stdout", tailBytes: 6, truncated: false },
    stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
    jsonEvents: { count: 1, tail: ['{"type":"done"}'], tailEventCount: 1, truncated: false },
  };

  assert.equal(isRoleRunEvidenceBody(valid), true);
  assert.equal(
    isRoleRunEvidenceBody({ ...valid, jsonEvents: { ...valid.jsonEvents, tail: [{}] } }),
    false,
  );
  assert.equal(
    isRoleRunEvidenceBody({ ...valid, stdout: { ...valid.stdout, tailBytes: "6" } }),
    false,
  );
});

test("runtime role-run Evidence preview owns bounded metadata reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-runtime-role-run-preview-"));
  try {
    const store = defaultEvidenceStore(dir);
    const roleRef = "role:builtin-executor" as RoleRef;
    const runRef = "run:preview" as RunRef;
    const taskRef = "task:preview" as TaskRef;
    const evidence = await store.put({
      kind: "trace",
      title: "Previewable role run",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef,
        taskRef,
        roleRef,
        status: "failed",
        summary: "Preview summary",
        record: { ref: runRef, roleRef, status: "failed" },
        stdout: { bytes: 12, tail: "stdout-tail", tailBytes: 11, truncated: false },
        stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
        jsonEvents: { count: 1, tail: ['{"type":"error"}'], tailEventCount: 1, truncated: false },
      } as JsonValue,
      provenance: { producer: "task", taskRef, roleRef, runRef },
    });

    const preview = await readRoleRunEvidencePreview(dir, evidence.ref);
    assert.equal(preview.summary, "Preview summary");
    assert.equal(preview.status, "failed");
    assert.equal(preview.stdout?.tail, "stdout-tail");
    assert.equal(preview.jsonEvents?.count, 1);

    const tooLarge = await readRoleRunEvidencePreview(dir, evidence.ref, { maxMetadataBytes: 1 });
    assert.match(tooLarge.skippedReason ?? "", /metadata_too_large/);

    const nonRoleRun = await store.put({
      kind: "document",
      title: "Research evidence",
      format: "text",
      body: "not a role-run",
      provenance: { producer: "spark" },
    });
    const skipped = await readRoleRunEvidencePreview(dir, nonRoleRun.ref);
    assert.match(skipped.skippedReason ?? "", /not_role_run_evidence: document/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime role-run retention ignores legacy agent-run evidence kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-runtime-agent-run-retention-"));
  try {
    const evidenceRoot = join(dir, ".spark", "evidence");
    const blobDir = join(evidenceRoot, "blobs");
    await mkdir(blobDir, { recursive: true });
    await writeFile(join(blobDir, "legacy-agent-run.txt"), "x".repeat(2048), "utf8");
    await writeFile(
      join(evidenceRoot, "legacy-agent-run.json"),
      `${JSON.stringify(
        {
          ref: "evidence:legacy-agent-run",
          kind: "agent-run",
          title: "Legacy agent run",
          format: "text",
          bodySize: 2048,
          blobPath: "blobs/legacy-agent-run.txt",
          provenance: { producer: "task" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const plan = await collectRoleRunEvidenceRetentionPlan(dir, {
      dryRun: true,
      thresholdBytes: 1,
      tailBytes: 64,
    });

    assert.equal(plan.candidates.length, 0);
    const skipped = plan.skipped.find((item) => item.ref === "evidence:legacy-agent-run");
    assert.equal(skipped?.kind, "agent-run");
    assert.equal(skipped?.reason, "not_role_run_evidence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime role-run retention compacts historical transcript blobs without extension state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-runtime-role-run-retention-"));
  try {
    const store = defaultEvidenceStore(dir);
    const body = {
      schemaVersion: 1,
      runRef: "run:runtime-retention" as RunRef,
      taskRef: "task:runtime-retention" as TaskRef,
      roleRef: "role:builtin-executor" as RoleRef,
      runName: "runtime-retention-worker",
      status: "succeeded",
      summary: "large historical role-run output",
      record: {
        ref: "run:runtime-retention" as RunRef,
        roleRef: "role:builtin-executor" as RoleRef,
        runName: "runtime-retention-worker",
        status: "succeeded",
      },
      stdout: {
        bytes: 4096,
        tail: "tail-marker",
        tailBytes: "tail-marker".length,
        truncated: true,
      },
      stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
      jsonEvents: { count: 0, tail: [], tailEventCount: 0, truncated: false },
      payload: `${"x".repeat(4096)}tail-marker`,
    };
    const evidence = await store.put({
      kind: "trace",
      title: "Large runtime role run",
      format: "json",
      body: body as unknown as JsonValue,
      provenance: {
        producer: "task",
        projectRef: "proj:runtime-retention" as ProjectRef,
        taskRef: "task:runtime-retention" as TaskRef,
        roleRef: "role:builtin-executor" as RoleRef,
        runRef: "run:runtime-retention" as RunRef,
      },
    });
    const before = JSON.parse(await readFile(store.pathFor(evidence.ref), "utf8")) as {
      blobPath: string;
    };
    const blobPath = join(dir, ".spark", "evidence", before.blobPath);
    assert.equal(existsSync(blobPath), true);

    const dryRun = await collectRoleRunEvidenceRetentionPlan(dir, {
      dryRun: true,
      thresholdBytes: 1024,
      tailBytes: 96,
      exportDir: "exports/role-run-transcripts",
    });
    assert.equal(dryRun.candidates.length, 1);
    assert.equal(dryRun.deleted.length, 0);
    assert.equal(dryRun.candidates[0]?.runName, "runtime-retention-worker");
    assert.match(dryRun.candidates[0]?.transcriptTail?.tail ?? "", /tail-marker/);
    assert.equal(existsSync(blobPath), true);

    const applied = await collectRoleRunEvidenceRetentionPlan(dir, {
      dryRun: false,
      thresholdBytes: 1024,
      tailBytes: 96,
      exportDir: "exports/role-run-transcripts",
    });
    assert.equal(applied.candidates.length, 1);
    assert.equal(applied.deleted.length, 1);
    assert.equal(existsSync(blobPath), false);

    const after = JSON.parse(await readFile(store.pathFor(evidence.ref), "utf8")) as {
      body: { summary: string; stdout: { tail: string } };
      bodyTruncated?: boolean;
      blobPath?: string;
      transcriptRetention?: { exportPath?: string; fullTranscriptDeletedAt?: string };
    };
    assert.equal(after.blobPath, undefined);
    assert.equal(after.bodyTruncated, false);
    assert.match(after.body.summary, /runtime-retention-worker/);
    assert.match(after.body.stdout.tail, /tail-marker/);
    assert.ok(after.transcriptRetention?.fullTranscriptDeletedAt);
    assert.ok(after.transcriptRetention?.exportPath);
    assert.equal(existsSync(join(dir, after.transcriptRetention.exportPath)), true);

    const secondPass = await collectRoleRunEvidenceRetentionPlan(dir, {
      dryRun: true,
      thresholdBytes: 1024,
      tailBytes: 96,
    });
    assert.equal(secondPass.candidates.length, 0);
    assert.ok(secondPass.skipped.some((item) => item.reason === "already_retained"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
