import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import sparkExtension from "./index.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";

function context(cwd: string): SparkToolContext {
  return { cwd, sessionId: "session:dependency-replacement" };
}

function capturePublicTool(): SparkRegisteredToolConfig {
  const tools = new Map<string, SparkRegisteredToolConfig>();
  const host: Parameters<typeof sparkExtension>[0] = {
    registerCommand: () => undefined,
    sendMessage: () => undefined,
    registerTool: (tool) => tools.set(tool.name, tool),
    registerInternalTool: (tool) => tools.set(tool.name, tool),
  };
  sparkExtension(host);
  const taskWrite = tools.get("task_write");
  if (!taskWrite) throw new Error("task_write was not registered");
  return taskWrite;
}

async function execute(
  tool: SparkRegisteredToolConfig,
  cwd: string,
  params: Record<string, unknown>,
) {
  return tool.execute(
    "replace-dependencies",
    params,
    new AbortController().signal,
    () => undefined,
    context(cwd),
  );
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "spark-task-write-dependencies-"));
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Public replacement", description: "public tool" });
  const initialDependency = graph.createTask({
    projectRef: project.ref,
    name: "initial-dependency",
    title: "Initial dependency",
    description: "initial dependency",
  });
  const dependency = graph.createTask({
    projectRef: project.ref,
    name: "dependency",
    title: "Dependency",
    description: "dependency",
  });
  const duplicateTitle = graph.createTask({
    projectRef: project.ref,
    name: "duplicate-title",
    title: "Dependency",
    description: "duplicate",
  });
  const cancelled = graph.createTask({
    projectRef: project.ref,
    name: "cancelled",
    title: "Cancelled",
    description: "cancelled",
    status: "cancelled",
  });
  const target = graph.createTask({
    projectRef: project.ref,
    name: "target",
    title: "Target",
    description: "target",
  });
  const downstream = graph.createTask({
    projectRef: project.ref,
    name: "downstream",
    title: "Downstream",
    description: "downstream",
  });
  const otherProject = graph.createProject({ title: "Other project", description: "other" });
  const outsider = graph.createTask({
    projectRef: otherProject.ref,
    name: "outsider",
    title: "Outsider",
    description: "outsider",
  });
  graph.addDependency(target.ref, initialDependency.ref);
  graph.addDependency(downstream.ref, target.ref);
  const store = defaultTaskGraphStore(cwd);
  await store.save(graph);
  return {
    cwd,
    store,
    project,
    initialDependency,
    dependency,
    duplicateTitle,
    cancelled,
    target,
    downstream,
    outsider,
  };
}

