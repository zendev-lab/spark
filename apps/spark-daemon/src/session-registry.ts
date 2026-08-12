import type {
  SparkSessionGetRequest,
  SparkSessionBindRequest,
  SparkSessionCreateRequest,
  SparkSessionListRequest,
  SparkModelRef,
  SparkSessionState,
  SparkSessionScope,
  SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import {
  defaultSparkSessionRegistryRoot,
  SparkSessionRegistry,
  SparkSessionRegistryError,
  type ArchiveSparkSessionInput,
  type CloseSparkSessionInput,
  type ConfigureSparkSideThreadInput,
  type CreateSparkSessionInput,
  type EnsureSparkSideThreadInput,
  type EnsureSparkDriverGenerationSessionInput,
  type ResetSparkSideThreadInput,
  type ResolveBindingInput,
  type SealSparkSessionCloseReceiptInput,
  type TransitionSparkSessionLifecycleInput,
} from "@zendev-lab/spark-session";

/**
 * The daemon-owned session registry surface. Every daemon subsystem that can
 * mutate session state must share one instance so registry.json has one
 * read-modify-write owner inside the process.
 */
export interface DaemonSessionRegistry {
  create(input: SparkSessionCreateRequest): Promise<SparkSessionState>;
  createSupervised(input: CreateSparkSessionInput): Promise<SparkSessionState>;
  list(options?: DaemonSessionListRequest): Promise<SparkSessionState[]>;
  get(sessionId: string): Promise<SparkSessionState | undefined>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionState>;
  unbind(
    sessionId: string,
    externalKey: string,
    adapterAccountIdentity?: string,
  ): Promise<SparkSessionState>;
  archive(input: string | ArchiveSparkSessionInput): Promise<SparkSessionState>;
  /** Supervisor-only close for owned relation Sessions such as Side Threads. */
  archiveOwned(input: ArchiveSparkSessionInput): Promise<SparkSessionState>;
  markClosing(input: TransitionSparkSessionLifecycleInput): Promise<SparkSessionState>;
  sealCloseReceipt(input: SealSparkSessionCloseReceiptInput): Promise<SparkSessionState>;
  restore(sessionId: SparkSessionGetRequest["sessionId"], now?: Date): Promise<SparkSessionState>;
  close(input: CloseSparkSessionInput): Promise<SparkSessionState>;
  finalizeClose(sessionId: string, now?: Date): Promise<SparkSessionState>;
  ensureWorkspaceAdministrator(workspaceId: string): Promise<SparkSessionState>;
  setNameIfMissing(sessionId: string, name: string): Promise<SparkSessionState>;
  setModel(sessionId: string, model: SparkModelRef): Promise<SparkSessionState>;
  setThinkingLevel(
    sessionId: string,
    thinkingLevel: SparkThinkingLevel,
  ): Promise<SparkSessionState>;
  recordTurnQueued(sessionId: string, now?: Date): Promise<SparkSessionState>;
  recordTurnSettled(sessionId: string, now?: Date): Promise<SparkSessionState>;
  recordRun(input: {
    sessionId: string;
    sessionPath: string;
    expectedIncarnation?: number;
    expectedLifecycle?: "open";
    now?: Date;
  }): Promise<SparkSessionState>;
  bindTranscriptPath(input: {
    sessionId: string;
    sessionPath: string;
    expectedIncarnation?: number;
    expectedLifecycle?: "open";
    now?: Date;
  }): Promise<SparkSessionState>;
  relocateTranscriptPath(input: {
    sessionId: string;
    expectedSessionPath?: string;
    sessionPath: string;
    now?: Date;
  }): Promise<SparkSessionState>;
  ensureSideThread(input: EnsureSparkSideThreadInput): Promise<SparkSessionState>;
  ensureDriverGeneration(
    input: EnsureSparkDriverGenerationSessionInput,
  ): Promise<SparkSessionState>;
  resetSideThread(input: ResetSparkSideThreadInput): Promise<SparkSessionState>;
  configureSideThread(input: ConfigureSparkSideThreadInput): Promise<SparkSessionState>;
  resolveBinding(input: ResolveBindingInput): Promise<SparkSessionState>;
}

/** Diagnostic child visibility is daemon-internal and absent from the wire schema. */
export type DaemonSessionListRequest = SparkSessionListRequest & {
  includeClosed?: boolean;
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
  /** Return true for running or Loop-owned sessions that must not be displaced. */
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
    createSupervised: (input) => mutate(() => registry.createSupervised(input)),
    list: (options) => readAfterMutations(() => registry.list(options)),
    get: (sessionId) => readAfterMutations(() => registry.get(sessionId)),
    bind: (input) => mutate(() => registry.bind(input)),
    unbind: (sessionId, externalKey, adapterAccountIdentity) =>
      mutate(() => registry.unbind(sessionId, externalKey, adapterAccountIdentity)),
    archive: (input) => mutate(() => registry.archive(input)),
    archiveOwned: (input) => mutate(() => registry.archiveOwned(input)),
    markClosing: (input) => mutate(() => registry.markClosing(input)),
    sealCloseReceipt: (input) => mutate(() => registry.sealCloseReceipt(input)),
    restore: (sessionId, now) => mutate(() => registry.restore(sessionId, now)),
    close: (input) => mutate(() => registry.close(input)),
    finalizeClose: (sessionId, now) => mutate(() => registry.finalizeClose(sessionId, now)),
    ensureWorkspaceAdministrator: (workspaceId) =>
      mutate(() => registry.ensureWorkspaceAdministrator(workspaceId)),
    setNameIfMissing: (sessionId, name) => mutate(() => registry.setNameIfMissing(sessionId, name)),
    setModel: (sessionId, model) => mutate(() => registry.setModel(sessionId, model)),
    setThinkingLevel: (sessionId, thinkingLevel) =>
      mutate(() => registry.setThinkingLevel(sessionId, thinkingLevel)),
    recordTurnQueued: (sessionId, now) => mutate(() => registry.recordTurnQueued(sessionId, now)),
    recordTurnSettled: (sessionId, now) => mutate(() => registry.recordTurnSettled(sessionId, now)),
    recordRun: (input) => mutate(() => registry.recordRun(input)),
    bindTranscriptPath: (input) => mutate(() => registry.bindTranscriptPath(input)),
    relocateTranscriptPath: (input) => mutate(() => registry.relocateTranscriptPath(input)),
    ensureSideThread: (input) => mutate(() => registry.ensureSideThread(input)),
    ensureDriverGeneration: (input) => mutate(() => registry.ensureDriverGeneration(input)),
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
    create: async (input) =>
      await registry.create(await resolveCreateRequest(registry, input, options)),
    createSupervised: async (input) =>
      await registry.create(await resolveRegistryCreateInput(input, options)),
    list: async (request = {}) => await registry.list(resolveListRequest(request, options)),
    get: async (sessionId) => await registry.get(sessionId),
    bind: async (input) => await registry.bind(input),
    unbind: async (sessionId, externalKey, adapterAccountIdentity) =>
      await registry.unbind(sessionId, externalKey, adapterAccountIdentity),
    archive: async (input) => await registry.archive(input),
    archiveOwned: async (input) => await registry.archiveOwned(input),
    markClosing: async (input) => await registry.markClosing(input),
    sealCloseReceipt: async (input) => await registry.sealCloseReceipt(input),
    restore: async (sessionId, now) => await registry.restore(sessionId, now),
    close: async (input) => await registry.close(input),
    finalizeClose: async (sessionId, now) => await registry.finalizeClose(sessionId, now),
    ensureWorkspaceAdministrator: async (workspaceId) => {
      const cwd = options.resolveWorkspaceCwd?.(workspaceId)?.trim();
      if (options.resolveWorkspaceCwd && !cwd) {
        throw new SparkSessionRegistryError(
          "workspace_cwd_unavailable",
          `workspace ${workspaceId} has no daemon-local execution directory`,
        );
      }
      return await registry.ensureWorkspaceAdministrator({
        workspaceId,
        ...(cwd ? { cwd } : {}),
      });
    },
    setNameIfMissing: async (sessionId, name) => await registry.setNameIfMissing(sessionId, name),
    setModel: async (sessionId, model) => await registry.setModel(sessionId, model),
    setThinkingLevel: async (sessionId, thinkingLevel) =>
      await registry.setThinkingLevel(sessionId, thinkingLevel),
    recordTurnQueued: async (sessionId, now) => await registry.recordTurnQueued(sessionId, now),
    recordTurnSettled: async (sessionId, now) => await registry.recordTurnSettled(sessionId, now),
    recordRun: async (input) => await registry.recordRun(input),
    bindTranscriptPath: async (input) => await registry.bindTranscriptPath(input),
    relocateTranscriptPath: async (input) => await registry.relocateTranscriptPath(input),
    ensureSideThread: async (input) => await registry.ensureSideThread(input),
    ensureDriverGeneration: async (input) => await registry.ensureDriverGeneration(input),
    resetSideThread: async (input) => await registry.resetSideThread(input),
    configureSideThread: async (input) => await registry.configureSideThread(input),
    resolveBinding: async (input) => {
      let create = input.create
        ? await resolveRegistryCreateInput(input.create, options)
        : undefined;
      if (create?.scope?.kind === "workspace") {
        const root = await registry.ensureWorkspaceAdministrator({
          workspaceId: create.scope.workspaceId,
          ...(options.resolveWorkspaceCwd?.(create.scope.workspaceId)
            ? { cwd: options.resolveWorkspaceCwd(create.scope.workspaceId) }
            : {}),
        });
        create = {
          ...create,
          owner: { kind: "session", supervisorSessionId: root.sessionId },
          roleBinding: { kind: "none" },
          stateBinding: { kind: "channel", ref: input.externalKey },
          visibility: "public",
          retention: "retain",
          purpose: "channel",
        };
      }
      return await registry.resolveBinding({
        ...input,
        ...(create ? { create } : {}),
      });
    },
  };
  return createSerializedDaemonSessionRegistry(ownedRegistry);
}

