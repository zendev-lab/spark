import type {
  SparkSessionGetRequest,
  SparkSessionBindRequest,
  SparkSessionCreateRequest,
  SparkSessionListRequest,
  SparkModelRef,
  SparkSessionRegistryRecord,
  SparkSessionScope,
  SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import {
  defaultSparkSessionRegistryRoot,
  SparkSessionRegistry,
  SparkSessionRegistryError,
  type ArchiveSparkSessionInput,
  type ConfigureSparkSideThreadInput,
  type CreateSparkSessionInput,
  type EnsureSparkSideThreadInput,
  type ResetSparkSideThreadInput,
  type ResolveBindingInput,
} from "@zendev-lab/spark-session";

/**
 * The daemon-owned session registry surface. Every daemon subsystem that can
 * mutate session state must share one instance so registry.json has one
 * read-modify-write owner inside the process.
 */
export interface DaemonSessionRegistry {
  create(input: SparkSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  list(options?: DaemonSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord | undefined>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  unbind(
    sessionId: string,
    externalKey: string,
    adapterAccountIdentity?: string,
  ): Promise<SparkSessionRegistryRecord>;
  archive(input: string | ArchiveSparkSessionInput): Promise<SparkSessionRegistryRecord>;
  restore?(sessionId: SparkSessionGetRequest["sessionId"]): Promise<SparkSessionRegistryRecord>;
  ensureWorkspaceMain(workspaceId: string): Promise<SparkSessionRegistryRecord>;
  setRoleIfMissing?(sessionId: string, role: string): Promise<SparkSessionRegistryRecord>;
  /** @deprecated Compatibility alias for older daemon collaborators. */
  setTitleIfMissing?(sessionId: string, title: string): Promise<SparkSessionRegistryRecord>;
  setModel(sessionId: string, model: SparkModelRef): Promise<SparkSessionRegistryRecord>;
  setThinkingLevel(
    sessionId: string,
    thinkingLevel: SparkThinkingLevel,
  ): Promise<SparkSessionRegistryRecord>;
  recordTurnQueued(sessionId: string, now?: Date): Promise<SparkSessionRegistryRecord>;
  recordTurnSettled(sessionId: string, now?: Date): Promise<SparkSessionRegistryRecord>;
  recordRun(input: {
    sessionId: string;
    sessionPath: string;
    now?: Date;
  }): Promise<SparkSessionRegistryRecord>;
  bindTranscriptPath(input: {
    sessionId: string;
    sessionPath: string;
    now?: Date;
  }): Promise<SparkSessionRegistryRecord>;
  relocateTranscriptPath(input: {
    sessionId: string;
    expectedSessionPath?: string;
    sessionPath: string;
    now?: Date;
  }): Promise<SparkSessionRegistryRecord>;
  ensureSideThread(input: EnsureSparkSideThreadInput): Promise<SparkSessionRegistryRecord>;
  resetSideThread(input: ResetSparkSideThreadInput): Promise<SparkSessionRegistryRecord>;
  configureSideThread(input: ConfigureSparkSideThreadInput): Promise<SparkSessionRegistryRecord>;
  resolveBinding(input: ResolveBindingInput): Promise<SparkSessionRegistryRecord>;
}

/** Diagnostic child visibility is daemon-internal and absent from the wire schema. */
export type DaemonSessionListRequest = SparkSessionListRequest & {
  includeSideThreads?: boolean;
};

export interface CreateDaemonSessionRegistryOptions {
  /** Stable daemon installation identity used only to filter archived legacy records. */
  daemonId?: string;
  /** @deprecated Ignored; daemon-global creation is rejected. */
  daemonCwd?: string;
  /** Resolve a daemon-local path for a canonical or legacy workspace id. */
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
  /** Resolve canonical workspace aliases for role-owner uniqueness. */
  canonicalWorkspaceId?: (workspaceId: string) => string;
  /** Return true for running/driver-owned sessions that must not be displaced. */
  isSessionRoleOwnerProtected?: (sessionId: string) => boolean | Promise<boolean>;
  /** Validate and freeze a session cwd against its owning workspace/GitChange roots. */
  resolveSessionCwd?: (input: {
    workspaceId: string;
    cwd?: string;
    cwdArtifactRef?: string;
  }) => Promise<{ cwd: string; cwdArtifactRef?: string }>;
}

/**
 * Serialize complete registry transitions, including resolveBinding's
 * create-and-bind sequence. Reads wait for earlier mutations so callers never
 * observe an acknowledged transition half-applied.
 */
export function createSerializedDaemonSessionRegistry(
  registry: DaemonSessionRegistry,
): DaemonSessionRegistry {
  let mutationTail: Promise<void> = Promise.resolve();
  const readAfterMutations = async <T>(read: () => Promise<T>): Promise<T> => {
    await mutationTail;
    return await read();
  };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    create: (input) => mutate(() => registry.create(input)),
    list: (options) => readAfterMutations(() => registry.list(options)),
    get: (sessionId) => readAfterMutations(() => registry.get(sessionId)),
    bind: (input) => mutate(() => registry.bind(input)),
    unbind: (sessionId, externalKey, adapterAccountIdentity) =>
      mutate(() => registry.unbind(sessionId, externalKey, adapterAccountIdentity)),
    archive: (input) => mutate(() => registry.archive(input)),
    ...(registry.restore
      ? { restore: (sessionId: string) => mutate(() => registry.restore!(sessionId)) }
      : {}),
    ensureWorkspaceMain: (workspaceId) => mutate(() => registry.ensureWorkspaceMain(workspaceId)),
    ...(registry.setRoleIfMissing
      ? {
          setRoleIfMissing: (sessionId: string, role: string) =>
            mutate(() => registry.setRoleIfMissing!(sessionId, role)),
        }
      : {}),
    ...(registry.setTitleIfMissing
      ? {
          setTitleIfMissing: (sessionId: string, title: string) =>
            mutate(() => registry.setTitleIfMissing!(sessionId, title)),
        }
      : {}),
    setModel: (sessionId, model) => mutate(() => registry.setModel(sessionId, model)),
    setThinkingLevel: (sessionId, thinkingLevel) =>
      mutate(() => registry.setThinkingLevel(sessionId, thinkingLevel)),
    recordTurnQueued: (sessionId, now) => mutate(() => registry.recordTurnQueued(sessionId, now)),
    recordTurnSettled: (sessionId, now) => mutate(() => registry.recordTurnSettled(sessionId, now)),
    recordRun: (input) => mutate(() => registry.recordRun(input)),
    bindTranscriptPath: (input) => mutate(() => registry.bindTranscriptPath(input)),
    relocateTranscriptPath: (input) => mutate(() => registry.relocateTranscriptPath(input)),
    ensureSideThread: (input) => mutate(() => registry.ensureSideThread(input)),
    resetSideThread: (input) => mutate(() => registry.resetSideThread(input)),
    configureSideThread: (input) => mutate(() => registry.configureSideThread(input)),
    resolveBinding: (input) => mutate(() => registry.resolveBinding(input)),
  };
}

export function createDaemonSessionRegistry(
  sparkHome: string,
  options: CreateDaemonSessionRegistryOptions = {},
): DaemonSessionRegistry {
  const registry = new SparkSessionRegistry({
    rootDir: defaultSparkSessionRegistryRoot(sparkHome),
  });
  const ownedRegistry: DaemonSessionRegistry = {
    create: async (input) => await registry.create(await resolveCreateRequest(input, options)),
    list: async (request = {}) => await registry.list(resolveListRequest(request, options)),
    get: async (sessionId) => await registry.get(sessionId),
    bind: async (input) => await registry.bind(input),
    unbind: async (sessionId, externalKey, adapterAccountIdentity) =>
      await registry.unbind(sessionId, externalKey, adapterAccountIdentity),
    archive: async (input) => await registry.archive(input),
    restore: async (sessionId) => await registry.restore(sessionId),
    ensureWorkspaceMain: async (workspaceId) => {
      const cwd = options.resolveWorkspaceCwd?.(workspaceId)?.trim();
      if (options.resolveWorkspaceCwd && !cwd) {
        throw new SparkSessionRegistryError(
          "workspace_cwd_unavailable",
          `workspace ${workspaceId} has no daemon-local execution directory`,
        );
      }
      return await registry.ensureWorkspaceMain({ workspaceId, ...(cwd ? { cwd } : {}) });
    },
    setRoleIfMissing: async (sessionId, role) =>
      await convergeRoleOwner(registry, options, sessionId, role),
    setTitleIfMissing: async (sessionId, title) =>
      await registry.setTitleIfMissing(sessionId, title),
    setModel: async (sessionId, model) => await registry.setModel(sessionId, model),
    setThinkingLevel: async (sessionId, thinkingLevel) =>
      await registry.setThinkingLevel(sessionId, thinkingLevel),
    recordTurnQueued: async (sessionId, now) => await registry.recordTurnQueued(sessionId, now),
    recordTurnSettled: async (sessionId, now) => await registry.recordTurnSettled(sessionId, now),
    recordRun: async (input) => await registry.recordRun(input),
    bindTranscriptPath: async (input) => await registry.bindTranscriptPath(input),
    relocateTranscriptPath: async (input) => await registry.relocateTranscriptPath(input),
    ensureSideThread: async (input) => await registry.ensureSideThread(input),
    resetSideThread: async (input) => await registry.resetSideThread(input),
    configureSideThread: async (input) => await registry.configureSideThread(input),
    resolveBinding: async (input) => {
      const create = input.create
        ? await resolveRegistryCreateInput(input.create, options)
        : undefined;
      return await registry.resolveBinding({
        ...input,
        ...(create ? { create } : {}),
      });
    },
  };
  return createSerializedDaemonSessionRegistry(ownedRegistry);
}

async function convergeRoleOwner(
  registry: SparkSessionRegistry,
  options: CreateDaemonSessionRegistryOptions,
  sessionId: string,
  role: string,
): Promise<SparkSessionRegistryRecord> {
  const target = await registry.get(sessionId);
  const owner = target ? await findRoleOwner(registry, options, target, role) : undefined;
  if (owner && owner.sessionId !== sessionId) {
    if (await options.isSessionRoleOwnerProtected?.(owner.sessionId)) {
      throw new SparkSessionRegistryError(
        "session_role_conflict",
        `session role ${JSON.stringify(role.trim())} already belongs to ${owner.sessionId}; reuse that session or archive it first`,
      );
    }
    await registry.archive({
      sessionId: owner.sessionId,
      source: "role-convergence",
      reason: `role owner superseded by ${sessionId}`,
      tags: ["policy:stable-role-reuse", `superseded-by:${sessionId}`],
    });
  }
  return await registry.setRoleIfMissing(sessionId, role);
}

async function findRoleOwner(
  registry: SparkSessionRegistry,
  options: CreateDaemonSessionRegistryOptions,
  target: SparkSessionRegistryRecord,
  role: string,
): Promise<SparkSessionRegistryRecord | undefined> {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole || target.scope.kind !== "workspace") return undefined;
  const canonicalTarget =
    options.canonicalWorkspaceId?.(target.scope.workspaceId) ?? target.scope.workspaceId;
  const sessions = await registry.list({ includeArchived: false });
  return sessions.find((session) => {
    if (
      session.sessionId === target.sessionId ||
      session.status !== "ready" ||
      session.relation ||
      session.bindings.length > 0
    ) {
      return false;
    }
    if (session.scope.kind !== "workspace") return false;
    const canonicalSession =
      options.canonicalWorkspaceId?.(session.scope.workspaceId) ?? session.scope.workspaceId;
    return canonicalSession === canonicalTarget && normalizeRole(session.role) === normalizedRole;
  });
}

function normalizeRole(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

async function resolveCreateRequest(
  input: SparkSessionCreateRequest,
  options: CreateDaemonSessionRegistryOptions,
): Promise<CreateSparkSessionInput> {
  const taskExecution = "taskExecution" in input ? input.taskExecution : undefined;
  const {
    taskExecution: _taskExecution,
    scope,
    ...ordinaryInput
  } = input as SparkSessionCreateRequest & {
    taskExecution?: NonNullable<SparkSessionCreateRequest["taskExecution"]>;
  };
  const createInput: Omit<CreateSparkSessionInput, "scope"> = {
    ...ordinaryInput,
    ...(taskExecution ? { relation: { kind: "task_execution", ...taskExecution } } : {}),
  };
  if (!scope) return await resolveRegistryCreateInput(createInput, options);
  if (scope.kind === "daemon") {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "New top-level sessions must belong to a workspace.",
    );
  }
  return await resolveRegistryCreateInput(
    {
      ...createInput,
      scope,
      workspaceId: scope.workspaceId,
    },
    options,
  );
}

async function resolveRegistryCreateInput(
  input: CreateSparkSessionInput,
  options: CreateDaemonSessionRegistryOptions,
): Promise<CreateSparkSessionInput> {
  const scope =
    input.scope ??
    (input.workspaceId
      ? ({ kind: "workspace", workspaceId: input.workspaceId } as const)
      : undefined);
  if (!scope) return input;
  if (scope.kind === "daemon") {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "New top-level sessions must belong to a workspace.",
    );
  }
  if (options.resolveSessionCwd) {
    let resolved;
    try {
      resolved = await options.resolveSessionCwd({
        workspaceId: scope.workspaceId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
      });
    } catch (error) {
      if (error instanceof SparkSessionRegistryError) throw error;
      throw new SparkSessionRegistryError(
        "workspace_cwd_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      ...input,
      scope,
      workspaceId: scope.workspaceId,
      cwd: resolved.cwd,
      ...(resolved.cwdArtifactRef ? { cwdArtifactRef: resolved.cwdArtifactRef } : {}),
    };
  }
  if (input.cwdArtifactRef) {
    throw new SparkSessionRegistryError(
      "workspace_cwd_unavailable",
      "GitChange cwd validation is unavailable on this daemon.",
    );
  }
  const resolvedWorkspaceCwd = options.resolveWorkspaceCwd?.(scope.workspaceId)?.trim();
  if (options.resolveWorkspaceCwd && !resolvedWorkspaceCwd) {
    throw new SparkSessionRegistryError(
      "workspace_cwd_unavailable",
      `workspace ${scope.workspaceId} has no daemon-local execution directory`,
    );
  }
  const requestedCwd = input.cwd?.trim();
  if (requestedCwd === "/") {
    throw new SparkSessionRegistryError(
      "workspace_cwd_unavailable",
      `workspace ${scope.workspaceId} cannot use filesystem root as execution directory`,
    );
  }
  // Workspace sessions freeze to the daemon-local workspace path whenever known.
  // Client-supplied cwd is only a fallback when the resolver is not configured.
  const cwd = resolvedWorkspaceCwd || requestedCwd;
  return {
    ...input,
    scope,
    workspaceId: scope.workspaceId,
    ...(cwd ? { cwd } : {}),
  };
}

function resolveListRequest(
  input: DaemonSessionListRequest,
  options: CreateDaemonSessionRegistryOptions,
): {
  includeArchived?: boolean;
  includeSideThreads?: boolean;
  query?: string;
  tags?: string[];
  scope?: SparkSessionScope;
  workspaceId?: string;
} {
  if (!input.scope) return input;
  if (input.scope.kind === "workspace") {
    return {
      ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      ...(input.includeSideThreads !== undefined
        ? { includeSideThreads: input.includeSideThreads }
        : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      scope: input.scope,
    };
  }
  const daemonId = options.daemonId?.trim();
  if (!daemonId) {
    throw new SparkSessionRegistryError(
      "daemon_identity_unavailable",
      "daemon-global session filtering requires a configured installationId",
    );
  }
  return {
    ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
    ...(input.includeSideThreads !== undefined
      ? { includeSideThreads: input.includeSideThreads }
      : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    scope: { kind: "daemon", daemonId },
  };
}
