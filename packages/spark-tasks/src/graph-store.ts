import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { delay } from "es-toolkit";
import { Type, type Static, type TSchema } from "typebox";
import { Errors } from "typebox/value";

import {
  formatJsonFile,
  isFileNotFoundError,
  nowIso,
  parseJsonFileText,
  stableId,
  writeJsonFileAtomic,
  type Project,
  type ProjectRef,
  type ProjectRoadmap,
  type Task,
  type TaskDependency,
  type TaskRef,
  type TaskRun,
} from "@zendev-lab/spark-core";
import { TaskGraph } from "./graph.ts";
import type {
  TaskGraphSnapshot,
  TaskGraphStoreLockOptions,
  TaskGraphStoreUpdateOptions,
} from "./common.ts";

export interface TaskGraphStoreUpdateResult<T> {
  graph: TaskGraph | null;
  result: T;
}

export interface TaskRunReconcileResult {
  inspected: number;
  stale: number;
  taskRefs: TaskRef[];
}

const DEFAULT_TASK_RUN_STALE_AFTER_MS = 30 * 60 * 1_000;

export class TaskGraphStoreConflictError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`task graph changed since it was loaded: ${filePath}`);
    this.name = "TaskGraphStoreConflictError";
    this.filePath = filePath;
  }
}

export class TaskGraphStoreLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`timed out waiting for task graph lock: ${lockPath}`);
    this.name = "TaskGraphStoreLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class TaskGraphStoreLockOwnerFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid task graph lock owner: ${filePath}: ${message}`);
    this.name = "TaskGraphStoreLockOwnerFormatError";
    this.filePath = filePath;
  }
}

