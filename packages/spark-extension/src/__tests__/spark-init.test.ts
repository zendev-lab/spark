import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { renderActiveSparkContextSummary } from "../extension/spark-active-injection.ts";
import {
  hasNonSparkProjectFiles,
  shouldMaterializeSparkMd,
} from "../extension/spark-activation.ts";
import { initializeSparkIdea, shouldClarifyBeforeInit } from "../extension/spark-initialization.ts";

test("Spark project-file scan does not treat inaccessible directories as empty projects", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "spark-inaccessible-"));
  const locked = join(dir, "locked");
  try {
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await hasNonSparkProjectFiles(locked);
    } catch (error) {
      assert.ok(error instanceof Error && "code" in error);
      assert.match(String(error.code), /^(EACCES|EPERM)$/);
      return;
    }
    t.skip("filesystem permissions did not block directory reads on this platform");
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace-like cwd keeps Spark state under .spark without root SPARK.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workspace-"));
  try {
    assert.equal(await shouldMaterializeSparkMd(dir), false);
    const result = await initializeSparkIdea(dir, "Build a new idea from workspace root");
    assert.equal(result.sparkMdPath, undefined);
    assert.equal(result.taskCount, 0);
    assert.equal(result.currentTaskRef, undefined);
    const graph = await defaultTaskGraphStore(dir).load();
    const projectJson = JSON.stringify(graph?.snapshot(), null, 2);
    assert.doesNotMatch(projectJson, /Maintain current interaction context/);
    assert.doesNotMatch(projectJson, /Analyze project intent/);
    assert.doesNotMatch(projectJson, /Plan targeted clarification/);
    assert.doesNotMatch(projectJson, /Review initial direction/);
    assert.doesNotMatch(projectJson, /do not start with a generic intake template/);
    assert.doesNotMatch(projectJson, /"currentTaskRef"/);
    assert.doesNotMatch(projectJson, /"todos"/);
    await assert.rejects(() => readFile(join(dir, ".spark", "projects.json"), "utf8"));
    await assert.rejects(() => readFile(join(dir, ".spark", "review-gate.json"), "utf8"));
    assert.deepEqual(
      (await readdir(join(dir, ".spark"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
    await assert.rejects(() => readFile(join(dir, ".spark", "todos.json"), "utf8"));
    await assert.rejects(() => readFile(join(dir, "SPARK.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repo-like cwd materializes root SPARK.md as well", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repo-"));
  try {
    await mkdir(join(dir, ".git"));
    assert.equal(await shouldMaterializeSparkMd(dir), true);
    const result = await initializeSparkIdea(dir, "Build a repo-local spark project");
    assert.ok(result.sparkMdPath);
    const rootSpark = await readFile(result.sparkMdPath!, "utf8");
    assert.match(rootSpark, /Build a repo-local spark project/);
    assert.match(rootSpark, /## Working title/);
    assert.doesNotMatch(rootSpark, /## Delivery expectation/);
    assert.doesNotMatch(rootSpark, /待确认/);
    assert.doesNotMatch(rootSpark, /To be confirmed/);
    assert.doesNotMatch(rootSpark, /## 生态关系/);
    assert.equal(result.taskCount, 0);
    assert.equal(result.currentTaskRef, undefined);
    const graph = await defaultTaskGraphStore(dir).load();
    const projectJson = JSON.stringify(graph?.snapshot(), null, 2);
    assert.doesNotMatch(projectJson, /Analyze project intent/);
    assert.doesNotMatch(projectJson, /Plan targeted clarification/);
    assert.doesNotMatch(projectJson, /Review initial direction/);
    assert.doesNotMatch(projectJson, /Maintain current interaction context/);
    assert.doesNotMatch(projectJson, /"currentTaskRef"/);
    assert.doesNotMatch(projectJson, /"todos"/);
    await assert.rejects(() => readFile(join(dir, ".spark", "projects.json"), "utf8"));
    await assert.rejects(() => readFile(join(dir, ".spark", "todos.json"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initializeSparkIdea does not overwrite an existing initialized project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-no-overwrite-"));
  try {
    await mkdir(join(dir, ".git"));
    const first = await initializeSparkIdea(dir, "Original project intent");
    const firstSpark = await readFile(join(dir, "SPARK.md"), "utf8");
    const second = await initializeSparkIdea(dir, "New accidental request");
    const secondSpark = await readFile(join(dir, "SPARK.md"), "utf8");
    assert.equal(second.projectRef, first.projectRef);
    assert.equal(secondSpark, firstSpark);
    assert.doesNotMatch(secondSpark, /New accidental request/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rendering active Spark context does not persist current selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-no-current-before-activation-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    graph.createProject({ title: "Dormant project", description: "Not active yet" });
    await defaultTaskGraphStore(dir).save(graph);

    await renderActiveSparkContextSummary(dir, {
      cwd: dir,
      sessionManager: {
        getSessionFile: () => join(dir, ".pi-sessions", "default.json"),
        getLeafId: () => "default-leaf",
      },
    });
    await assert.rejects(() => stat(join(dir, ".spark", "sessions")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shouldClarifyBeforeInit disables generic upfront clarification templates", () => {
  assert.equal(shouldClarifyBeforeInit("Fix typo"), false);
  assert.equal(shouldClarifyBeforeInit("Build v0 LSP plugin workflow"), false);
  assert.equal(
    shouldClarifyBeforeInit("Build this:\n- repo skeleton\n- plugin\n- smoke test"),
    false,
  );
});

test("initializeSparkIdea preserves clarified title and trace evidence refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-clarified-"));
  try {
    await mkdir(join(dir, ".git"));
    const result = await initializeSparkIdea(dir, "Build a language service", {
      projectTitle: "Hypha v0: VS Code-first IDE experience for Spore",
      clarification: {
        workingTitle: "Hypha v0: VS Code-first IDE experience for Spore",
        outputLanguage: "en",
        objective: "Clarify the next IDE slice and continue into implementation planning.",
        targetUser: "Spore language contributors",
        smallestSlice: "A documented next-step plan for diagnostics and editor UX.",
        successSignal: "The next tasks are explicit and implementation-ready.",
        nonGoals: "Do not broaden into full plugin architecture yet.",
        deliveryMode: "document_and_execute",
        nextAction: "continue_tasking",
      },
      askEvidenceRefs: ["evidence:ask-test"],
      askRefs: ["ask:ask-test"],
    });
    assert.equal(result.projectTitle, "Hypha v0: VS Code-first IDE experience for Spore");
    assert.deepEqual(result.askEvidenceRefs, ["evidence:ask-test"]);
    const graph = await defaultTaskGraphStore(dir).load();
    const projectJson = JSON.stringify(graph?.snapshot(), null, 2);
    assert.match(projectJson, /Hypha v0: VS Code-first IDE experience for Spore/);
    assert.match(projectJson, /Execute smallest confirmed slice/);
    assert.match(projectJson, /A documented next-step plan for diagnostics and editor UX/);
    assert.doesNotMatch(projectJson, /Plan targeted clarification/);
    assert.doesNotMatch(projectJson, /Maintain current interaction context/);
    await assert.rejects(() => readFile(join(dir, ".spark", "projects.json"), "utf8"));
    const evidenceFiles = await readdir(join(dir, ".spark", "evidence"));
    let traceBody: unknown;
    let traceProducer: unknown;
    for (const file of evidenceFiles.filter((entry) => entry.endsWith(".json"))) {
      const content = JSON.parse(await readFile(join(dir, ".spark", "evidence", file), "utf8")) as {
        kind?: string;
        body?: unknown;
        provenance?: { producer?: unknown };
      };
      if (content.kind === "trace") {
        traceBody = content.body;
        traceProducer = content.provenance?.producer;
        break;
      }
    }
    assert.equal(traceProducer, "task");
    assert.deepEqual((traceBody as { askRefs?: string[] }).askRefs, ["ask:ask-test"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
