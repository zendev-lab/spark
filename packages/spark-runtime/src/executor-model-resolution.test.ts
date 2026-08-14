import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { Task } from "@zendev-lab/spark-core";
import {
  defaultProjectRoleModelSettingsStore,
  type ModelCatalogPort,
  type RoleRegistry,
  type RoleSpec,
} from "@zendev-lab/spark-roles";
import {
  MODEL_RESOLUTION_UNAVAILABLE,
  executorModelConfigDigest,
  isModelResolutionUnavailableError,
  normalizeExecutorModelSelector,
  resolveExecutorModel,
} from "./executor-model-resolution.ts";

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    ref: "task:executor-model-1",
    projectRef: "proj:test",
    name: "executor-model",
    title: "Executor model",
    description: "test",
    kind: "implement",
    status: "ready",
    inputEvidenceRefs: [],
    outputEvidenceRefs: [],
    artifactRefs: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function fakeRegistry(role: Partial<RoleSpec> = {}): RoleRegistry {
  const spec = {
    ref: "role:builtin-executor",
    id: "executor",
    modelType: "implementation",
    source: "builtin",
    revision: "rev",
    capabilities: [],
    systemPrompt: "test",
    ...role,
  } as RoleSpec;
  return {
    get: (roleRef: string) => {
      if (roleRef === spec.ref) return spec;
      throw new Error(`unknown role ${roleRef}`);
    },
  } as RoleRegistry;
}

function catalog(
  entries: Record<string, { available?: boolean; reason?: string }>,
): ModelCatalogPort {
  return {
    lookup: async (model: string) => {
      const entry = entries[model];
      if (!entry) return undefined;
      const slash = model.indexOf("/");
      return {
        providerName: model.slice(0, slash),
        modelId: model.slice(slash + 1),
        available: entry.available !== false,
        ...(entry.reason ? { unavailableReason: entry.reason } : {}),
      };
    },
  };
}

test("normalizes bare dsv4flash from implementation selector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-executor-model-bare-"));
  try {
    const snapshot = await resolveExecutorModel({
      cwd: dir,
      task: fakeTask(),
      registry: fakeRegistry(),
      projectSelector: "dsv4flash",
      modelCatalog: catalog({
        "baidu-oneapi/deepseek-v4-flash": { available: true },
      }),
      failClosed: true,
    });
    assert.equal(snapshot.model, "baidu-oneapi/deepseek-v4-flash");
    assert.equal(snapshot.providerName, "baidu-oneapi");
    assert.equal(snapshot.modelId, "deepseek-v4-flash");
    assert.equal(snapshot.source, "project");
    assert.equal(snapshot.configDigest, executorModelConfigDigest(snapshot.model));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects stale model before claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-executor-model-stale-"));
  try {
    await assert.rejects(
      () =>
        resolveExecutorModel({
          cwd: dir,
          task: fakeTask(),
          registry: fakeRegistry(),
          projectSelector: "missing/model",
          modelCatalog: catalog({}),
          failClosed: true,
        }),
      (error: unknown) => {
        assert.equal(isModelResolutionUnavailableError(error), true);
        assert.match(String((error as Error).message), new RegExp(MODEL_RESOLUTION_UNAVAILABLE));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project selector beats role override beats host model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-executor-model-prec-"));
  try {
    const projectStore = defaultProjectRoleModelSettingsStore(dir);
    await projectStore.save("implementation", "role-provider/role-model");
    const catalogPort = catalog({
      "project-provider/project-model": { available: true },
      "role-provider/role-model": { available: true },
      "host-provider/host-model": { available: true },
    });
    const resolved = await resolveExecutorModel({
      cwd: dir,
      task: fakeTask(),
      registry: fakeRegistry(),
      projectSelector: "project-provider/project-model",
      hostModel: "host-provider/host-model",
      modelCatalog: catalogPort,
      failClosed: true,
    });
    assert.equal(resolved.source, "project");
    assert.equal(resolved.model, "project-provider/project-model");

    const roleOnly = await resolveExecutorModel({
      cwd: dir,
      task: fakeTask(),
      registry: fakeRegistry(),
      hostModel: "host-provider/host-model",
      modelCatalog: catalogPort,
      failClosed: true,
    });
    assert.equal(roleOnly.source, "role");
    assert.equal(roleOnly.model, "role-provider/role-model");

    await rm(projectStore.filePath, { force: true });
    const hostOnly = await resolveExecutorModel({
      cwd: dir,
      task: fakeTask(),
      registry: fakeRegistry(),
      hostModel: "host-provider/host-model",
      modelCatalog: catalogPort,
      failClosed: true,
    });
    assert.equal(hostOnly.source, "host");
    assert.equal(hostOnly.model, "host-provider/host-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume reuses frozen snapshot without silent model swap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-executor-model-resume-"));
  try {
    const model = "baidu-oneapi/deepseek-v4-flash";
    const configDigest = executorModelConfigDigest(model);
    const resumed = await resolveExecutorModel({
      cwd: dir,
      task: fakeTask(),
      registry: fakeRegistry(),
      // Higher-precedence project selector must not override a valid resume snapshot.
      projectSelector: "project-provider/project-model",
      resumeSnapshot: { model, source: "project", configDigest },
      modelCatalog: catalog({
        "baidu-oneapi/deepseek-v4-flash": { available: true },
        "project-provider/project-model": { available: true },
      }),
      failClosed: true,
    });
    assert.equal(resumed.model, model);
    assert.equal(resumed.source, "resume");
    assert.equal(resumed.configDigest, configDigest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizeExecutorModelSelector maps dsv4flash alias", async () => {
  const normalized = await normalizeExecutorModelSelector(
    "dsv4flash",
    catalog({ "baidu-oneapi/deepseek-v4-flash": { available: true } }),
  );
  assert.deepEqual(normalized, {
    providerName: "baidu-oneapi",
    modelId: "deepseek-v4-flash",
    model: "baidu-oneapi/deepseek-v4-flash",
  });
});