export class TaskGraphStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid task graph store: ${filePath}: ${message}`);
    this.name = "TaskGraphStoreFormatError";
    this.filePath = filePath;
  }
}

const taskGraphSourceHashes = new WeakMap<TaskGraph, string>();
const taskGraphStoreLockDepth = new AsyncLocalStorage<number>();

export class TaskGraphStore {
  readonly filePath: string;
  readonly lockPath: string;
  readonly layout: "legacy-json" | "project-tree";

  constructor(filePath: string) {
    this.filePath = filePath;
    this.layout = filePath.endsWith(".json") ? "legacy-json" : "project-tree";
    this.lockPath =
      this.layout === "project-tree" ? join(filePath, "index.lock") : `${filePath}.lock`;
  }

  async save(graph: TaskGraph): Promise<void> {
    if (taskGraphStoreLockDepth.getStore()) {
      await this.saveUnlocked(graph);
      return;
    }
    await this.withLock(async () => {
      await this.assertGraphNotStale(graph);
      await this.saveUnlocked(graph);
    });
  }

  private async saveUnlocked(
    graph: TaskGraph,
    lockOptions: TaskGraphStoreLockOptions = {},
  ): Promise<void> {
    const snapshot = serializeTaskGraphStoreSnapshot(graph.snapshot());
    if (this.layout === "project-tree") {
      const canonical = canonicalizePersistedSnapshot(snapshot);
      await writeProjectTreeSnapshot(this.filePath, canonical, lockOptions);
      taskGraphSourceHashes.set(graph, stableId(formatJsonFile(canonical)));
      return;
    }
    const data = formatJsonFile(snapshot);
    await writeJsonFileAtomic(this.filePath, snapshot);
    taskGraphSourceHashes.set(graph, stableId(data));
  }

  async load(): Promise<TaskGraph | null> {
    const loaded =
      this.layout === "project-tree"
        ? await readProjectTreeSnapshot(this.filePath)
        : await readLegacyProjectJsonSnapshot(this.filePath);
    if (!loaded) return null;
    let graph: TaskGraph;
    try {
      graph = TaskGraph.fromSnapshot(deserializeTaskGraphStoreSnapshot(loaded.snapshot));
    } catch (error) {
      throw new TaskGraphStoreFormatError(
        this.filePath,
        `not valid task graph snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    taskGraphSourceHashes.set(graph, loaded.hash);
    return graph;
  }

  async withLock<T>(fn: () => T | Promise<T>, options: TaskGraphStoreLockOptions = {}): Promise<T> {
    if (taskGraphStoreLockDepth.getStore()) return fn();
    const release = await acquireTaskGraphStoreLock(this.lockPath, options);
    return taskGraphStoreLockDepth.run(1, async () => {
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  async update<T>(
    fn: (graph: TaskGraph) => T | Promise<T>,
    options: TaskGraphStoreUpdateOptions = {},
  ): Promise<TaskGraphStoreUpdateResult<T>> {
    const createIfMissing = options.createIfMissing ?? true;
    return this.withLock(async () => {
      const graph = await this.load();
      if (!graph) {
        if (!createIfMissing) return { graph: null, result: undefined as T };
        const created = new TaskGraph();
        const result = await fn(created);
        await this.saveUnlocked(created, options);
        return { graph: created, result };
      }
      const result = await fn(graph);
      await this.saveUnlocked(graph, options);
      return { graph, result };
    }, options);
  }

  async reconcileStaleTaskRuns(
    input: { now?: string; staleAfterMs?: number; projectRef?: ProjectRef } = {},
  ): Promise<TaskRunReconcileResult> {
    const now = input.now ?? nowIso();
    const staleAfterMs = input.staleAfterMs ?? DEFAULT_TASK_RUN_STALE_AFTER_MS;
    const nowMs = Date.parse(now);
    return (
      await this.update(
        (graph): TaskRunReconcileResult => {
          const result: TaskRunReconcileResult = { inspected: 0, stale: 0, taskRefs: [] };
          for (const run of graph.runs(input.projectRef)) {
            if (run.status !== "queued" && run.status !== "running") continue;
            result.inspected += 1;
            const updatedMs = Date.parse(run.updatedAt ?? run.startedAt ?? "");
            if (
              !Number.isFinite(nowMs) ||
              !Number.isFinite(updatedMs) ||
              nowMs - updatedMs < staleAfterMs
            )
              continue;
            graph.recordRun({
              ...run,
              status: "stale",
              failureKind: "claim_stale",
              errorMessage: `TaskRun became stale after ${staleAfterMs}ms without a durable update.`,
              finishedAt: now,
              updatedAt: now,
              attemptConsumed: false,
              resourceAllocation: undefined,
            });
            const task = graph.getTask(run.taskRef);
            if (task.claim?.runRef === run.ref) graph.releaseTaskClaim(task.ref);
            if (task.status === "running" || task.status === "failed")
              graph.setTaskStatus(task.ref, "pending");
            result.stale += 1;
            result.taskRefs.push(task.ref);
          }
          return result;
        },
        { createIfMissing: false },
      )
    ).result;
  }

  private async assertGraphNotStale(graph: TaskGraph): Promise<void> {
    const sourceHash = taskGraphSourceHashes.get(graph);
    if (!sourceHash) return;
    try {
      const currentHash = await this.currentStoreHash();
      if (currentHash !== sourceHash) throw new TaskGraphStoreConflictError(this.filePath);
    } catch (error) {
      if (isFileNotFoundError(error)) throw new TaskGraphStoreConflictError(this.filePath);
      throw error;
    }
  }

  private async currentStoreHash(): Promise<string> {
    if (this.layout === "project-tree") {
      const loaded = await readProjectTreeSnapshot(this.filePath);
      if (!loaded) throw new TaskGraphStoreConflictError(this.filePath);
      return loaded.hash;
    }
    const current = await readFile(this.filePath, "utf8");
    return stableId(current);
  }
}

export function defaultTaskGraphStore(cwd: string): TaskGraphStore {
  return new TaskGraphStore(join(cwd, ".spark", "projects"));
}

interface LoadedTaskGraphStoreSnapshot {
  snapshot: PersistedTaskGraphSnapshot;
  hash: string;
}

async function readLegacyProjectJsonSnapshot(
  filePath: string,
): Promise<LoadedTaskGraphStoreSnapshot | null> {
  let data: string;
  try {
    data = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
  const raw = parseTaskGraphStoreJson(data, filePath);
  assertPersistedValue(persistedTaskGraphSnapshotSchema, raw, filePath);
  return {
    snapshot: raw,
    hash: stableId(data),
  };
}

function parseTaskGraphStoreJson(text: string, filePath: string): unknown {
  const raw = parseJsonFileText(
    text,
    filePath,
    (path, message) => new TaskGraphStoreFormatError(path, message),
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreFormatError(filePath, "JSON root must be an object");
  }
  return raw;
}

interface PersistedProject extends Omit<Project, "purpose"> {
  intent?: string;
  purpose?: string;
}

interface PersistedTaskGraphSnapshot extends Omit<TaskGraphSnapshot, "projects"> {
  projects: PersistedProject[];
}

function serializeTaskGraphStoreSnapshot(snapshot: TaskGraphSnapshot): PersistedTaskGraphSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => {
      const { purpose, ...rest } = project;
      return {
        ...rest,
        intent: purpose,
      };
    }),
  };
}

