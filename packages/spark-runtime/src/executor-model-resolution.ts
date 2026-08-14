import { createHash } from "node:crypto";
import type { RoleRef, Task } from "@zendev-lab/spark-core";
import {
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  modelCatalogPortFromHostRegistry,
  resolveRoleModelSetting,
  type ModelCatalogPort,
  type RoleRegistry,
  type RoleSpec,
} from "@zendev-lab/spark-roles";

export const MODEL_RESOLUTION_UNAVAILABLE = "MODEL_RESOLUTION_UNAVAILABLE";

export type ExecutorModelSource = "project" | "role" | "host" | "explicit" | "resume";

export interface ExecutorModelSnapshot {
  /** Canonical provider/model. */
  model: string;
  providerName: string;
  modelId: string;
  source: ExecutorModelSource;
  /** Content digest of provider/model for resume equality. */
  configDigest: string;
}

export interface ResolveExecutorModelInput {
  cwd: string;
  task: Task;
  registry: RoleRegistry;
  /**
   * Project-level implementation selector (highest precedence after explicit resume).
   * May be bare id or provider/model.
   */
  projectSelector?: string;
  /**
   * Explicit frozen snapshot from a previous paused attempt.
   * When present and still valid, resume reuses it without re-resolving.
   */
  resumeSnapshot?: Pick<ExecutorModelSnapshot, "model" | "source" | "configDigest">;
  /** Host session model (provider/model or bare id). */
  hostModel?: string;
  /** Optional host model registry for bare-id normalization and availability. */
  modelRegistry?: unknown;
  modelCatalog?: ModelCatalogPort;
  /** When true, unavailable/stale models throw MODEL_RESOLUTION_UNAVAILABLE. */
  failClosed?: boolean;
}

export class ModelResolutionUnavailableError extends Error {
  readonly code = MODEL_RESOLUTION_UNAVAILABLE;

  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionUnavailableError";
  }
}

/**
 * Resolve the executor model for TaskRun admission.
 *
 * Precedence (first match wins):
 * 1. resumeSnapshot (same paused run — no silent model swap)
 * 2. projectSelector (implementation selector)
 * 3. role model setting (project store, then user store)
 * 4. hostModel / host registry
 *
 * Bare ids are normalized to provider/model via the host catalog when possible.
 * Fail-closed: throws ModelResolutionUnavailableError when no usable model exists.
 */
export async function resolveExecutorModel(
  input: ResolveExecutorModelInput,
): Promise<ExecutorModelSnapshot> {
  const failClosed = input.failClosed !== false;
  const catalog = input.modelCatalog ?? modelCatalogPortFromHostRegistry(input.modelRegistry);

  if (input.resumeSnapshot?.model?.trim()) {
    const resumed = await normalizeAndValidateModel(input.resumeSnapshot.model, catalog, {
      source: "resume",
      expectedDigest: input.resumeSnapshot.configDigest,
      failClosed,
    });
    if (resumed) return resumed;
    if (failClosed) {
      throw new ModelResolutionUnavailableError(
        `${MODEL_RESOLUTION_UNAVAILABLE}: stale resume model ${input.resumeSnapshot.model} is no longer available or config digest mismatch`,
      );
    }
  }

  const roleRef = taskExecutorRoleRef(input.task);
  const role = input.registry.get(roleRef) as RoleSpec | undefined;

  const candidates: Array<{ raw: string; source: ExecutorModelSource }> = [];
  if (input.projectSelector?.trim()) {
    candidates.push({ raw: input.projectSelector.trim(), source: "project" });
  }

  if (role) {
    const roleModel = await resolveRoleModelSetting({
      roleRef,
      modelType: role.modelType,
      roleId: role.id,
      roleName: role.id,
      projectStore: defaultProjectRoleModelSettingsStore(input.cwd),
      userStore: defaultUserRoleModelSettingsStore(),
    });
    if (roleModel?.model?.trim()) {
      candidates.push({ raw: roleModel.model.trim(), source: "role" });
    }
  }

  if (input.hostModel?.trim()) {
    candidates.push({ raw: input.hostModel.trim(), source: "host" });
  }

  for (const candidate of candidates) {
    const resolved = await normalizeAndValidateModel(candidate.raw, catalog, {
      source: candidate.source,
      failClosed: false,
    });
    if (resolved) return resolved;
  }

  if (failClosed) {
    throw new ModelResolutionUnavailableError(
      `${MODEL_RESOLUTION_UNAVAILABLE}: no usable executor model for task ${input.task.ref} (role ${roleRef}); configure a project selector, role model setting, or host model`,
    );
  }
  throw new ModelResolutionUnavailableError(
    `${MODEL_RESOLUTION_UNAVAILABLE}: executor model resolution failed for ${input.task.ref}`,
  );
}

