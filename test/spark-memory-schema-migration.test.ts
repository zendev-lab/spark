import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  applyMemorySchemaMigration,
  createMemorySchemaMigrationPlan,
  rollbackMemorySchemaMigration,
} from "@zendev-lab/spark-memory/schema-migration";

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("explicitly selected missing migration sources fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-schema-missing-source-"));
  try {
    await expect(createMemorySchemaMigrationPlan({ rootDir: root, entryPath: "" })).rejects.toThrow(
      "entryPath is required",
    );
    await expect(
      createMemorySchemaMigrationPlan({ rootDir: root, entryPath: "missing-memory.json" }),
    ).rejects.toThrow("selected memory migration source does not exist: entryPath");
    await expect(
      createMemorySchemaMigrationPlan({ rootDir: root, recallPath: "missing-recall.json" }),
    ).rejects.toThrow("selected memory migration source does not exist: recallPath");
    await expect(
      createMemorySchemaMigrationPlan({ rootDir: root, learningRoot: "missing-learnings" }),
    ).rejects.toThrow("selected memory migration source does not exist: learningRoot");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema migration is deterministic, source-bound, and byte-exact on rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-schema-migration-"));
  const memoryRoot = join(root, ".spark", "memory");
  const learningRoot = join(memoryRoot, "learnings");
  const entryPath = join(memoryRoot, "memory.json");
  const recallPath = join(memoryRoot, "recall-candidates.json");
  const learningPath = join(learningRoot, "learning-legacy.json");
  const backupDir = join(root, "backup");
  try {
    await mkdir(learningRoot, { recursive: true });
    const entryText = `${JSON.stringify(
      {
        version: 1,
        entries: [
          {
            id: "memory:legacy-entry",
            scope: "workspace",
            category: "convention",
            text: "Keep memory writes explicit.",
            reason: "approved repository convention",
            evidenceRefs: ["artifact:evidence-entry"],
            tags: ["memory"],
            status: "active",
            createdAt: "2026-07-29T12:00:00.000Z",
            updatedAt: "2026-07-29T12:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`;
    const recallText = `${JSON.stringify(
      {
        version: 1,
        candidates: [
          {
            id: "recall:legacy-candidate",
            scope: "workspace",
            text: "Review candidates before durable promotion.",
            reason: "preserved review principle",
            evidenceRefs: ["artifact:evidence-recall"],
            kind: "stable_fact",
            status: "promoted",
            createdAt: "2026-07-29T12:00:00.000Z",
            updatedAt: "2026-07-29T12:00:00.000Z",
            promotedAt: "2026-07-29T12:01:00.000Z",
            promotedTo: "artifact:learning-promoted",
          },
        ],
      },
      null,
      2,
    )}\n`;
    const learningBody = {
      id: "learning-legacy",
      title: "Explicit candidate review",
      statement: "Compaction creates candidates and never active durable memory.",
      category: "decision",
      status: "active",
      applicability: "When processing compaction output.",
      nonApplicability: null,
      rationale: "Policy boundary.",
      evidenceRefs: ["artifact:evidence-learning"],
      sourcePaths: [],
      sourceHash: null,
      sourceContent: null,
      dependsOn: [],
      supersedes: [],
      supersededBy: [],
      contradictedBy: [],
      tags: ["memory"],
      confidence: 1,
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      staleReason: null,
      staleAt: null,
      rejectedReason: null,
      rejectedAt: null,
    };
    const learningMetadataText = `${JSON.stringify(
      {
        ref: "artifact:learning-legacy",
        kind: "knowledge",
        title: learningBody.title,
        format: "json",
        body: learningBody,
        links: [],
        provenance: { producer: "task", note: "legacy fixture" },
        createdAt: learningBody.createdAt,
        updatedAt: learningBody.updatedAt,
      },
      null,
      2,
    )}\n`;
    await Promise.all([
      writeFile(entryPath, entryText),
      writeFile(recallPath, recallText),
      writeFile(learningPath, learningMetadataText),
    ]);

    const options = {
      rootDir: memoryRoot,
      entryPath,
      recallPath,
      learningRoot,
      learningLocation: "workspace" as const,
      now: () => "2026-07-30T00:00:00.000Z",
    };
    await expect(
      createMemorySchemaMigrationPlan({
        ...options,
        entryPath: join(root, "outside-memory.json"),
      }),
    ).rejects.toThrow("must remain under rootDir");
    const plan = await createMemorySchemaMigrationPlan(options);
    const repeat = await createMemorySchemaMigrationPlan(options);
    const planWithoutContent = plan.files.map(({ targetContent: _targetContent, ...file }) => file);
    if (
      JSON.stringify(planWithoutContent) !==
      JSON.stringify(repeat.files.map(({ targetContent: _targetContent, ...file }) => file))
    ) {
      throw new Error("migration plan file projections are not deterministic");
    }
    if (plan.digest !== repeat.digest)
      throw new Error("migration plan digest is not deterministic");
    if (plan.files.length !== 4)
      throw new Error(`expected four migration files, got ${plan.files.length}`);
    if (plan.summary.entry.statuses.active !== 1) throw new Error("entry active count mismatch");
    if (plan.summary.recall.statuses.promoted !== 1)
      throw new Error("recall promoted count mismatch");
    if (plan.summary.learning.statuses.active !== 1)
      throw new Error("learning active count mismatch");
    if (!plan.summary.entry.evidenceRefs.includes("artifact:evidence-entry")) {
      throw new Error("entry evidence reference was not summarized");
    }
    if (
      plan.summary.recall.contentDigests.length !== 1 ||
      plan.summary.learning.contentDigests.length !== 1
    ) {
      throw new Error("content digest accounting mismatch");
    }
    for (const file of plan.files) {
      if (file.sourceHash !== null) {
        const source = await readFile(file.path, "utf8");
        if (digest(source) !== file.sourceHash)
          throw new Error(`source hash mismatch: ${file.path}`);
      }
      if (digest(file.targetContent) !== file.targetHash)
        throw new Error(`target hash mismatch: ${file.path}`);
    }

    await writeFile(entryPath, `${entryText}drift\n`);
    await expect(applyMemorySchemaMigration(plan, backupDir)).rejects.toThrow("source changed");
    await writeFile(entryPath, entryText);

    const applied = await applyMemorySchemaMigration(plan, backupDir);
    if (applied.digest !== plan.digest) throw new Error("applied digest mismatch");
    for (const file of plan.files) {
      const current = await readFile(file.path, "utf8");
      if (digest(current) !== file.targetHash)
        throw new Error(`applied hash mismatch: ${file.path}`);
    }
    const rollbackCount = await rollbackMemorySchemaMigration(backupDir);
    if (rollbackCount !== plan.files.length) throw new Error("rollback record count mismatch");
    if ((await readFile(entryPath, "utf8")) !== entryText)
      throw new Error("entry rollback changed bytes");
    if ((await readFile(recallPath, "utf8")) !== recallText)
      throw new Error("recall rollback changed bytes");
    if ((await readFile(learningPath, "utf8")) !== learningMetadataText) {
      throw new Error("learning metadata rollback changed bytes");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