function canonicalizePersistedSnapshot(
  snapshot: PersistedTaskGraphSnapshot,
): PersistedTaskGraphSnapshot {
  return {
    projects: [...snapshot.projects].sort(compareRef),
    tasks: [...snapshot.tasks].sort(compareRef),
    dependencies: [...(snapshot.dependencies ?? [])].sort(compareDependency),
    runs: [...(snapshot.runs ?? [])].sort(compareRef),
  };
}

function deserializeTaskGraphStoreSnapshot(raw: unknown): TaskGraphSnapshot {
  const snapshot = raw as PersistedTaskGraphSnapshot;
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => {
      const { intent, purpose, ...rest } = project;
      return {
        ...rest,
        purpose: purpose ?? intent,
      };
    }),
  } as TaskGraphSnapshot;
}

interface ProjectIndexSnapshot {
  version: 1;
  rebuildable: true;
  generatedAt: string;
  legacyImportOnly: string[];
  projects: ProjectIndexEntry[];
}

interface ProjectIndexEntry {
  projectRef: ProjectRef;
  path: string;
  projectPath: string;
  roadmapPath: string;
  dependenciesPath: string;
  tasksPath: string;
  title: string;
  updatedAt: string;
  taskCount: number;
  currentTaskRef?: TaskRef;
}

interface ProjectFileSnapshot extends Omit<Project, "roadmap" | "purpose"> {
  version: 1;
  purpose?: string;
  intent?: string;
  roadmapPath: "roadmap.json";
  dependenciesPath: "dependencies.json";
  tasksPath: "tasks";
  reviewPath: "reviews";
}

interface RoadmapFileSnapshot extends ProjectRoadmap {
  version: 1;
}

interface DependencyFileSnapshot {
  version: 1;
  projectRef: ProjectRef;
  dependencies: TaskDependency[];
}

interface TaskFileSnapshot extends Task {
  version: 3;
  todoOwnerRef: TaskRef;
  runsPath: "runs";
  reviewsPath: "reviews";
}

interface RunFileSnapshot extends TaskRun {
  version: 2;
}

const nonEmptyStringSchema = Type.String({ minLength: 1 });
const projectRefSchema = Type.String({ minLength: 6, pattern: "^proj:" });
const taskRefSchema = Type.String({ minLength: 6, pattern: "^task:" });
const runRefSchema = Type.String({ minLength: 5, pattern: "^run:" });

const persistedProjectEntrySchema = Type.Object({ ref: projectRefSchema });
const persistedTaskEntrySchema = Type.Object({ ref: taskRefSchema, projectRef: projectRefSchema });
const persistedDependencyEntrySchema = Type.Object({
  taskRef: taskRefSchema,
  dependsOn: taskRefSchema,
});
const persistedRunEntrySchema = Type.Object({
  ref: runRefSchema,
  projectRef: projectRefSchema,
  taskRef: taskRefSchema,
});

const persistedTaskGraphSnapshotSchema = Type.Unsafe<PersistedTaskGraphSnapshot>(
  Type.Object({
    projects: Type.Array(persistedProjectEntrySchema),
    tasks: Type.Array(persistedTaskEntrySchema),
    dependencies: Type.Optional(Type.Array(persistedDependencyEntrySchema)),
    runs: Type.Optional(Type.Array(persistedRunEntrySchema)),
  }),
);

const projectIndexSnapshotSchema = Type.Unsafe<ProjectIndexSnapshot>(
  Type.Object({
    version: Type.Literal(1),
    rebuildable: Type.Literal(true),
    generatedAt: nonEmptyStringSchema,
    legacyImportOnly: Type.Array(Type.String()),
    projects: Type.Array(
      Type.Object({
        projectRef: projectRefSchema,
        path: nonEmptyStringSchema,
        projectPath: nonEmptyStringSchema,
        roadmapPath: nonEmptyStringSchema,
        dependenciesPath: nonEmptyStringSchema,
        tasksPath: nonEmptyStringSchema,
        title: Type.String(),
        updatedAt: nonEmptyStringSchema,
        taskCount: Type.Integer({ minimum: 0 }),
        currentTaskRef: Type.Optional(taskRefSchema),
      }),
    ),
  }),
);