/**
 * Normalize bare model ids (including aliases such as dsv4flash) to provider/model.
 * When catalog is unavailable, accepts already-canonical provider/model only.
 */
export async function normalizeExecutorModelSelector(
  raw: string,
  catalog?: ModelCatalogPort,
): Promise<{ providerName: string; modelId: string; model: string } | undefined> {
  const value = raw.trim();
  if (!value) return undefined;

  if (value.includes("/")) {
    const slash = value.indexOf("/");
    const providerName = value.slice(0, slash).trim();
    const modelId = value.slice(slash + 1).trim();
    if (!providerName || !modelId) return undefined;
    if (catalog) {
      const entry = await catalog.lookup(`${providerName}/${modelId}`);
      if (!entry) return undefined;
      return {
        providerName: entry.providerName,
        modelId: entry.modelId,
        model: `${entry.providerName}/${entry.modelId}`,
      };
    }
    return { providerName, modelId, model: `${providerName}/${modelId}` };
  }

  // Bare id / alias — require catalog for unambiguous resolution.
  if (!catalog) return undefined;
  const aliasMap: Record<string, string> = {
    dsv4flash: "deepseek-v4-flash",
    "ds-v4-flash": "deepseek-v4-flash",
    deepseekv4flash: "deepseek-v4-flash",
  };
  const bare = aliasMap[value.toLowerCase()] ?? value;

  // Prefer baidu-oneapi when bare deepseek-v4-flash / dsv4flash is requested.
  const preferred = [`baidu-oneapi/${bare}`];
  for (const candidate of preferred) {
    const entry = await catalog.lookup(candidate);
    if (entry) {
      return {
        providerName: entry.providerName,
        modelId: entry.modelId,
        model: `${entry.providerName}/${entry.modelId}`,
      };
    }
  }

  // Fail closed for bare ids the catalog cannot uniquely resolve.
  return undefined;
}

export function executorModelConfigDigest(model: string, _source?: ExecutorModelSource): string {
  // Digest is model-identity only so resume can reuse the original snapshot without
  // treating source labels (project/role/host/resume) as config drift.
  return createHash("sha256")
    .update(JSON.stringify({ model: model.trim() }))
    .digest("hex");
}

export function isModelResolutionUnavailableError(
  error: unknown,
): error is ModelResolutionUnavailableError {
  return (
    error instanceof ModelResolutionUnavailableError ||
    (error instanceof Error &&
      (error as { code?: string }).code === MODEL_RESOLUTION_UNAVAILABLE) ||
    (error instanceof Error && error.message.includes(MODEL_RESOLUTION_UNAVAILABLE))
  );
}

async function normalizeAndValidateModel(
  raw: string,
  catalog: ModelCatalogPort | undefined,
  options: {
    source: ExecutorModelSource;
    expectedDigest?: string;
    failClosed: boolean;
  },
): Promise<ExecutorModelSnapshot | undefined> {
  const normalized = await normalizeExecutorModelSelector(raw, catalog);
  if (!normalized) {
    if (options.failClosed) {
      throw new ModelResolutionUnavailableError(
        `${MODEL_RESOLUTION_UNAVAILABLE}: cannot normalize model selector ${JSON.stringify(raw)}`,
      );
    }
    return undefined;
  }

  if (catalog) {
    const entry = await catalog.lookup(normalized.model);
    if (!entry || !entry.available) {
      if (options.failClosed) {
        throw new ModelResolutionUnavailableError(
          `${MODEL_RESOLUTION_UNAVAILABLE}: model ${normalized.model} is unavailable${
            entry?.unavailableReason ? ` (${entry.unavailableReason})` : ""
          }`,
        );
      }
      return undefined;
    }
  }

  const configDigest = executorModelConfigDigest(normalized.model, options.source);
  if (options.expectedDigest && options.expectedDigest !== configDigest) {
    // Resume source is fixed; digest mismatch means config drift.
    if (options.source === "resume") {
      if (options.failClosed) {
        throw new ModelResolutionUnavailableError(
          `${MODEL_RESOLUTION_UNAVAILABLE}: resume model config digest mismatch for ${normalized.model}`,
        );
      }
      return undefined;
    }
  }

  return {
    model: normalized.model,
    providerName: normalized.providerName,
    modelId: normalized.modelId,
    source: options.source,
    configDigest:
      options.source === "resume" && options.expectedDigest ? options.expectedDigest : configDigest,
  };
}

function taskExecutorRoleRef(task: Task, defaultRoleRef?: RoleRef): RoleRef {
  return task.roleRef ?? defaultRoleRef ?? defaultRoleRefForTaskKind(task.kind);
}

function defaultRoleRefForTaskKind(kind: Task["kind"]): RoleRef {
  if (kind === "research") return "role:builtin-explorer" as RoleRef;
  if (kind === "review") return "role:builtin-reviewer" as RoleRef;
  return "role:builtin-executor" as RoleRef;
}