function dependencyFilePath(data: Awaited<ReturnType<typeof fixture>>): string {
  const projectDir = data.project.ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
  return join(data.store.filePath, projectDir, "dependencies.json");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("task_write replace_dependencies", () => {
  it("replaces and clears dependencies through the production public action", async () => {
    const data = await fixture();
    try {
      const tool = capturePublicTool();
      const replaced = await execute(tool, data.cwd, {
        action: "replace_dependencies",
        taskRef: data.target.ref,
        dependsOn: [data.dependency.ref],
      });
      expect(replaced.details).toMatchObject({
        found: true,
        action: "replace_dependencies",
        dependsOn: [data.dependency.ref],
      });
      expect((await data.store.load())?.dependencies(data.project.ref)).toContainEqual({
        taskRef: data.target.ref,
        dependsOn: data.dependency.ref,
      });
      const cleared = await execute(tool, data.cwd, {
        action: "replace_dependencies",
        task: "@target",
        dependsOn: [],
      });
      expect(cleared.details).toMatchObject({ found: true, dependsOn: [] });
      expect((await data.store.load())?.dependencies(data.project.ref)).toEqual([
        { taskRef: data.downstream.ref, dependsOn: data.target.ref },
      ]);
    } finally {
      await rm(data.cwd, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "unknown prerequisite",
      (_data: Awaited<ReturnType<typeof fixture>>) => "missing",
      "task_dependency_prerequisite_not_found",
    ],
    [
      "cancelled prerequisite",
      (data: Awaited<ReturnType<typeof fixture>>) => data.cancelled.ref,
      "task_dependency_cancelled_prerequisite",
    ],
    [
      "cross-project prerequisite",
      (data: Awaited<ReturnType<typeof fixture>>) => data.outsider.ref,
      "task_dependency_cross_project",
    ],
    [
      "self edge",
      (data: Awaited<ReturnType<typeof fixture>>) => data.target.ref,
      "task_dependency_self_edge",
    ],
    [
      "cycle",
      (data: Awaited<ReturnType<typeof fixture>>) => data.downstream.ref,
      "task_dependency_cycle",
    ],
  ])(
    "returns stable code for %s through production task_write",
    async (_label, selector, error) => {
      const data = await fixture();
      try {
        const before = (await data.store.load())?.dependencies();
        const result = await execute(capturePublicTool(), data.cwd, {
          action: "replace_dependencies",
          taskRef: data.target.ref,
          dependsOn: [selector(data)],
        });
        expect(result.details).toMatchObject({ error });
        expect((await data.store.load())?.dependencies()).toEqual(before);
      } finally {
        await rm(data.cwd, { recursive: true, force: true });
      }
    },
  );

  it("keeps a non-empty dependency file byte-identical when mixed mutation is rejected", async () => {
    const data = await fixture();
    try {
      const filePath = dependencyFilePath(data);
      const beforeBytes = await readFile(filePath);
      const beforeDigest = sha256(beforeBytes);
      const beforeDependencies = (await data.store.load())?.dependencies();

      const result = await execute(capturePublicTool(), data.cwd, {
        action: "replace_dependencies",
        taskRef: data.target.ref,
        dependsOn: [data.dependency.ref],
        title: "forbidden mixed mutation",
      });

      expect(result.details).toMatchObject({ error: "task_dependency_mixed_mutation" });
      const afterBytes = await readFile(filePath);
      expect(afterBytes).toEqual(beforeBytes);
      expect(sha256(afterBytes)).toBe(beforeDigest);
      expect((await data.store.load())?.dependencies()).toEqual(beforeDependencies);
      expect(beforeDependencies).toContainEqual({
        taskRef: data.target.ref,
        dependsOn: data.initialDependency.ref,
      });
    } finally {
      await rm(data.cwd, { recursive: true, force: true });
    }
  });

  it.each([
    [{ task: "", dependsOn: [] }, "task_dependency_invalid_request"],
    [{ task: "target" }, "task_dependency_invalid_request"],
    [{ task: "target", dependsOn: ["  "] }, "task_dependency_invalid_request"],
    [{ task: "target", taskRef: "task:any", dependsOn: [] }, "task_dependency_invalid_request"],
    [{ task: "missing", dependsOn: [] }, "task_dependency_task_not_found"],
    [{ task: "Dependency", dependsOn: [] }, "task_dependency_task_ambiguous"],
    [{ task: "target", dependsOn: ["Dependency"] }, "task_dependency_prerequisite_ambiguous"],
    [{ task: "target", dependsOn: [], tasks: [] }, "task_dependency_mixed_mutation"],
    [{ task: "target", dependsOn: [], plan: {} }, "task_dependency_mixed_mutation"],
    [{ task: "target", dependsOn: [], status: "done" }, "task_dependency_mixed_mutation"],
  ])("rejects invalid or mixed request %# without persistence", async (params, error) => {
    const data = await fixture();
    try {
      const before = (await data.store.load())?.dependencies();
      const result = await execute(capturePublicTool(), data.cwd, {
        action: "replace_dependencies",
        ...params,
      });
      expect(result.details).toMatchObject({ error });
      expect((await data.store.load())?.dependencies()).toEqual(before);
    } finally {
      await rm(data.cwd, { recursive: true, force: true });
    }
  });
});