const projectFileSnapshotSchema = Type.Unsafe<ProjectFileSnapshot>(
  Type.Object({
    version: Type.Literal(1),
    ref: projectRefSchema,
    title: Type.String(),
    description: Type.String(),
    purpose: Type.Optional(Type.String()),
    intent: Type.Optional(Type.String()),
    outputLanguage: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
    kind: Type.Optional(Type.String()),
    currentTaskRef: Type.Optional(taskRefSchema),
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
    roadmapPath: Type.Literal("roadmap.json"),
    dependenciesPath: Type.Literal("dependencies.json"),
    tasksPath: Type.Literal("tasks"),
    reviewPath: Type.Literal("reviews"),
  }),
);

const roadmapItemSchema = Type.Object({
  ref: Type.String({ minLength: 14, pattern: "^roadmap-item:" }),
  objective: Type.String(),
});
const roadmapFileSnapshotSchema = Type.Unsafe<RoadmapFileSnapshot>(
  Type.Object({
    version: Type.Literal(1),
    ref: Type.String({ minLength: 9, pattern: "^roadmap:" }),
    title: Type.String(),
    status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("done")])),
    activeItemRef: Type.Optional(Type.String({ minLength: 14, pattern: "^roadmap-item:" })),
    items: Type.Array(roadmapItemSchema),
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
  }),
);

const dependencyFileSnapshotSchema = Type.Unsafe<DependencyFileSnapshot>(
  Type.Object({
    version: Type.Literal(1),
    projectRef: projectRefSchema,
    dependencies: Type.Array(persistedDependencyEntrySchema),
  }),
);

const taskFileInputSchema = Type.Object({
  version: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  ref: taskRefSchema,
  projectRef: projectRefSchema,
  title: Type.String(),
  description: Type.String(),
  status: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  updatedAt: nonEmptyStringSchema,
});

const runFileInputSchema = Type.Object({
  version: Type.Union([Type.Literal(1), Type.Literal(2)]),
  ref: runRefSchema,
  projectRef: projectRefSchema,
  taskRef: taskRefSchema,
  status: nonEmptyStringSchema,
});

async function writeProjectTreeSnapshot(
  root: string,
  snapshot: PersistedTaskGraphSnapshot,
  lockOptions: TaskGraphStoreLockOptions = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  const tasksByProject = new Map<ProjectRef, Task[]>();
  for (const task of snapshot.tasks) {
    const list = tasksByProject.get(task.projectRef) ?? [];
    list.push(task);
    tasksByProject.set(task.projectRef, list);
  }
  const runsByTask = new Map<TaskRef, TaskRun[]>();
  for (const run of snapshot.runs ?? []) {
    const list = runsByTask.get(run.taskRef) ?? [];
    list.push(run);
    runsByTask.set(run.taskRef, list);
  }
  const desiredProjectDirs = new Set(snapshot.projects.map((project) => storeDirName(project.ref)));
  const existingProjectDirs = await listProjectDirs(root);
  const projectLockDirs = [...new Set([...desiredProjectDirs, ...existingProjectDirs])].sort();
  const releaseProjectLocks = await acquireProjectTreeProjectLocks(
    root,
    projectLockDirs,
    lockOptions,
  );
  try {
    for (const existing of existingProjectDirs) {
      if (!desiredProjectDirs.has(existing))
        await rm(join(root, existing), { recursive: true, force: true });
    }

    const projectEntries: ProjectIndexEntry[] = [];
    for (const project of snapshot.projects) {
      const projectDirName = storeDirName(project.ref);
      const projectDir = join(root, projectDirName);
      const projectTasks = [...(tasksByProject.get(project.ref) ?? [])].sort(compareRef);
      const projectDependencies = (snapshot.dependencies ?? [])
        .filter((dependency) => projectTasks.some((task) => task.ref === dependency.taskRef))
        .sort(compareDependency);
      await writeJsonFileIfChanged(join(projectDir, "project.json"), projectFileSnapshot(project));
      await writeJsonFileIfChanged(join(projectDir, "roadmap.json"), {
        version: 1,
        ...project.roadmap,
      } satisfies RoadmapFileSnapshot);
      await writeJsonFileIfChanged(join(projectDir, "dependencies.json"), {
        version: 1,
        projectRef: project.ref,
        dependencies: projectDependencies,
      } satisfies DependencyFileSnapshot);

      const tasksRoot = join(projectDir, "tasks");
      const desiredTaskDirs = new Set(projectTasks.map((task) => storeDirName(task.ref)));
      for (const existing of await listChildDirs(tasksRoot)) {
        if (!desiredTaskDirs.has(existing))
          await rm(join(tasksRoot, existing), { recursive: true, force: true });
      }
      for (const task of projectTasks) {
        const taskDir = join(tasksRoot, storeDirName(task.ref));
        await writeJsonFileIfChanged(join(taskDir, "task.json"), taskFileSnapshot(task));
        const runsRoot = join(taskDir, "runs");
        const taskRuns = [...(runsByTask.get(task.ref) ?? [])].sort(compareRef);
        const desiredRunFiles = new Set(taskRuns.map((run) => `${storeDirName(run.ref)}.json`));
        for (const existing of await listJsonFiles(runsRoot)) {
          if (!desiredRunFiles.has(existing)) await rm(join(runsRoot, existing), { force: true });
        }
        for (const run of taskRuns) {
          await writeJsonFileIfChanged(join(runsRoot, `${storeDirName(run.ref)}.json`), {
            version: 2,
            ...run,
          } satisfies RunFileSnapshot);
        }
      }
      const relativeProjectDir = join("projects", projectDirName);
      projectEntries.push({
        projectRef: project.ref,
        path: relativeProjectDir,
        projectPath: join(relativeProjectDir, "project.json"),
        roadmapPath: join(relativeProjectDir, "roadmap.json"),
        dependenciesPath: join(relativeProjectDir, "dependencies.json"),
        tasksPath: join(relativeProjectDir, "tasks"),
        title: project.title,
        updatedAt: project.updatedAt,
        taskCount: projectTasks.length,
        ...(project.currentTaskRef ? { currentTaskRef: project.currentTaskRef } : {}),
      });
    }
    await writeJsonFileIfChanged(join(root, "index.json"), {
      version: 1,
      rebuildable: true,
      generatedAt: nowIso(),
      legacyImportOnly: [".spark/projects.json", ".spark/projects.json.lock/"],
      projects: projectEntries.sort((left, right) =>
        left.projectRef.localeCompare(right.projectRef),
      ),
    } satisfies ProjectIndexSnapshot);
  } finally {
    await releaseProjectLocks();
  }
}

