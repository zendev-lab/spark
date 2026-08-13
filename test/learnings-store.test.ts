import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { EvidenceStore } from "@zendev-lab/spark-artifacts";
import {
  defaultLearningStore,
  LearningExportFormatError,
  LearningStore,
  parseLearningExportMarkdown,
  renderLearningExportMarkdown,
} from "@zendev-lab/spark-memory";
import { createLegacyMemoryFixturePermit } from "@zendev-lab/spark-memory/legacy-fixture";
import { newRef } from "@zendev-lab/spark-core";

function legacyLearningStore(
  options: ConstructorParameters<typeof LearningStore>[0],
): LearningStore {
  return new LearningStore({ ...options, legacyFixturePermit: createLegacyMemoryFixturePermit() });
}

function legacyDefaultLearningStore(
  cwd: string,
  location?: Parameters<typeof defaultLearningStore>[1],
): LearningStore {
  return defaultLearningStore(cwd, location, {
    legacyFixturePermit: createLegacyMemoryFixturePermit(),
  });
}

test("learning store records active learnings and searches by content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-"));
  try {
    const store = legacyLearningStore({ evidenceStore: new EvidenceStore({ rootDir: dir }) });
    const evidenceRef = newRef("evidence", "evidence-plan");
    const recorded = await store.record({
      title: "Prefer explicit export for shared knowledge",
      statement:
        "Spark learnings live in .spark/memory/learnings locally and can be shared through explicit exports.",
      category: "decision",
      applicability: "When persisting Spark learning evidence for a repository.",
      evidenceRefs: [evidenceRef],
      tags: ["nyakore", "spark"],
      confidence: 0.9,
    });

    assert.equal(recorded.kind, "knowledge");
    assert.equal(recorded.body.status, "active");
    assert.equal(recorded.provenance.producer, "task");
    assert.match(recorded.provenance.note ?? "", /spark-memory learning record/);
    assert.deepEqual(
      recorded.links.map((link) => link.to),
      [evidenceRef],
    );

    const results = await store.search({ query: "explicit export" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ref, recorded.ref);
    assert.match(results[0]?.snippet ?? "", /learning/);
    assert.equal(results[0]?.evidenceSummary, evidenceRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("learning store hydrates compacted Evidence metadata for list and search", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-compacted-"));
  try {
    const store = legacyLearningStore({
      evidenceStore: new EvidenceStore({ rootDir: dir, inlineBodyThresholdBytes: 64 }),
    });
    const recorded = await store.record({
      title: "Hydrate compacted learning metadata",
      statement: "Learning list/search should read full bodies when metadata keeps only previews.",
      category: "workflow",
      applicability: "x".repeat(200),
    });
    assert.equal(recorded.bodyTruncated, true);

    const listed = await store.list();
    assert.equal(listed[0]?.body.statement, recorded.body.statement);
    const results = await store.search({ query: "metadata previews" });
    assert.equal(results[0]?.ref, recorded.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("learning store skips malformed persisted learning evidence with diagnostics", async () => {
  const malformedDir = await mkdtemp(join(tmpdir(), "spark-memory-learning-malformed-"));
  const mismatchDir = await mkdtemp(join(tmpdir(), "spark-memory-learning-kind-mismatch-"));
  try {
    const malformedEvidenceStore = new EvidenceStore({ rootDir: malformedDir });
    const malformedStore = legacyLearningStore({ evidenceStore: malformedEvidenceStore });
    const valid = await malformedStore.record({
      id: "valid-learning-survives",
      title: "Valid learning survives",
      statement: "Learning list and search should keep valid records when neighbors are bad.",
      tags: ["resilient"],
    });
    await malformedEvidenceStore.put({
      ref: newRef("evidence", "malformed-learning"),
      kind: "knowledge",
      title: "Malformed learning",
      format: "json",
      body: { status: "active" },
      provenance: { producer: "task" },
    });
    const invalidKindRef = newRef("evidence", "invalid-kind-learning");
    await writeFile(
      malformedEvidenceStore.pathFor(invalidKindRef),
      JSON.stringify(
        {
          ref: invalidKindRef,
          kind: "not-a-valid-kind",
          title: "Invalid Evidence kind",
          format: "json",
          body: {},
          links: [],
          provenance: { producer: "task" },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        null,
        2,
      ),
    );

    const listed = await malformedStore.listDetailed();
    assert.deepEqual(
      listed.evidence.map((evidence) => evidence.ref),
      [valid.ref],
    );
    assert.equal(listed.diagnostics.length, 2);
    assert.match(
      listed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      /recordRef must be a non-empty string/,
    );
    assert.match(
      listed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      /kind must be a valid Evidence kind/,
    );

    const searched = await malformedStore.searchDetailed({ query: "valid records" });
    assert.deepEqual(
      searched.results.map((result) => result.ref),
      [valid.ref],
    );
    assert.equal(searched.diagnostics.length, 2);

    const mismatchEvidenceStore = new EvidenceStore({ rootDir: mismatchDir });
    const mismatchStore = legacyLearningStore({ evidenceStore: mismatchEvidenceStore });
    const candidate = await mismatchStore.record({
      id: "candidate-kind-contract",
      title: "Candidate kind contract",
      statement: "Learning records must stay in knowledge Evidence records.",
      status: "candidate",
    });
    // A non-knowledge Evidence record in the same store is not a learning record: the
    // learning store filters by kind=knowledge and must ignore it, not warn or choke on it.
    await mismatchEvidenceStore.put({
      ref: newRef("evidence", "unrelated-document"),
      kind: "document",
      title: "Unrelated document",
      format: "json",
      body: candidate.body,
      provenance: { producer: "task" },
    });
    const listedCandidates = await mismatchStore.listDetailed({ includeCandidates: true });
    assert.deepEqual(
      listedCandidates.evidence.map((evidence) => evidence.ref),
      [candidate.ref],
    );
    assert.deepEqual(listedCandidates.diagnostics, []);
  } finally {
    await rm(malformedDir, { recursive: true, force: true });
    await rm(mismatchDir, { recursive: true, force: true });
  }
});

test("learning export markdown round-trips and rejects malformed blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-export-format-"));
  try {
    const store = legacyLearningStore({ evidenceStore: new EvidenceStore({ rootDir: dir }) });
    const recorded = await store.record({
      id: "learning-export-format",
      title: "Learning export format is package-owned",
      statement: "Learning export Markdown must parse as validated LearningRecord objects.",
      category: "decision",
      tags: ["learning", "export"],
    });

    const markdown = renderLearningExportMarkdown([recorded.body]);
    assert.match(markdown, /```json pi-learning/);
    assert.doesNotMatch(markdown, /```json spark-learning/);
    assert.deepEqual(parseLearningExportMarkdown(markdown, "learnings.md"), [recorded.body]);
    assert.deepEqual(
      parseLearningExportMarkdown(
        markdown.replace("```json pi-learning", "```json spark-learning"),
        "legacy-learnings.md",
      ),
      [recorded.body],
    );

    assert.throws(
      () =>
        parseLearningExportMarkdown(
          ["# Invalid export", "", "```json pi-learning", "{not-json", "```", ""].join("\n"),
          "invalid-json.md",
        ),
      (error) =>
        error instanceof LearningExportFormatError &&
        error.filePath === "invalid-json.md" &&
        error.blockIndex === 1 &&
        /not valid JSON/.test(error.message),
    );

    assert.throws(
      () =>
        parseLearningExportMarkdown(
          [
            "# Invalid export",
            "",
            "```json pi-learning",
            JSON.stringify({ id: 42, title: "Incomplete record" }, null, 2),
            "```",
            "",
          ].join("\n"),
          "invalid-record.md",
        ),
      (error) =>
        error instanceof LearningExportFormatError &&
        error.filePath === "invalid-record.md" &&
        error.blockIndex === 1 &&
        /not valid learning record: learning id must be a string/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("learning store keeps candidates out of default active recall", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-candidate-"));
  try {
    const store = legacyLearningStore({ evidenceStore: new EvidenceStore({ rootDir: dir }) });
    const candidate = await store.record({
      title: "Candidate task lesson",
      statement: "Only promote task-derived lessons after review.",
      status: "candidate",
      tags: ["candidate"],
    });

    assert.equal(candidate.kind, "knowledge");
    assert.deepEqual(await store.search({ query: "task-derived" }), []);

    const candidateResults = await store.search({ query: "task-derived", includeCandidates: true });
    assert.deepEqual(
      candidateResults.map((result) => result.ref),
      [candidate.ref],
    );

    const active = await store.activate(candidate.ref);
    assert.equal(active.kind, "knowledge");
    assert.equal(active.body.status, "active");
    assert.equal((await store.search({ query: "task-derived" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repository gitignore keeps local .spark stores untracked", async () => {
  const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /^\.spark\/$/m);
});

test("repository gitignore versions project .agents definitions and ignores worktrees", async () => {
  const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /^\.agents\/worktrees\/$/m);
  assert.doesNotMatch(gitignore, /^\.agents\/$/m);
  const nested = await readFile(join(process.cwd(), ".agents/.gitignore"), "utf8");
  assert.match(nested, /^worktrees\/$/m);
});

test("default learning store writes to .spark/memory/learnings outside git workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-location-"));
  try {
    const store = legacyDefaultLearningStore(dir);
    assert.equal(store.location, "workspace");
    await store.record({
      id: "learning-location-path",
      title: "Location-derived learning store",
      statement: "Learning storage location is derived from the store path.",
    });
    assert.ok(
      (
        await stat(join(dir, ".spark", "memory", "learnings", "learning-location-path.json"))
      ).isFile(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default learning store treats git workspaces as repo learnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-repo-location-"));
  try {
    await mkdir(join(dir, ".git"));
    const store = legacyDefaultLearningStore(join(dir, "subdir"));
    assert.equal(store.location, "repo");
    await store.record({
      id: "learning-repo-location-path",
      title: "Repo learning store",
      statement: "Git workspace learnings are repo learnings.",
    });
    assert.ok(
      (
        await stat(join(dir, ".spark", "memory", "learnings", "learning-repo-location-path.json"))
      ).isFile(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default learning store uses child repo .spark/memory/learnings over parent workspace learnings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "spark-memory-learning-parent-workspace-"));
  const repo = join(workspace, "child-repo");
  try {
    await mkdir(join(workspace, ".spark", "memory", "learnings"), { recursive: true });
    await mkdir(join(repo, ".git"), { recursive: true });
    const store = legacyDefaultLearningStore(join(repo, "src"));
    assert.equal(store.location, "repo");
    await store.record({
      id: "learning-child-repo-location-path",
      title: "Child repo learning store",
      statement: "Nested Git repos use their own repo learning store.",
    });
    assert.ok(
      (
        await stat(
          join(repo, ".spark", "memory", "learnings", "learning-child-repo-location-path.json"),
        )
      ).isFile(),
    );
    await assert.rejects(
      stat(
        join(workspace, ".spark", "memory", "learnings", "learning-child-repo-location-path.json"),
      ),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("default learning store writes user learnings under SPARK_HOME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-user-location-"));
  const previous = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const store = legacyDefaultLearningStore(dir, "user");
    assert.equal(store.location, "user");
    await store.record({
      id: "learning-user-location-path",
      title: "User learning store",
      statement: "User learnings live outside the repo/workspace.",
    });
    assert.ok(
      (await stat(join(dir, "memory", "learnings", "learning-user-location-path.json"))).isFile(),
    );
  } finally {
    if (previous === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("learning store supports stale, rejected, and superseded lifecycle states", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-learning-lifecycle-"));
  try {
    const store = legacyDefaultLearningStore(dir);
    const oldLearning = await store.record({
      id: "learning-old-export-rule",
      title: "Old export rule",
      statement: "Commit local Spark state directly.",
      status: "active",
    });
    const replacement = await store.record({
      id: "learning-new-export-rule",
      title: "New export rule",
      statement: "Export Markdown explicitly before sharing Spark learning state.",
      status: "active",
      supersedes: [oldLearning.ref],
    });

    const superseded = await store.markSuperseded(
      oldLearning.ref,
      replacement.ref,
      "Replaced by explicit export policy.",
    );
    assert.equal(superseded.body.status, "superseded");
    assert.deepEqual(superseded.body.supersededBy, [replacement.ref]);
    assert.equal(superseded.body.staleReason, "Replaced by explicit export policy.");

    const stale = await store.markStale(replacement.ref, "Repository policy changed.");
    assert.equal(stale.body.status, "stale");
    assert.equal(stale.body.staleReason, "Repository policy changed.");
    assert.ok(stale.body.staleAt);

    const rejected = await store.record({
      id: "learning-rejected-candidate",
      title: "Rejected candidate",
      statement: "Unreviewed candidates should be active.",
      status: "candidate",
    });
    const rejectedUpdate = await store.rejectCandidate(
      rejected.ref,
      "Contradicts the decision gate.",
    );
    assert.equal(rejectedUpdate.kind, "knowledge");
    assert.equal(rejectedUpdate.body.status, "rejected");
    assert.equal(rejectedUpdate.body.rejectedReason, "Contradicts the decision gate.");

    assert.deepEqual(
      (await store.list({ includeInactive: true })).map((evidence) => evidence.body.status).sort(),
      ["rejected", "stale", "superseded"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