async function resolveCreateRequest(
  registry: SparkSessionRegistry,
  input: SparkSessionCreateRequest,
  options: CreateDaemonSessionRegistryOptions,
): Promise<CreateSparkSessionInput> {
  const taskExecution = "taskExecution" in input ? input.taskExecution : undefined;
  const fleetWorker = "fleetWorker" in input ? input.fleetWorker : undefined;
  const {
    taskExecution: _taskExecution,
    fleetWorker: _fleetWorker,
    placement,
    supervisorSessionId,
    scope,
    ...ordinaryInput
  } = input as SparkSessionCreateRequest & {
    taskExecution?: NonNullable<SparkSessionCreateRequest["taskExecution"]>;
    fleetWorker?: NonNullable<SparkSessionCreateRequest["fleetWorker"]>;
  };
  if (taskExecution && fleetWorker) {
    throw new SparkSessionRegistryError(
      "session_owner_invalid",
      "taskExecution and fleetWorker are mutually exclusive",
    );
  }
  const createInput: Omit<CreateSparkSessionInput, "scope"> = {
    ...ordinaryInput,
    ...(taskExecution
      ? {
          stateBinding: { kind: "task", ref: taskExecution.taskRef } as const,
          visibility: "internal" as const,
          retention: "discard_on_close" as const,
          purpose: taskExecution.ownerKind,
          roleBinding: { kind: "explicit", roleRef: taskExecution.roleRef } as const,
        }
      : fleetWorker
        ? {
            visibility: "internal" as const,
            retention: "retain" as const,
            purpose: "fleet_worker",
            roleBinding: { kind: "explicit", roleRef: fleetWorker.roleRef } as const,
            fleetWorker,
          }
        : {}),
  };
  if (!scope) {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "session create requires an explicit workspace scope",
    );
  }
  let owner: CreateSparkSessionInput["owner"];
  if (taskExecution) {
    const { ownerKind, ...ownerFields } = taskExecution;
    owner = { kind: ownerKind, ...ownerFields } as CreateSparkSessionInput["owner"];
  } else {
    const supervisorId = fleetWorker?.ownerSessionId ?? supervisorSessionId?.trim();
    if (!supervisorId) {
      throw new SparkSessionRegistryError(
        "session_owner_not_found",
        "session create requires supervisorSessionId",
      );
    }
    const supervisor = await registry.get(supervisorId);
    if (!supervisor) {
      throw new SparkSessionRegistryError(
        "session_owner_not_found",
        `unknown supervising Session: ${supervisorId}`,
      );
    }
    if (placement === "sibling") {
      if (supervisor.owner.kind === "workspace") {
        throw new SparkSessionRegistryError(
          "workspace_administrator_session_mutation_forbidden",
          "the Workspace Administrator has no persistent sibling owner",
        );
      }
      owner = supervisor.owner;
    } else {
      owner = { kind: "session", supervisorSessionId: supervisorId };
    }
  }
  return await resolveRegistryCreateInput(
    {
      ...ordinaryInput,
      scope,
      owner,
      placement: "active",
    },
    options,
  );
}

async function resolveRegistryCreateInput(
  input: CreateSparkSessionInput,
  options: CreateDaemonSessionRegistryOptions,
): Promise<CreateSparkSessionInput> {
  const scope = input.scope;
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
    ...(cwd ? { cwd } : {}),
  };
}

function resolveListRequest(
  input: DaemonSessionListRequest,
  options: CreateDaemonSessionRegistryOptions,
): {
  includeArchived?: boolean;
  includeClosed?: boolean;
  includeSideThreads?: boolean;
  query?: string;
  tags?: string[];
  scope?: SparkSessionScope;
} {
  if (!input.scope) return input;
  if (input.scope.kind === "workspace") {
    return {
      ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      ...(input.includeClosed !== undefined ? { includeClosed: input.includeClosed } : {}),
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
    ...(input.includeClosed !== undefined ? { includeClosed: input.includeClosed } : {}),
    ...(input.includeSideThreads !== undefined
      ? { includeSideThreads: input.includeSideThreads }
      : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    scope: { kind: "daemon", daemonId },
  };
}