async function readProjectTreeSnapshot(root: string): Promise<LoadedTaskGraphStoreSnapshot | null> {
  const indexPath = join(root, "index.json");
  let indexData: string;
  try {
    indexData = await readFile(indexPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
  const index = parseProjectTreeJson(indexData, indexPath);
  assertPersistedValue(projectIndexSnapshotSchema, index, indexPath);
  const projectDirs = await listProjectDirs(root);
  const projects: PersistedProject[] = [];
  const tasks: Task[] = [];
  const dependencies: TaskDependency[] = [];
  const runs: TaskRun[] = [];
  for (const projectDirName of projectDirs) {
    const projectDir = join(root, projectDirName);
    const projectPath = join(projectDir, "project.json");
    const projectFile = await readProjectTreeJson(projectPath);
    assertPersistedValue(projectFileSnapshotSchema, projectFile, projectPath);
    const roadmapPath = join(projectDir, "roadmap.json");
    const roadmap = await readProjectTreeJson(roadmapPath);
    assertPersistedValue(roadmapFileSnapshotSchema, roadmap, roadmapPath);
    projects.push({
      ...projectFile,
      purpose: projectFile.purpose ?? projectFile.intent,
      roadmap,
    });
    const dependenciesPath = join(projectDir, "dependencies.json");
    const dependencyFile = await readProjectTreeJson(dependenciesPath);
    assertPersistedValue(dependencyFileSnapshotSchema, dependencyFile, dependenciesPath);
    dependencies.push(...dependencyFile.dependencies);
    for (const taskDirName of await listChildDirs(join(projectDir, "tasks"))) {
      const taskDir = join(projectDir, "tasks", taskDirName);
      const taskPath = join(taskDir, "task.json");
      const taskFile = migrateTaskFileSnapshot(await readProjectTreeJson(taskPath), taskPath);
      tasks.push(taskFile);
      for (const runFileName of await listJsonFiles(join(taskDir, "runs"))) {
        const runPath = join(taskDir, "runs", runFileName);
        const run = migrateRunFileSnapshot(await readProjectTreeJson(runPath), runPath);
        runs.push(run);
      }
    }
  }
  const snapshot = serializeTaskGraphStoreSnapshot({
    projects: projects.sort(compareRef),
    tasks: tasks.sort(compareRef),
    dependencies: dependencies.sort(compareDependency),
    runs: runs.sort(compareRef),
  });
  return { snapshot, hash: stableId(formatJsonFile(snapshot)) };
}

function projectFileSnapshot(project: PersistedProject): ProjectFileSnapshot {
  const { roadmap: _roadmap, purpose, ...rest } = project;
  return {
    version: 1,
    ...rest,
    ...(purpose ? { purpose, intent: purpose } : {}),
    roadmapPath: "roadmap.json",
    dependenciesPath: "dependencies.json",
    tasksPath: "tasks",
    reviewPath: "reviews",
  };
}

function taskFileSnapshot(task: Task): TaskFileSnapshot {
  return {
    version: 3,
    ...task,
    todoOwnerRef: task.ref,
    runsPath: "runs",
    reviewsPath: "reviews",
  };
}

function migrateTaskFileSnapshot(raw: Record<string, unknown>, filePath: string): TaskFileSnapshot {
  assertPersistedValue(taskFileInputSchema, raw, filePath);
  const fields: Record<string, unknown> = raw;
  if (raw.version === 3) {
    rejectLegacyEvidenceFields(fields, filePath, ["inputArtifacts", "outputArtifacts"]);
    return {
      ...(raw as unknown as TaskFileSnapshot),
      artifactRefs: persistedArtifactRefs(fields.artifactRefs, filePath),
      inputEvidenceRefs: persistedEvidenceRefs(
        fields.inputEvidenceRefs,
        filePath,
        "inputEvidenceRefs",
        false,
      ),
      outputEvidenceRefs: persistedEvidenceRefs(
        fields.outputEvidenceRefs,
        filePath,
        "outputEvidenceRefs",
        false,
      ),
    };
  }
  if (raw.version === 2) {
    rejectLegacyEvidenceFields(fields, filePath, ["inputArtifacts", "outputArtifacts"]);
    return {
      ...(raw as unknown as Omit<TaskFileSnapshot, "version" | "artifactRefs">),
      version: 3,
      artifactRefs: [],
      inputEvidenceRefs: persistedEvidenceRefs(
        fields.inputEvidenceRefs,
        filePath,
        "inputEvidenceRefs",
        false,
      ),
      outputEvidenceRefs: persistedEvidenceRefs(
        fields.outputEvidenceRefs,
        filePath,
        "outputEvidenceRefs",
        false,
      ),
    };
  }
  if (raw.version !== 1)
    throw new TaskGraphStoreFormatError(filePath, "version must be 1, 2, or 3");
  const { inputArtifacts, outputArtifacts, ...rest } = fields;
  return {
    ...(rest as unknown as Omit<
      TaskFileSnapshot,
      "version" | "artifactRefs" | "inputEvidenceRefs" | "outputEvidenceRefs"
    >),
    version: 3,
    artifactRefs: [],
    inputEvidenceRefs: persistedEvidenceRefs(inputArtifacts, filePath, "inputArtifacts", true),
    outputEvidenceRefs: persistedEvidenceRefs(outputArtifacts, filePath, "outputArtifacts", true),
  };
}

function persistedArtifactRefs(
  value: unknown,
  filePath: string,
): import("@zendev-lab/spark-core").ArtifactRef[] {
  if (!Array.isArray(value))
    throw new TaskGraphStoreFormatError(filePath, "artifactRefs must be an array");
  return value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      !entry.startsWith("artifact:") ||
      entry.length === "artifact:".length
    ) {
      throw new TaskGraphStoreFormatError(
        filePath,
        `artifactRefs[${index}] must be an artifact: ref`,
      );
    }
    return entry as import("@zendev-lab/spark-core").ArtifactRef;
  });
}

function migrateRunFileSnapshot(raw: Record<string, unknown>, filePath: string): RunFileSnapshot {
  assertPersistedValue(runFileInputSchema, raw, filePath);
  const fields: Record<string, unknown> = raw;
  if (raw.version === 2) {
    rejectLegacyEvidenceFields(fields, filePath, ["outputArtifacts"]);
    return {
      ...(raw as unknown as RunFileSnapshot),
      outputEvidenceRefs: persistedEvidenceRefs(
        fields.outputEvidenceRefs,
        filePath,
        "outputEvidenceRefs",
        false,
      ),
      completionSummary: migrateCompletionSummary(fields.completionSummary, filePath, false),
    };
  }
  if (raw.version !== 1) throw new TaskGraphStoreFormatError(filePath, "version must be 1 or 2");
  const { outputArtifacts, ...rest } = fields;
  return {
    ...(rest as unknown as Omit<
      RunFileSnapshot,
      "version" | "outputEvidenceRefs" | "completionSummary"
    >),
    version: 2,
    outputEvidenceRefs: persistedEvidenceRefs(outputArtifacts, filePath, "outputArtifacts", true),
    completionSummary: migrateCompletionSummary(fields.completionSummary, filePath, true),
  };
}

function migrateCompletionSummary(
  value: unknown,
  filePath: string,
  legacy: boolean,
): TaskRun["completionSummary"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskGraphStoreFormatError(filePath, "completionSummary must be an object");
  }
  const summary = value as Record<string, unknown>;
  if (!legacy && "artifactRefs" in summary) {
    throw new TaskGraphStoreFormatError(filePath, "completionSummary.artifactRefs is legacy-only");
  }
  const { artifactRefs, ...rest } = summary;
  return {
    ...(rest as unknown as Omit<NonNullable<TaskRun["completionSummary"]>, "evidenceRefs">),
    evidenceRefs: persistedEvidenceRefs(
      legacy ? artifactRefs : summary.evidenceRefs,
      filePath,
      legacy ? "completionSummary.artifactRefs" : "completionSummary.evidenceRefs",
      legacy,
    ),
  };
}

function persistedEvidenceRefs(
  value: unknown,
  filePath: string,
  field: string,
  migrateArtifactPrefix: boolean,
): import("@zendev-lab/spark-core").EvidenceRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.includes(":")) {
      throw new TaskGraphStoreFormatError(filePath, `${field}[${index}] must be a ref`);
    }
    if (entry.startsWith("evidence:") && entry.length > "evidence:".length) {
      return entry as import("@zendev-lab/spark-core").EvidenceRef;
    }
    if (
      migrateArtifactPrefix &&
      entry.startsWith("artifact:") &&
      entry.length > "artifact:".length
    ) {
      return `evidence:${entry.slice("artifact:".length)}` as import("@zendev-lab/spark-core").EvidenceRef;
    }
    throw new TaskGraphStoreFormatError(filePath, `${field}[${index}] must be an evidence: ref`);
  });
}

function rejectLegacyEvidenceFields(
  raw: Record<string, unknown>,
  filePath: string,
  fields: string[],
): void {
  for (const field of fields) {
    if (field in raw) throw new TaskGraphStoreFormatError(filePath, `${field} is legacy-only`);
  }
}

async function writeJsonFileIfChanged(filePath: string, value: unknown): Promise<void> {
  const next = formatJsonFile(value);
  try {
    if ((await readFile(filePath, "utf8")) === next) return;
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  await writeJsonFileAtomic(filePath, value);
}

async function readProjectTreeJson(filePath: string): Promise<Record<string, unknown>> {
  const data = await readFile(filePath, "utf8");
  return parseProjectTreeJson(data, filePath);
}

function parseProjectTreeJson(text: string, filePath: string): Record<string, unknown> {
  const raw = parseTaskGraphStoreJson(text, filePath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreFormatError(filePath, "JSON root must be an object");
  }
  return raw as Record<string, unknown>;
}

function assertPersistedValue<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  filePath: string,
): asserts value is Static<Schema> {
  const issues = [...Errors(schema, value)];
  if (issues.length === 0) return;
  const details = issues.slice(0, 3).flatMap((issue) => {
    const required =
      issue.keyword === "required" && "requiredProperties" in issue.params
        ? issue.params.requiredProperties
        : undefined;
    if (Array.isArray(required)) {
      return required.map((property) => `.${String(property)} is required`);
    }
    const path = jsonPointerToPropertyPath(issue.instancePath);
    const message = issue.message === "must be array" ? "must be an array" : issue.message;
    return `${path} ${message}`;
  });
  const omitted = issues.length - Math.min(issues.length, 3);
  throw new TaskGraphStoreFormatError(
    filePath,
    `does not match the persisted schema: ${details.join("; ")}${omitted > 0 ? `; ${omitted} additional issue(s) omitted` : ""}`,
  );
}

function jsonPointerToPropertyPath(pointer: string): string {
  if (!pointer) return "$";
  return pointer
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"))
    .map((token) => (/^\d+$/u.test(token) ? `[${token}]` : `.${token}`))
    .join("");
}

async function listProjectDirs(root: string): Promise<string[]> {
  return (await listChildDirs(root)).filter((name) => name.startsWith("proj-"));
}

async function listChildDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

async function listJsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}

function storeDirName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}

async function acquireProjectTreeProjectLocks(
  root: string,
  projectDirNames: string[],
  options: TaskGraphStoreLockOptions,
): Promise<() => Promise<void>> {
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const projectDirName of projectDirNames) {
      releases.push(
        await acquireTaskGraphStoreLock(join(root, "locks", `${projectDirName}.lock`), options),
      );
    }
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
  return async () => {
    for (const release of releases.reverse()) await release();
  };
}

function compareRef<T extends { ref: string }>(left: T, right: T): number {
  return left.ref.localeCompare(right.ref);
}

function compareDependency(left: TaskDependency, right: TaskDependency): number {
  return `${left.taskRef}\0${left.dependsOn}`.localeCompare(`${right.taskRef}\0${right.dependsOn}`);
}

async function acquireTaskGraphStoreLock(
  lockPath: string,
  options: TaskGraphStoreLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? 25);
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  const ownerId = stableId(`${process.pid}:${started}:${randomUUID()}`);
  await mkdir(dirname(lockPath), { recursive: true });
  const ownerPath = join(lockPath, "owner.json");
  const ownerJson = () =>
    `${JSON.stringify(
      {
        ownerId,
        pid: process.pid,
        startedAt: new Date(started).toISOString(),
        heartbeatAt: nowIso(),
      },
      null,
      2,
    )}\n`;

  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      await writeLockOwnerFile(ownerPath, ownerJson());
      const refreshMs =
        staleMs > 0 ? Math.max(1_000, Math.min(30_000, Math.floor(staleMs / 3))) : undefined;
      let heartbeatError: unknown;
      let heartbeatWrite: Promise<void> | undefined;
      const refreshTimer = refreshMs
        ? setInterval(() => {
            heartbeatWrite = writeLockOwnerFile(ownerPath, ownerJson()).catch((error) => {
              heartbeatError = error;
            });
          }, refreshMs)
        : undefined;
      refreshTimer?.unref?.();
      return async () => {
        if (refreshTimer) clearInterval(refreshTimer);
        await heartbeatWrite;
        if (await lockOwnerMatches(ownerPath, ownerId))
          await rm(lockPath, { recursive: true, force: true });
        if (heartbeatError) {
          throw new Error(
            `task graph lock heartbeat failed: ${unknownErrorMessage(heartbeatError)}`,
          );
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleTaskGraphStoreLock(lockPath, staleMs);
      if (Date.now() - started >= timeoutMs) throw new TaskGraphStoreLockTimeoutError(lockPath);
      await delay(retryIntervalMs);
    }
  }
}

async function writeLockOwnerFile(ownerPath: string, data: string): Promise<void> {
  const tempPath = `${ownerPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, ownerPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function removeStaleTaskGraphStoreLock(lockPath: string, staleMs: number): Promise<void> {
  if (staleMs < 0) return;
  try {
    const heartbeatMs = await taskGraphStoreLockHeartbeatMs(lockPath);
    if (Date.now() - heartbeatMs >= staleMs) await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function taskGraphStoreLockHeartbeatMs(lockPath: string): Promise<number> {
  const ownerPath = join(lockPath, "owner.json");
  try {
    const ownerRaw = await readFile(ownerPath, "utf8");
    return parseTaskGraphStoreLockOwner(ownerPath, ownerRaw).heartbeatMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return (await stat(lockPath)).mtimeMs;
  }
}

async function lockOwnerMatches(ownerPath: string, ownerId: string): Promise<boolean> {
  try {
    const owner = parseTaskGraphStoreLockOwner(ownerPath, await readFile(ownerPath, "utf8"));
    return owner.ownerId === ownerId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseTaskGraphStoreLockOwner(
  filePath: string,
  text: string,
): { ownerId: string; heartbeatMs: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TaskGraphStoreLockOwnerFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "JSON root must be an object");
  }
  const owner = raw as Record<string, unknown>;
  if (typeof owner.ownerId !== "string" || !owner.ownerId.trim()) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "ownerId must be a non-empty string");
  }
  if (typeof owner.heartbeatAt !== "string" || !owner.heartbeatAt.trim()) {
    throw new TaskGraphStoreLockOwnerFormatError(
      filePath,
      "heartbeatAt must be a non-empty string",
    );
  }
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    throw new TaskGraphStoreLockOwnerFormatError(filePath, "heartbeatAt must be a valid date");
  }
  return { ownerId: owner.ownerId, heartbeatMs };
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
