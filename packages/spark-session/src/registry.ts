import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  channelAdapterFromExternalKey,
  normalizeChannelExternalKey,
  parseSparkSessionState,
  parseSparkSessionStoredRecord,
  sparkSessionLifetimeForOwner,
  sparkSessionCloseReceiptSchema,
  SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT,
  type SparkSessionArchiveEvent,
  type SparkSessionArchiveSource,
  type SparkSessionChannelBinding,
  type SparkSessionCloseReceipt,
  type SparkFleetWorkerBinding,
  type SparkSessionLifecycle,
  type SparkSessionOwner,
  type SparkSessionPlacement,
  type SparkSessionState,
  type SparkEphemeralSessionTombstone,
  type SparkSessionRetention,
  type SparkSessionRoleBinding,
  type SparkSessionScope,
  type SparkSessionStateBinding,
  type SparkSessionVisibility,
  type SparkSideThreadMode,
} from "@zendev-lab/spark-protocol/session-assignment";
import type { SparkRoleModelType } from "@zendev-lab/spark-protocol/role-session";
import type { SparkSessionRegistryErrorCode } from "@zendev-lab/spark-protocol/session-errors";
import type { SparkModelRef, SparkThinkingLevel } from "@zendev-lab/spark-protocol/model-control";

const LEGACY_REGISTRY_VERSIONS = new Set([1, 2, 3, 4, 5]);
export const SPARK_SESSION_REGISTRY_VERSION = 6 as const;

export type SparkSessionUnboundPolicy = "reject" | "create";

export interface SparkSessionRegistryFile {
  version: typeof SPARK_SESSION_REGISTRY_VERSION;
  revision: number;
  sessions: SparkSessionState[];
  tombstones: SparkEphemeralSessionTombstone[];
}

export interface SparkSessionRegistryOptions {
  /** Directory that will contain `registry.json`. */
  rootDir: string;
}

export interface CreateSparkSessionInput {
  sessionId?: string;
  scope: SparkSessionScope;
  name?: string;
  roleBinding?: SparkSessionRoleBinding;
  fleetWorker?: SparkFleetWorkerBinding;
  owner?: SparkSessionOwner;
  stateBinding?: SparkSessionStateBinding;
  visibility?: SparkSessionVisibility;
  retention?: SparkSessionRetention;
  purpose?: string;
  cwd?: string;
  cwdArtifactRef?: string;
  sessionPath?: string;
  transcriptRef?: string;
  lifecycle?: SparkSessionLifecycle;
  placement?: SparkSessionPlacement;
  now?: Date;
}
export interface ArchiveSparkSessionInput {
  sessionId: string;
  source?: SparkSessionArchiveSource;
  reason?: string;
  tags?: string[];
  /** Internal retention CAS; a changed Session is left active. */
  expectedUpdatedAt?: string;
  /** Internal retention guard; only a ready, unassigned, unbound primary Session may archive. */
  requireUnassigned?: boolean;
  /** Daemon supervisor already removed the transcript content. */
  discardTranscript?: boolean;
  now?: Date;
}

export interface TransitionSparkSessionLifecycleInput {
  sessionId: string;
  expectedLifecycle?: "open" | "closing";
  now?: Date;
}

export interface SealSparkSessionCloseReceiptInput {
  sessionId: string;
  expectedIncarnation: number;
  expectedLifecycle: "closing";
  receipt: SparkSessionCloseReceipt;
  now?: Date;
}

export interface CloseSparkSessionInput {
  sessionId: string;
  reason?: string;
  now?: Date;
}

export interface EnsureSparkWorkspaceAdministratorSessionInput {
  workspaceId: string;
  cwd?: string;
  now?: Date;
}
export interface EnsureSparkSideThreadInput {
  parentSessionId: string;
  mode: SparkSideThreadMode;
  sessionId?: string;
  sessionPath?: string;
  now?: Date;
}
export interface EnsureSparkDriverGenerationSessionInput {
  sessionId: string;
  supervisorSessionId: string;
  driverId: string;
  generation: number;
  sessionPath?: string;
  now?: Date;
}
export interface ResetSparkSideThreadInput {
  sessionId: string;
  nextSessionId: string;
  expectedGeneration: number;
  sessionPath: string;
  mode?: SparkSideThreadMode;
  now?: Date;
}
export interface ConfigureSparkSideThreadInput {
  sessionId: string;
  expectedGeneration: number;
  model?: SparkModelRef | null;
  thinkingLevel?: SparkThinkingLevel | null;
  now?: Date;
}

export interface BindSparkSessionInput {
  sessionId: string;
  externalKey: string;
  /** Configured adapter instance that owns this binding. */
  adapterId?: string;
  /** Rename-stable provider account that owns this binding. */
  adapterAccountIdentity?: string;
  /** Internal compatibility gate for claiming a fully unscoped legacy binding. */
  allowLegacyAccountClaim?: boolean;
  now?: Date;
}

export interface RecordSparkSessionRunInput {
  sessionId: string;
  sessionPath: string;
  /** Optional generation fence for work admitted against a durable Session incarnation. */
  expectedIncarnation?: number;
  /** Optional lifecycle fence for mutations that require an open Session. */
  expectedLifecycle?: "open";
  now?: Date;
}

export interface RelocateSparkSessionTranscriptInput extends RecordSparkSessionRunInput {
  expectedSessionPath?: string;
}

export interface ResolveBindingInput {
  externalKey: string;
  /** Configured adapter instance that observed this inbound message. */
  adapterId?: string;
  /** Rename-stable provider account that observed this inbound message. */
  adapterAccountIdentity?: string;
  /** Allow exactly one pre-account binding to be claimed by this account. */
  allowLegacyAccountClaim?: boolean;
  onUnbound?: SparkSessionUnboundPolicy;
  create?: Omit<CreateSparkSessionInput, "sessionId">;
  now?: Date;
}

export class SparkSessionRegistryError extends Error {
  readonly code: SparkSessionRegistryErrorCode;

  constructor(code: SparkSessionRegistryErrorCode, message: string) {
    super(message);
    this.name = "SparkSessionRegistryError";
    this.code = code;
  }
}

export class SparkSessionRegistry {
  readonly rootDir: string;
  readonly filePath: string;
  #migration: Promise<SparkSessionRegistryFile> | undefined;

  constructor(options: SparkSessionRegistryOptions) {
    this.rootDir = options.rootDir;
    this.filePath = join(options.rootDir, "registry.json");
  }

  async create(input: CreateSparkSessionInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const now = (input.now ?? new Date()).toISOString();
    const sessionId = input.sessionId?.trim() || createSessionId();
    if (sessionIdExists(file, sessionId)) {
      throw new SparkSessionRegistryError("session_exists", `session already exists: ${sessionId}`);
    }
    const scope = createScope(input);
    const owner = input.owner ?? requireAdministratorOwner(file.sessions, scope);
    assertOwnerWithinScope(file.sessions, owner, scope, input.cwd, input.cwdArtifactRef);
    if (owner.kind === "workspace") {
      throw new SparkSessionRegistryError(
        "workspace_administrator_session_mutation_forbidden",
        "workspace-owned Sessions are created only by ensureWorkspaceAdministrator()",
      );
    }
    if (
      input.fleetWorker &&
      (owner.kind !== "session" || owner.supervisorSessionId !== input.fleetWorker.ownerSessionId)
    ) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        "Fleet worker binding must match its supervising Session owner",
      );
    }
    const record: SparkSessionState = {
      sessionId,
      scope,
      lifecycle: input.lifecycle ?? "open",
      placement: input.placement ?? "active",
      roleBinding: input.roleBinding ?? { kind: "none" },
      owner,
      incarnation: 1,
      stateBinding:
        input.stateBinding ??
        ({
          kind: "session",
          ref: input.fleetWorker ? sessionId : (ownerSessionId(owner) ?? sessionId),
        } as const),
      visibility: input.visibility ?? (owner.kind === "invocation" ? "internal" : "public"),
      retention: input.retention ?? (owner.kind === "invocation" ? "discard_on_close" : "retain"),
      purpose: input.purpose?.trim() || (owner.kind === "invocation" ? "role_call" : "interactive"),
      bindings: [],
      tags: [],
      archiveHistory: [],
      closeReceipts: [],
      createdAt: now,
      updatedAt: now,
      ...(normalizeSessionName(input.name) ? { name: normalizeSessionName(input.name) } : {}),
      ...inheritedSessionLocation(file.sessions, owner, input.cwd, input.cwdArtifactRef),
      ...(input.fleetWorker ? { fleetWorker: input.fleetWorker } : {}),
      ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
      ...(input.transcriptRef ? { transcriptRef: input.transcriptRef } : {}),
    };
    file.sessions.push(record);
    await this.saveFile(file);
    return record;
  }

  async ensureSideThread(input: EnsureSparkSideThreadInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const parent = requireParent(file.sessions, input.parentSessionId);
    const existing = file.sessions
      .filter(
        (s) =>
          s.owner.kind === "side_thread" &&
          s.owner.parentSessionId === parent.sessionId &&
          s.lifecycle === "open" &&
          s.placement === "active",
      )
      .sort((left, right) => sideThreadGeneration(right) - sideThreadGeneration(left))[0];
    if (existing) return requireChild(existing);
    const sessionId = input.sessionId?.trim() || createSessionId();
    if (sessionIdExists(file, sessionId))
      throw new SparkSessionRegistryError("session_exists", `session already exists: ${sessionId}`);
    const path = input.sessionPath?.trim();
    if (input.sessionPath !== undefined && !path)
      throw new SparkSessionRegistryError(
        "invalid_session_path",
        "side-thread session path must not be blank",
      );
    const now = (input.now ?? new Date()).toISOString();
    const record: SparkSessionState = {
      sessionId,
      scope: parent.scope,
      lifecycle: "open",
      placement: "active",
      roleBinding: { kind: "inherit" },
      incarnation: 1,
      stateBinding: { kind: "session", ref: parent.sessionId },
      visibility: "internal",
      retention: "discard_on_close",
      purpose: "side_thread",
      bindings: [],
      tags: [],
      archiveHistory: [],
      closeReceipts: [],
      createdAt: now,
      updatedAt: now,
      ...(parent.cwd ? { cwd: parent.cwd } : {}),
      ...(parent.cwdArtifactRef ? { cwdArtifactRef: parent.cwdArtifactRef } : {}),
      ...(path ? { sessionPath: path } : {}),
      owner: {
        kind: "side_thread",
        parentSessionId: parent.sessionId,
        generation: 1,
      },
      sideThreadMode: input.mode,
    };
    file.sessions.push(record);
    await this.saveFile(file);
    return record;
  }

  async ensureDriverGeneration(
    input: EnsureSparkDriverGenerationSessionInput,
  ): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const existing = file.sessions.find((session) => session.sessionId === input.sessionId);
    if (existing) {
      if (
        existing.owner.kind !== "driver" ||
        existing.owner.driverId !== input.driverId ||
        existing.owner.generation !== input.generation ||
        existing.owner.supervisorSessionId !== input.supervisorSessionId
      ) {
        throw new SparkSessionRegistryError(
          "session_exists",
          `driver generation Session has conflicting ownership: ${input.sessionId}`,
        );
      }
      return existing;
    }
    const supervisor = requireParent(file.sessions, input.supervisorSessionId);
    const generation = Math.trunc(input.generation);
    if (generation < 1) {
      throw new SparkSessionRegistryError(
        "invalid_registry",
        "driver generation must be a positive integer",
      );
    }
    const now = input.now ?? new Date();
    const record = parseSparkSessionState({
      sessionId: input.sessionId,
      scope: supervisor.scope,
      name: `Driver ${input.driverId} generation ${generation}`,
      lifecycle: "open",
      placement: "active",
      roleBinding: { kind: "inherit" },
      incarnation: 1,
      stateBinding: { kind: "driver", ref: input.driverId },
      visibility: "internal",
      retention: "discard_on_close",
      purpose: "driver_generation",
      owner: {
        kind: "driver",
        driverId: input.driverId,
        generation,
        supervisorSessionId: supervisor.sessionId,
      },
      ...(supervisor.cwd ? { cwd: supervisor.cwd } : {}),
      ...(supervisor.cwdArtifactRef ? { cwdArtifactRef: supervisor.cwdArtifactRef } : {}),
      ...(input.sessionPath?.trim() ? { sessionPath: input.sessionPath.trim() } : {}),
      bindings: [],
      tags: ["internal:driver-generation"],
      archiveHistory: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    file.sessions.push(record);
    await this.saveFile(file);
    return record;
  }

  async ensureWorkspaceAdministrator(
    input: EnsureSparkWorkspaceAdministratorSessionInput,
  ): Promise<SparkSessionState> {
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) {
      throw new SparkSessionRegistryError(
        "invalid_scope",
        "workspace Administrator Session requires workspaceId",
      );
    }
    const file = await this.loadFile();
    const matching = file.sessions.filter(
      (session) =>
        session.scope.kind === "workspace" &&
        session.scope.workspaceId === workspaceId &&
        session.owner.kind === "workspace" &&
        session.owner.workspaceId === workspaceId,
    );
    if (matching.length > 1) {
      throw new SparkSessionRegistryError(
        "invalid_registry",
        `workspace ${workspaceId} has multiple Administrator Sessions`,
      );
    }
    if (matching[0]) return matching[0];

    const now = (input.now ?? new Date()).toISOString();
    const sessionId = createSessionId();
    const record: SparkSessionState = {
      sessionId,
      scope: { kind: "workspace", workspaceId },
      name: "Administrator",
      lifecycle: "open",
      placement: "active",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
      owner: { kind: "workspace", workspaceId },
      incarnation: 1,
      stateBinding: { kind: "session", ref: sessionId },
      visibility: "public",
      retention: "audit",
      purpose: "workspace_administrator",
      closeReceipts: [],
      bindings: [],
      tags: [],
      archiveHistory: [],
      createdAt: now,
      updatedAt: now,
      ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
    };
    file.sessions.push(record);
    await this.saveFile(file);
    return record;
  }

  async resetSideThread(input: ResetSparkSideThreadInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((s) => s.sessionId === input.sessionId);
    if (index < 0)
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    const current = requireSideThreadRecord(file.sessions[index]!);
    assertGeneration(current, input.expectedGeneration);
    const parent = requireParent(file.sessions, current.owner.parentSessionId);
    if (current.lifecycle !== "closed" || current.placement !== "archived") {
      throw new SparkSessionRegistryError(
        "side_thread_busy",
        `side-thread generation ${input.expectedGeneration} must be closed before reset`,
      );
    }
    const nextSessionId = input.nextSessionId.trim();
    if (!nextSessionId) {
      throw new SparkSessionRegistryError(
        "invalid_registry",
        "next side-thread Session id must not be blank",
      );
    }
    if (sessionIdExists(file, nextSessionId)) {
      throw new SparkSessionRegistryError(
        "session_exists",
        `session already exists: ${nextSessionId}`,
      );
    }
    const path = input.sessionPath.trim();
    if (!path)
      throw new SparkSessionRegistryError(
        "invalid_session_path",
        "side-thread session path must not be blank",
      );
    const now = (input.now ?? new Date()).toISOString();
    const updated: SparkSessionState = {
      sessionId: nextSessionId,
      scope: parent.scope,
      lifecycle: "open",
      placement: "active",
      roleBinding: current.roleBinding,
      incarnation: 1,
      stateBinding: current.stateBinding,
      visibility: current.visibility,
      retention: current.retention,
      purpose: current.purpose,
      bindings: [],
      tags: (current.tags ?? []).filter((tag) => !tag.startsWith("lifecycle:")),
      archiveHistory: [],
      closeReceipts: [],
      sessionPath: path,
      owner: {
        ...current.owner,
        generation: current.owner.generation + 1,
      },
      ...(input.mode ? { sideThreadMode: input.mode } : {}),
      ...(current.cwd ? { cwd: current.cwd } : {}),
      ...(current.cwdArtifactRef ? { cwdArtifactRef: current.cwdArtifactRef } : {}),
      ...(current.model ? { model: current.model } : {}),
      ...(current.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {}),
      createdAt: now,
      updatedAt: now,
    };
    file.sessions.push(updated);
    await this.saveFile(file);
    return updated;
  }

  async configureSideThread(input: ConfigureSparkSideThreadInput): Promise<SparkSessionState> {
    if (input.model === undefined && input.thinkingLevel === undefined)
      throw new SparkSessionRegistryError(
        "side_thread_config_empty",
        "side-thread configuration requires an override",
      );
    const file = await this.loadFile();
    const index = file.sessions.findIndex((s) => s.sessionId === input.sessionId);
    if (index < 0)
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    const current = requireChild(file.sessions[index]!);
    assertGeneration(current, input.expectedGeneration);
    requireParent(file.sessions, current.owner.parentSessionId);
    const updated: SparkSessionState = {
      ...current,
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    if (input.model !== undefined) {
      if (input.model === null) delete updated.model;
      else updated.model = { ...input.model };
    }
    if (input.thinkingLevel !== undefined) {
      if (input.thinkingLevel === null) delete updated.thinkingLevel;
      else updated.thinkingLevel = input.thinkingLevel;
    }
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async list(
    options: {
      includeArchived?: boolean;
      includeClosed?: boolean;
      includeSideThreads?: boolean;
      scope?: SparkSessionScope;
      workspaceId?: string;
      query?: string;
      tags?: string[];
    } = {},
  ): Promise<SparkSessionState[]> {
    const file = await this.loadFile();
    return file.sessions
      .filter((session) => {
        if (!options.includeArchived && session.placement === "archived") return false;
        if (!options.includeClosed && session.lifecycle === "closed") return false;
        if (!options.includeSideThreads && session.owner.kind === "side_thread") return false;
        const scope =
          options.scope ??
          (options.workspaceId
            ? ({ kind: "workspace", workspaceId: options.workspaceId } as const)
            : undefined);
        if (scope && !sameSessionScope(session.scope, scope)) return false;
        if (
          options.tags?.length &&
          !options.tags.every((tag) => (session.tags ?? []).includes(tag))
        ) {
          return false;
        }
        if (options.query && !sessionMatchesQuery(session, options.query)) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(sessionId: string): Promise<SparkSessionState | undefined> {
    const file = await this.loadFile();
    return file.sessions.find((session) => session.sessionId === sessionId);
  }

  async require(sessionId: string): Promise<SparkSessionState> {
    const record = await this.get(sessionId);
    if (!record) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    return record;
  }

  async bind(input: BindSparkSessionInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const externalKey = normalizeChannelExternalKey(input.externalKey);
    const adapter = channelAdapterFromExternalKey(externalKey);
    const adapterId = input.adapterId?.trim() || undefined;
    const adapterAccountIdentity = input.adapterAccountIdentity?.trim() || undefined;
    const now = (input.now ?? new Date()).toISOString();
    const existingMatch = selectChannelBinding(file.sessions, {
      externalKey,
      adapterId,
      adapterAccountIdentity,
      // bind() is an explicit ownership operation, so it may upgrade the one
      // legacy unscoped binding selected by the caller's session id.
      allowLegacyAccountClaim: input.allowLegacyAccountClaim !== false,
    });
    const existingOwner = existingMatch?.session;
    if (existingOwner && existingOwner.sessionId !== input.sessionId) {
      throw new SparkSessionRegistryError(
        "binding_conflict",
        `channel binding ${bindingIdentityLabel({ externalKey, adapterAccountIdentity })} already bound to ${existingOwner.sessionId}`,
      );
    }
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `side thread ${input.sessionId} cannot own a channel binding`,
      );
    }
    assertSessionInvocable(current, "bind");
    if (current.placement === "archived") {
      throw new SparkSessionRegistryError(
        "session_archived",
        `cannot bind archived session: ${input.sessionId}`,
      );
    }
    const existingBindingIndex = existingMatch
      ? current.bindings.indexOf(existingMatch.binding)
      : -1;
    if (existingBindingIndex >= 0) {
      const existingBinding = current.bindings[existingBindingIndex]!;
      if (
        !adapterAccountIdentity &&
        adapterId &&
        existingBinding.adapterId &&
        existingBinding.adapterId !== adapterId
      ) {
        throw new SparkSessionRegistryError(
          "binding_conflict",
          `externalKey ${externalKey} is bound through adapter ${existingBinding.adapterId}, not ${adapterId}`,
        );
      }
      const nextBinding: SparkSessionChannelBinding = {
        ...existingBinding,
        ...(adapterId ? { adapterId } : {}),
        ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
      };
      if (
        nextBinding.adapterId === existingBinding.adapterId &&
        nextBinding.adapterAccountIdentity === existingBinding.adapterAccountIdentity
      ) {
        return current;
      }
      const bindings = [...current.bindings];
      bindings[existingBindingIndex] = nextBinding;
      const updated: SparkSessionState = {
        ...current,
        bindings,
        updatedAt: now,
      };
      file.sessions[index] = updated;
      await this.saveFile(file);
      return updated;
    }
    const binding: SparkSessionChannelBinding = {
      kind: "channel",
      adapter,
      ...(adapterId ? { adapterId } : {}),
      ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
      externalKey,
      boundAt: now,
    };
    const updated: SparkSessionState = {
      ...current,
      bindings: [...current.bindings, binding],
      updatedAt: now,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async unbind(
    sessionId: string,
    externalKey: string,
    adapterAccountIdentity?: string,
  ): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const normalized = normalizeChannelExternalKey(externalKey);
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `side thread ${sessionId} cannot own a channel binding`,
      );
    }
    const normalizedAccountIdentity = adapterAccountIdentity?.trim() || undefined;
    const externalMatches = current.bindings.filter(
      (binding) => binding.externalKey === normalized,
    );
    const matchingBindings = normalizedAccountIdentity
      ? externalMatches.filter(
          (binding) => binding.adapterAccountIdentity === normalizedAccountIdentity,
        )
      : externalMatches;
    if (matchingBindings.length === 0) {
      throw new SparkSessionRegistryError(
        "binding_not_found",
        `session ${sessionId} has no binding ${bindingIdentityLabel({
          externalKey: normalized,
          adapterAccountIdentity: normalizedAccountIdentity,
        })}`,
      );
    }
    if (matchingBindings.length > 1) {
      throw new SparkSessionRegistryError(
        "binding_ambiguous",
        `session ${sessionId} has multiple provider accounts bound to ${normalized}`,
      );
    }
    const bindingToRemove = matchingBindings[0]!;
    const nextBindings = current.bindings.filter((binding) => binding !== bindingToRemove);
    const updated: SparkSessionState = {
      ...current,
      bindings: nextBindings,
      updatedAt: new Date().toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async archive(
    input: string | ArchiveSparkSessionInput,
    legacyNow = new Date(),
  ): Promise<SparkSessionState> {
    const archiveInput: ArchiveSparkSessionInput =
      typeof input === "string" ? { sessionId: input, now: legacyNow } : input;
    const { sessionId } = archiveInput;
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (archiveInput.expectedUpdatedAt && current.updatedAt !== archiveInput.expectedUpdatedAt) {
      return current;
    }
    if (archiveInput.requireUnassigned && !isInactiveRetentionCandidate(current)) return current;
    if (current.owner.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `side thread ${sessionId} is archived only with its parent`,
      );
    }
    if (current.owner.kind === "workspace") {
      throw new SparkSessionRegistryError(
        "workspace_administrator_session_mutation_forbidden",
        `workspace Administrator Session ${sessionId} cannot be archived`,
      );
    }
    if (current.bindings.some((binding) => binding.kind === "channel")) {
      throw new SparkSessionRegistryError(
        "session_channel_bound",
        `cannot archive channel-bound session: ${sessionId}`,
      );
    }
    if (current.lifecycle !== "open") {
      throw new SparkSessionRegistryError(
        current.lifecycle === "closing" ? "session_closing" : "session_closed",
        `cannot archive ${current.lifecycle} session: ${sessionId}`,
      );
    }
    if (current.placement === "archived") return current;
    const now = archiveInput.now ?? new Date();
    const archiveEvent = createArchiveEvent(current, archiveInput, now);
    const updated: SparkSessionState = {
      ...current,
      placement: "archived",
      tags: mergeSessionTags(current.tags ?? [], archiveEvent.tags),
      archiveHistory: [...(current.archiveHistory ?? []), archiveEvent],
      updatedAt: now.toISOString(),
    };
    if (archiveInput.discardTranscript) {
      delete updated.sessionPath;
      delete updated.transcriptRef;
    }
    file.sessions[index] = updated;
    beginCloseDescendants(
      file.sessions,
      current.sessionId,
      now,
      `owner archived: ${current.sessionId}`,
    );
    await this.saveFile(file);
    return updated;
  }

  /**
   * Daemon-Supervisor-only close transition for an owned Session. Public
   * archive deliberately keeps rejecting Side Threads so they cannot bypass
   * their dedicated surface.
   */
  async archiveOwned(input: ArchiveSparkSessionInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    if (sparkSessionLifetimeForOwner(current.owner) === "persistent") {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `managed close requires a scoped or ephemeral Session: ${input.sessionId}`,
      );
    }
    if (current.lifecycle === "closed") return current;
    const now = input.now ?? new Date();
    const archiveEvent = createArchiveEvent(current, input, now);
    const updated: SparkSessionState = {
      ...current,
      lifecycle: "closed",
      placement: "archived",
      tags: mergeSessionTags(current.tags ?? [], archiveEvent.tags),
      archiveHistory: [...(current.archiveHistory ?? []), archiveEvent],
      updatedAt: now.toISOString(),
    };
    if (input.discardTranscript || current.retention === "discard_on_close") {
      delete updated.sessionPath;
      delete updated.transcriptRef;
    }
    if (current.owner.kind === "invocation") {
      file.sessions.splice(index, 1);
      file.tombstones.push({
        recordKind: "ephemeral_tombstone",
        sessionId: current.sessionId,
        scope: current.scope,
        owner: current.owner,
        lifecycle: "closed",
        placement: "archived",
        closeReceipts: updated.closeReceipts ?? [],
        createdAt: current.createdAt,
        updatedAt: updated.updatedAt,
      });
    } else {
      file.sessions[index] = updated;
    }
    await this.saveFile(file);
    return updated;
  }

  async markClosing(input: TransitionSparkSessionLifecycleInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    if (current.lifecycle === "closed") return current;
    if (input.expectedLifecycle && current.lifecycle !== input.expectedLifecycle) return current;
    const updated: SparkSessionState = {
      ...current,
      lifecycle: "closing",
      updatedAt: (input.now ?? new Date()).toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /** Persist one immutable close receipt before any content-bearing store is purged. */
  async sealCloseReceipt(input: SealSparkSessionCloseReceiptInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    const incarnation = current.incarnation ?? 1;
    const existing = current.closeReceipts?.find(
      (receipt) => receipt.incarnation === input.expectedIncarnation,
    );
    if (existing) return current;
    if (
      incarnation !== input.expectedIncarnation ||
      current.lifecycle !== input.expectedLifecycle
    ) {
      throw new SparkSessionRegistryError(
        "session_registry_conflict",
        `session ${input.sessionId} close receipt fence no longer matches incarnation ${input.expectedIncarnation}`,
      );
    }
    const receipt = sparkSessionCloseReceiptSchema.parse(input.receipt);
    if (receipt.incarnation !== incarnation) {
      throw new SparkSessionRegistryError(
        "session_registry_conflict",
        `session ${input.sessionId} receipt incarnation ${receipt.incarnation} does not match ${incarnation}`,
      );
    }
    const closeReceipts = [...(current.closeReceipts ?? []), receipt].slice(
      -SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT,
    );
    const sealedAt = (input.now ?? new Date(receipt.createdAt)).toISOString();
    const updated: SparkSessionState = {
      ...current,
      closeReceipts,
      updatedAt: sealedAt > current.updatedAt ? sealedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async restore(sessionId: string, now = new Date()): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `side thread ${sessionId} cannot be restored independently`,
      );
    }
    if (current.owner.kind === "workspace") {
      throw new SparkSessionRegistryError(
        "workspace_administrator_session_mutation_forbidden",
        `workspace Administrator Session ${sessionId} cannot be restored`,
      );
    }
    if (current.lifecycle !== "open") {
      throw new SparkSessionRegistryError(
        current.lifecycle === "closing" ? "session_closing" : "session_closed",
        `cannot restore ${current.lifecycle} session: ${sessionId}`,
      );
    }
    if (current.placement !== "archived") return current;
    const updated: SparkSessionState = {
      ...current,
      placement: "active",
      tags: mergeSessionTags(current.tags ?? [], ["lifecycle:restored"]),
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async close(input: CloseSparkSessionInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "workspace") {
      throw new SparkSessionRegistryError(
        "workspace_administrator_session_mutation_forbidden",
        `workspace Administrator Session ${input.sessionId} cannot be closed`,
      );
    }
    if (current.lifecycle === "closed") return current;
    if (current.lifecycle === "closing") return current;
    const now = input.now ?? new Date();
    const closing: SparkSessionState = {
      ...current,
      lifecycle: "closing",
      tags: mergeSessionTags(current.tags ?? [], [
        `close-reason:${encodeSessionTagValue(input.reason ?? "explicit close").slice(0, 96)}`,
      ]),
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = closing;
    beginCloseDescendants(file.sessions, current.sessionId, now, input.reason ?? "owner closed");
    await this.saveFile(file);
    return closing;
  }

  async finalizeClose(sessionId: string, now = new Date()): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "workspace") {
      throw new SparkSessionRegistryError(
        "workspace_administrator_session_mutation_forbidden",
        `workspace Administrator Session ${sessionId} cannot be closed`,
      );
    }
    if (current.lifecycle === "closed") return current;
    if (current.lifecycle !== "closing") {
      throw new SparkSessionRegistryError(
        "session_closing",
        `session ${sessionId} must enter closing before it can be finalized`,
      );
    }
    finalizeCloseDescendants(file.sessions, current.sessionId, now);
    const closed: SparkSessionState = {
      ...current,
      lifecycle: "closed",
      placement: "archived",
      bindings: [],
      tags: mergeSessionTags(current.tags ?? [], ["lifecycle:closed"]),
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = closed;
    await this.saveFile(file);
    return closed;
  }

  /** Assign a display name without mutating the Role binding. */
  async setNameIfMissing(
    sessionId: string,
    name: string,
    now = new Date(),
  ): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (
      current.name?.trim() ||
      current.owner.kind === "side_thread" ||
      current.bindings.some((binding) => binding.kind === "channel") ||
      current.placement === "archived" ||
      current.lifecycle !== "open"
    ) {
      return current;
    }
    const normalizedName = normalizeSessionName(name);
    if (!normalizedName) {
      throw new SparkSessionRegistryError(
        "invalid_session_name",
        `session name must not be blank: ${sessionId}`,
      );
    }
    const observedAt = now.toISOString();
    const updated: SparkSessionState = {
      ...current,
      name: normalizedName,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async setModel(
    sessionId: string,
    model: SparkModelRef,
    now = new Date(),
  ): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `configure side-thread model through the side-thread control surface: ${sessionId}`,
      );
    }
    assertSessionInvocable(current, "change model for");
    const updated: SparkSessionState = {
      ...current,
      model: { ...model },
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async setThinkingLevel(
    sessionId: string,
    thinkingLevel: NonNullable<SparkSessionState["thinkingLevel"]>,
    now = new Date(),
  ): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `configure side-thread thinking through the side-thread control surface: ${sessionId}`,
      );
    }
    assertSessionInvocable(current, "change thinking level for");
    const updated: SparkSessionState = {
      ...current,
      thinkingLevel,
      updatedAt: now.toISOString(),
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /**
   * Record the durable native transcript produced by a completed turn.
   * Re-applying the same path is safe; the supplied observation time is kept
   * monotonic so a delayed retry cannot move the session backwards.
   */
  async recordRun(input: RecordSparkSessionRunInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    assertSessionRunFence(current, input);
    const sessionPath = normalizedSessionPath(input.sessionPath, input.sessionId);
    if (
      current.sessionPath &&
      normalizedSessionPath(current.sessionPath, input.sessionId) !== sessionPath
    ) {
      throw new SparkSessionRegistryError(
        "session_transcript_conflict",
        `session ${input.sessionId} is already bound to ${current.sessionPath}`,
      );
    }
    const observedAt = (input.now ?? new Date()).toISOString();
    const updated: SparkSessionState = {
      ...current,
      sessionPath,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /** Bind a recovered or preallocated transcript without changing run status. */
  async bindTranscriptPath(input: RecordSparkSessionRunInput): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    assertSessionRunFence(current, input);
    const sessionPath = normalizedSessionPath(input.sessionPath, input.sessionId);
    if (current.sessionPath) {
      if (normalizedSessionPath(current.sessionPath, input.sessionId) !== sessionPath) {
        throw new SparkSessionRegistryError(
          "session_transcript_conflict",
          `session ${input.sessionId} is already bound to ${current.sessionPath}`,
        );
      }
      return current;
    }
    const observedAt = (input.now ?? new Date()).toISOString();
    const updated: SparkSessionState = {
      ...current,
      sessionPath,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  /**
   * Explicit transcript relocation used by daemon-owned repair tooling.
   * Ordinary run completion must never use this path-changing operation.
   */
  async relocateTranscriptPath(
    input: RelocateSparkSessionTranscriptInput,
  ): Promise<SparkSessionState> {
    const file = await this.loadFile();
    const index = file.sessions.findIndex((session) => session.sessionId === input.sessionId);
    if (index < 0) {
      throw new SparkSessionRegistryError(
        "session_not_found",
        `unknown session: ${input.sessionId}`,
      );
    }
    const current = file.sessions[index]!;
    if (current.owner.kind === "side_thread") {
      throw new SparkSessionRegistryError(
        "side_thread_mutation_forbidden",
        `relocate side-thread transcript through its generation control: ${input.sessionId}`,
      );
    }
    const expectedPath = input.expectedSessionPath
      ? normalizedSessionPath(input.expectedSessionPath, input.sessionId)
      : undefined;
    const currentPath = current.sessionPath
      ? normalizedSessionPath(current.sessionPath, input.sessionId)
      : undefined;
    if (currentPath !== expectedPath) {
      throw new SparkSessionRegistryError(
        "session_transcript_cas_failed",
        `session ${input.sessionId} transcript changed before relocation`,
      );
    }
    const sessionPath = normalizedSessionPath(input.sessionPath, input.sessionId);
    const observedAt = (input.now ?? new Date()).toISOString();
    const updated: SparkSessionState = {
      ...current,
      sessionPath,
      updatedAt: observedAt > current.updatedAt ? observedAt : current.updatedAt,
    };
    file.sessions[index] = updated;
    await this.saveFile(file);
    return updated;
  }

  async recordTurnQueued(sessionId: string, now = new Date()): Promise<SparkSessionState> {
    void now;
    const session = await this.require(sessionId);
    assertSessionInvocable(session, "queue an Invocation for");
    return session;
  }

  async recordTurnSettled(sessionId: string, now = new Date()): Promise<SparkSessionState> {
    void now;
    return await this.require(sessionId);
  }

  async resolveBinding(input: ResolveBindingInput): Promise<SparkSessionState> {
    const externalKey = normalizeChannelExternalKey(input.externalKey);
    const adapterId = input.adapterId?.trim() || undefined;
    const adapterAccountIdentity = input.adapterAccountIdentity?.trim() || undefined;
    const file = await this.loadFile();
    const existingMatch = selectChannelBinding(file.sessions, {
      externalKey,
      adapterId,
      adapterAccountIdentity,
      allowLegacyAccountClaim: input.allowLegacyAccountClaim === true,
    });
    const existing = existingMatch?.session;
    if (existing) {
      assertSessionInvocable(existing, "route to");
      if (!adapterId && !adapterAccountIdentity) return existing;
      return await this.bind({
        sessionId: existing.sessionId,
        externalKey,
        ...(adapterId ? { adapterId } : {}),
        ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
        now: input.now,
      });
    }
    const policy = input.onUnbound ?? "reject";
    if (policy === "reject") {
      throw new SparkSessionRegistryError("binding_unbound", `no session bound to ${externalKey}`);
    }
    if (!input.create) {
      throw new SparkSessionRegistryError(
        "create_required",
        `onUnbound=create requires create input for ${externalKey}`,
      );
    }
    const created = await this.create({ ...input.create, now: input.now });
    return await this.bind({
      sessionId: created.sessionId,
      externalKey,
      ...(adapterId ? { adapterId } : {}),
      ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
      // resolveBinding already decided that this account has no owner. Do not
      // let the lower-level bind step silently claim a different legacy row.
      allowLegacyAccountClaim: false,
      now: input.now,
    });
  }

  private async loadFile(): Promise<SparkSessionRegistryFile> {
    try {
      const source = await readFile(this.filePath, "utf8");
      const raw = JSON.parse(source) as unknown;
      if (registryVersion(raw) === SPARK_SESSION_REGISTRY_VERSION) {
        const current = parseRegistryFile(raw);
        validateRegistryOwnership(current.sessions);
        return current;
      }
      if (!this.#migration) {
        this.#migration = migrateLegacyRegistryFile({
          rootDir: this.rootDir,
          filePath: this.filePath,
          source,
          raw,
        }).finally(() => {
          this.#migration = undefined;
        });
      }
      return await this.#migration;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          version: SPARK_SESSION_REGISTRY_VERSION,
          revision: 0,
          sessions: [],
          tombstones: [],
        };
      }
      throw error;
    }
  }

  private async saveFile(file: SparkSessionRegistryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let currentRevision = 0;
    try {
      const current = parseRegistryFile(
        JSON.parse(await readFile(this.filePath, "utf8")) as unknown,
      );
      currentRevision = current.revision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentRevision !== file.revision) {
      throw new SparkSessionRegistryError(
        "session_registry_conflict",
        `session registry revision changed: expected ${file.revision}, found ${currentRevision}`,
      );
    }
    const next: SparkSessionRegistryFile = {
      version: SPARK_SESSION_REGISTRY_VERSION,
      revision: file.revision + 1,
      // Validate the stored shape before touching the current atomic file.
      sessions: file.sessions.map(parseSparkSessionState),
      tombstones: file.tombstones,
    };
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const stored = {
      version: next.version,
      revision: next.revision,
      sessions: [...next.sessions, ...next.tombstones].map(parseSparkSessionStoredRecord),
    };
    await writeFile(tempPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
    const readback = parseRegistryFile(
      JSON.parse(await readFile(this.filePath, "utf8")) as unknown,
    );
    const expected = parseRegistryFile(stored);
    if (JSON.stringify(readback) !== JSON.stringify(expected)) {
      throw new SparkSessionRegistryError(
        "invalid_registry",
        `session registry write readback mismatch: ${this.filePath}`,
      );
    }
    file.revision = next.revision;
  }
}

export function defaultSparkSessionRegistryRoot(sparkHome: string): string {
  // Keep the established directory so existing installations are migrated in
  // place; registry.json carries its own independently versioned file format.
  return join(sparkHome, "session-registry", "v1");
}

function parseRegistryFile(value: unknown): SparkSessionRegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SparkSessionRegistryError("invalid_registry", "registry root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SPARK_SESSION_REGISTRY_VERSION) {
    throw new SparkSessionRegistryError(
      "invalid_registry",
      `session registry read received version ${String(record.version)}; supported version is ${SPARK_SESSION_REGISTRY_VERSION}; restore the latest migration backup and restart the daemon to retry`,
    );
  }
  if (!Array.isArray(record.sessions)) {
    throw new SparkSessionRegistryError("invalid_registry", "sessions must be an array");
  }
  if (
    record.version === SPARK_SESSION_REGISTRY_VERSION &&
    (!Number.isInteger(record.revision) || Number(record.revision) < 0)
  ) {
    throw new SparkSessionRegistryError(
      "invalid_registry",
      "registry v6 revision must be a non-negative integer",
    );
  }
  const storedRecords = record.sessions.map(parseSparkSessionStoredRecord);
  return {
    version: SPARK_SESSION_REGISTRY_VERSION,
    revision: record.version === SPARK_SESSION_REGISTRY_VERSION ? Number(record.revision) : 0,
    sessions: storedRecords.filter((entry): entry is SparkSessionState => !("recordKind" in entry)),
    tombstones: storedRecords.filter(
      (entry): entry is SparkEphemeralSessionTombstone => "recordKind" in entry,
    ),
  };
}

function registryVersion(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>).version;
  return typeof version === "number" && Number.isInteger(version) ? version : undefined;
}

function sessionIdExists(file: SparkSessionRegistryFile, sessionId: string): boolean {
  return (
    file.sessions.some((session) => session.sessionId === sessionId) ||
    file.tombstones.some((session) => session.sessionId === sessionId)
  );
}

async function migrateLegacyRegistryFile(input: {
  rootDir: string;
  filePath: string;
  source: string;
  raw: unknown;
}): Promise<SparkSessionRegistryFile> {
  const version = registryVersion(input.raw);
  if (version === undefined || !LEGACY_REGISTRY_VERSIONS.has(version)) {
    throw new SparkSessionRegistryError(
      "invalid_registry",
      `session registry migration source ${input.source} received version ${String(version)}; supported legacy versions are ${[...LEGACY_REGISTRY_VERSIONS].join(", ")}; restore an eligible registry backup and restart the daemon to retry`,
    );
  }
  if (!input.raw || typeof input.raw !== "object" || Array.isArray(input.raw)) {
    throw new SparkSessionRegistryError("invalid_registry", "registry root must be an object");
  }
  const rawSessions = (input.raw as Record<string, unknown>).sessions;
  if (!Array.isArray(rawSessions)) {
    throw new SparkSessionRegistryError("invalid_registry", "sessions must be an array");
  }
  const migratedAt = new Date().toISOString();
  const suffix = migratedAt.replaceAll(/[:.]/gu, "-");
  const migrationDir = join(input.rootDir, `migration-v${version}-to-v6-${suffix}`);
  const backupPath = join(migrationDir, "registry.json.backup");
  const stagedPath = join(migrationDir, "registry.json.staged");
  const journalPath = join(migrationDir, "journal.json");
  await mkdir(migrationDir, { recursive: true });
  await writeFile(backupPath, input.source, "utf8");
  await writeFile(
    journalPath,
    `${JSON.stringify(
      {
        version: 1,
        state: "staging",
        sourceVersion: version,
        targetVersion: SPARK_SESSION_REGISTRY_VERSION,
        sourcePath: input.filePath,
        backupPath,
        stagedPath,
        migratedAt,
        recoveryCommand: `cp -- ${JSON.stringify(backupPath)} ${JSON.stringify(input.filePath)}`,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  try {
    const migrated = migrateLegacyRegistryRecords(rawSessions, migratedAt);
    validateRegistryOwnership(migrated.sessions);
    const staged = `${JSON.stringify(
      {
        version: migrated.version,
        revision: migrated.revision,
        sessions: migrated.sessions,
      },
      null,
      2,
    )}\n`;
    await writeFile(stagedPath, staged, "utf8");
    const readback = parseRegistryFile(JSON.parse(await readFile(stagedPath, "utf8")) as unknown);
    validateRegistryOwnership(readback.sessions);
    await rename(stagedPath, input.filePath);
    await writeFile(
      journalPath,
      `${JSON.stringify(
        {
          version: 1,
          state: "complete",
          sourceVersion: version,
          targetVersion: SPARK_SESSION_REGISTRY_VERSION,
          sourcePath: input.filePath,
          backupPath,
          migratedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return readback;
  } catch (error) {
    const recoveryCommand = `cp -- ${JSON.stringify(backupPath)} ${JSON.stringify(input.filePath)}`;
    await writeFile(
      journalPath,
      `${JSON.stringify(
        {
          version: 1,
          state: "failed",
          sourceVersion: version,
          targetVersion: SPARK_SESSION_REGISTRY_VERSION,
          sourcePath: input.filePath,
          backupPath,
          migratedAt,
          error: error instanceof Error ? error.message : String(error),
          recoveryCommand,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    throw new SparkSessionRegistryError(
      "invalid_registry",
      `session registry migration failed; daemon service is disabled. Restore with: ${recoveryCommand}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function migrateLegacyRegistryRecords(
  rawSessions: unknown[],
  migratedAt: string,
): SparkSessionRegistryFile {
  const records = rawSessions.map(requireLegacySessionRecord);
  const workspaceIds = new Set(
    records.flatMap((record) => {
      const workspaceId = legacyWorkspaceId(record);
      return workspaceId ? [workspaceId] : [];
    }),
  );
  const administratorByWorkspace = new Map<string, string>();
  for (const workspaceId of workspaceIds) {
    const candidates = records
      .filter(
        (record) =>
          legacyWorkspaceId(record) === workspaceId &&
          (legacyRelation(record)?.kind === "workspace_main" ||
            legacyOwner(record)?.kind === "workspace"),
      )
      .sort((left, right) =>
        legacyCreatedAt(left, migratedAt).localeCompare(legacyCreatedAt(right, migratedAt)),
      );
    if (candidates.length > 1) {
      throw new Error(`workspace ${workspaceId} has multiple legacy Administrator Sessions`);
    }
    administratorByWorkspace.set(
      workspaceId,
      legacyString(candidates[0]?.sessionId) ?? `administrator:${workspaceId}`,
    );
  }
  const sessions: SparkSessionState[] = [];
  for (const workspaceId of workspaceIds) {
    const administratorId = administratorByWorkspace.get(workspaceId)!;
    if (!records.some((record) => legacyString(record.sessionId) === administratorId)) {
      sessions.push(
        parseSparkSessionState({
          sessionId: administratorId,
          scope: { kind: "workspace", workspaceId },
          name: "Administrator",
          lifecycle: "open",
          placement: "active",
          roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
          owner: { kind: "workspace", workspaceId },
          incarnation: 1,
          stateBinding: { kind: "session", ref: administratorId },
          visibility: "public",
          retention: "audit",
          purpose: "workspace_administrator",
          bindings: [],
          tags: ["migration:administrator-provisioned"],
          archiveHistory: [],
          createdAt: migratedAt,
          updatedAt: migratedAt,
        }),
      );
    }
  }
  for (const record of records) {
    const sessionId = legacyRequiredString(record.sessionId, "sessionId");
    const workspaceId = legacyWorkspaceId(record);
    const relation = legacyRelation(record);
    const isFleetWorker = relation?.kind === "fleet_worker";
    const isAdministrator =
      workspaceId !== undefined && administratorByWorkspace.get(workspaceId) === sessionId;
    const scope = workspaceId
      ? { kind: "workspace" as const, workspaceId }
      : { kind: "daemon" as const, daemonId: legacyDaemonId(record) };
    const roleCandidate = legacyString(record.role) ?? legacyString(record.title);
    const priorRoleBinding = legacyRoleBinding(record);
    const mappedRoleRef =
      mapLegacyStructuredRoleRef(legacyString(record.roleRef)) ??
      mapLegacyStructuredRoleRef(roleCandidate) ??
      (priorRoleBinding?.kind === "explicit"
        ? mapLegacyStructuredRoleRef(legacyString(priorRoleBinding.roleRef))
        : undefined);
    const priorOwner = legacyOwner(record);
    const owner: SparkSessionOwner = isAdministrator
      ? { kind: "workspace", workspaceId: workspaceId! }
      : priorOwner
        ? migrateV5Owner(priorOwner)
        : relation?.kind === "side_thread"
          ? {
              kind: "side_thread",
              parentSessionId: legacyRequiredString(relation.parentSessionId, "parentSessionId"),
              generation: legacyPositiveInteger(relation.generation, "generation"),
            }
          : relation?.kind === "task_execution"
            ? legacyTaskRunOwner(relation)
            : isFleetWorker
              ? {
                  kind: "session",
                  supervisorSessionId: legacyRequiredString(
                    relation.ownerSessionId,
                    "ownerSessionId",
                  ),
                }
              : workspaceId
                ? {
                    kind: "session",
                    supervisorSessionId: administratorByWorkspace.get(workspaceId)!,
                  }
                : {
                    kind: "invocation",
                    invocationId: `migration:${sessionId}`,
                    supervisorSessionId: "migration:closed-daemon-audit",
                  };
    const roleBinding = isAdministrator
      ? ({ kind: "explicit", roleRef: "role:builtin-administrator" } as const)
      : relation?.kind === "side_thread"
        ? ({ kind: "inherit" } as const)
        : priorRoleBinding?.kind === "inherit"
          ? ({ kind: "inherit" } as const)
          : mappedRoleRef === "role:builtin-administrator"
            ? ({ kind: "none" } as const)
            : mappedRoleRef
              ? ({ kind: "explicit", roleRef: mappedRoleRef } as const)
              : ({ kind: "none" } as const);
    const naturalRoleName = roleCandidate && !mappedRoleRef ? roleCandidate : undefined;
    const legacyTitle = legacyString(record.name) ?? legacyString(record.title);
    const name = isAdministrator
      ? "Administrator"
      : (naturalRoleName ??
        (legacyTitle && !mapLegacyStructuredRoleRef(legacyTitle) ? legacyTitle : undefined));
    const placement =
      (record.status === "archived" || record.placement === "archived") && !isAdministrator
        ? "archived"
        : scope.kind === "daemon"
          ? "archived"
          : "active";
    const closeReceipts = Array.isArray(record.closeReceipts) ? record.closeReceipts : [];
    const lifecycle =
      scope.kind === "daemon"
        ? "closed"
        : record.lifecycle === "closing"
          ? "closing"
          : record.lifecycle === "closed"
            ? "closed"
            : "open";
    const retention = isAdministrator
      ? "audit"
      : scope.kind === "daemon"
        ? "audit"
        : owner.kind === "session" && Array.isArray(record.bindings) && record.bindings.length > 0
          ? "retain"
          : owner.kind === "session"
            ? "retain"
            : "discard_on_close";
    sessions.push(
      parseSparkSessionState({
        sessionId,
        scope,
        ...(name ? { name } : {}),
        lifecycle,
        placement,
        roleBinding,
        owner,
        incarnation:
          typeof record.incarnation === "number" && Number.isInteger(record.incarnation)
            ? record.incarnation
            : 1,
        stateBinding: isAdministrator
          ? { kind: "session", ref: sessionId }
          : isFleetWorker
            ? { kind: "session", ref: sessionId }
            : owner.kind === "task_run" || owner.kind === "task_revision"
              ? { kind: "task", ref: owner.taskRef }
              : owner.kind === "driver" || owner.kind === "driver_tick"
                ? { kind: "driver", ref: owner.driverId }
                : { kind: "session", ref: ownerSessionId(owner) ?? sessionId },
        visibility:
          isAdministrator || (owner.kind === "session" && !isFleetWorker) ? "public" : "internal",
        retention,
        purpose: isAdministrator
          ? "workspace_administrator"
          : isFleetWorker
            ? "fleet_worker"
            : `migration_${owner.kind}`,
        ...(owner.kind === "side_thread"
          ? {
              sideThreadMode:
                record.sideThreadMode === "tangent" || relation?.mode === "tangent"
                  ? "tangent"
                  : "contextual",
            }
          : {}),
        ...(isFleetWorker
          ? {
              fleetWorker: legacyFleetWorkerBinding(relation),
            }
          : {}),
        ...(legacyString(record.cwd) ? { cwd: legacyString(record.cwd) } : {}),
        ...(legacyString(record.cwdArtifactRef)
          ? { cwdArtifactRef: legacyString(record.cwdArtifactRef) }
          : {}),
        ...(legacyString(record.sessionPath)
          ? { sessionPath: legacyString(record.sessionPath) }
          : {}),
        ...(record.model ? { model: record.model } : {}),
        ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
        bindings: Array.isArray(record.bindings) ? record.bindings : [],
        tags: mergeSessionTags(Array.isArray(record.tags) ? record.tags.map(String) : [], [
          `migration:registry-v6`,
          `migrated-at:${migratedAt.slice(0, 10)}`,
        ]),
        archiveHistory: Array.isArray(record.archiveHistory) ? record.archiveHistory : [],
        closeReceipts,
        createdAt: legacyCreatedAt(record, migratedAt),
        updatedAt: migratedAt,
      }),
    );
  }
  closeMigratedDescendantsOfUnavailableOwners(sessions, migratedAt);
  return {
    version: SPARK_SESSION_REGISTRY_VERSION,
    revision: 0,
    sessions,
    tombstones: [],
  };
}

function requireLegacySessionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy session record must be an object");
  }
  return value as Record<string, unknown>;
}

function legacyRelation(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return record.relation && typeof record.relation === "object" && !Array.isArray(record.relation)
    ? (record.relation as Record<string, unknown>)
    : undefined;
}

function legacyOwner(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return record.owner && typeof record.owner === "object" && !Array.isArray(record.owner)
    ? (record.owner as Record<string, unknown>)
    : undefined;
}

function legacyRoleBinding(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return record.roleBinding &&
    typeof record.roleBinding === "object" &&
    !Array.isArray(record.roleBinding)
    ? (record.roleBinding as Record<string, unknown>)
    : undefined;
}

function migrateV5Owner(owner: Record<string, unknown>): SparkSessionOwner {
  switch (owner.kind) {
    case "workspace":
      return {
        kind: "workspace",
        workspaceId: legacyRequiredString(owner.workspaceId, "owner.workspaceId"),
      };
    case "session":
      return {
        kind: "session",
        supervisorSessionId: legacyRequiredString(
          owner.supervisorSessionId,
          "owner.supervisorSessionId",
        ),
      };
    case "side_thread":
      return {
        kind: "side_thread",
        parentSessionId: legacyRequiredString(owner.parentSessionId, "owner.parentSessionId"),
        generation: legacyPositiveInteger(owner.generation, "owner.generation"),
      };
    case "task_run":
      return {
        kind: "task_run",
        supervisorSessionId: legacyRequiredString(
          owner.supervisorSessionId,
          "owner.supervisorSessionId",
        ),
        projectRef: legacyRequiredString(owner.projectRef, "owner.projectRef"),
        taskRef: legacyRequiredString(owner.taskRef, "owner.taskRef"),
        runRef: legacyRequiredString(owner.runRef, "owner.runRef"),
        sessionGoalId: legacyRequiredString(owner.sessionGoalId, "owner.sessionGoalId"),
        ...(legacyString(owner.subgoalRef) ? { subgoalRef: legacyString(owner.subgoalRef) } : {}),
        roleRef: mapLegacyStructuredRoleRef(legacyRequiredString(owner.roleRef, "owner.roleRef"))!,
        ...(typeof owner.planRevision === "number"
          ? { planRevision: legacyPositiveInteger(owner.planRevision, "owner.planRevision") }
          : {}),
        ...(legacyString(owner.definitionDigest)
          ? { definitionDigest: legacyString(owner.definitionDigest) }
          : {}),
        jobId: legacyRequiredString(owner.jobId, "owner.jobId"),
        attempt: legacyPositiveInteger(owner.attempt, "owner.attempt"),
      };
    case "driver_generation":
      return {
        kind: "driver",
        driverId: legacyRequiredString(owner.driverId, "owner.driverId"),
        generation: legacyPositiveInteger(owner.generation, "owner.generation"),
        supervisorSessionId: legacyRequiredString(
          owner.supervisorSessionId,
          "owner.supervisorSessionId",
        ),
      };
    case "invocation":
      return {
        kind: "invocation",
        invocationId: legacyRequiredString(owner.invocationId, "owner.invocationId"),
        supervisorSessionId: legacyRequiredString(
          owner.supervisorSessionId,
          "owner.supervisorSessionId",
        ),
      };
    default:
      throw new Error(`unsupported registry v5 owner kind: ${String(owner.kind)}`);
  }
}

function legacyWorkspaceId(record: Record<string, unknown>): string | undefined {
  const scope =
    record.scope && typeof record.scope === "object" && !Array.isArray(record.scope)
      ? (record.scope as Record<string, unknown>)
      : undefined;
  return scope?.kind === "workspace"
    ? legacyString(scope.workspaceId)
    : legacyString(record.workspaceId);
}

function legacyDaemonId(record: Record<string, unknown>): string {
  const scope =
    record.scope && typeof record.scope === "object" && !Array.isArray(record.scope)
      ? (record.scope as Record<string, unknown>)
      : undefined;
  return legacyString(scope?.daemonId) ?? "legacy-daemon";
}

function legacyTaskRunOwner(relation: Record<string, unknown>): SparkSessionOwner {
  return {
    kind: "task_run",
    supervisorSessionId: legacyRequiredString(relation.ownerSessionId, "ownerSessionId"),
    projectRef: legacyRequiredString(relation.projectRef, "projectRef"),
    taskRef: legacyRequiredString(relation.taskRef, "taskRef"),
    runRef: legacyRequiredString(relation.runRef, "runRef"),
    sessionGoalId: legacyRequiredString(relation.sessionGoalId, "sessionGoalId"),
    ...(legacyString(relation.subgoalRef) ? { subgoalRef: legacyString(relation.subgoalRef) } : {}),
    roleRef: mapLegacyStructuredRoleRef(legacyRequiredString(relation.roleRef, "roleRef"))!,
    ...(typeof relation.planRevision === "number"
      ? { planRevision: legacyPositiveInteger(relation.planRevision, "planRevision") }
      : {}),
    ...(legacyString(relation.definitionDigest)
      ? { definitionDigest: legacyString(relation.definitionDigest) }
      : {}),
    jobId: legacyRequiredString(relation.jobId, "jobId"),
    attempt: legacyPositiveInteger(relation.attempt, "attempt"),
  };
}

function legacyFleetWorkerBinding(relation: Record<string, unknown>): SparkFleetWorkerBinding {
  const primaryArtifactRef = legacyRequiredString(
    relation.primaryArtifactRef,
    "primaryArtifactRef",
  );
  const writableArtifactRefs = Array.isArray(relation.writableArtifactRefs)
    ? relation.writableArtifactRefs.map((value, index) =>
        legacyRequiredString(value, `writableArtifactRefs[${index}]`),
      )
    : [];
  return {
    ownerSessionId: legacyRequiredString(relation.ownerSessionId, "ownerSessionId"),
    projectRef: legacyRequiredString(relation.projectRef, "projectRef"),
    roleRef:
      mapLegacyStructuredRoleRef(legacyRequiredString(relation.roleRef, "roleRef")) ??
      "role:builtin-executor",
    laneKey: legacyRequiredString(relation.laneKey, "laneKey"),
    primaryArtifactRef,
    writableArtifactRefs,
  };
}

function mapLegacyStructuredRoleRef(value: string | undefined): string | undefined {
  if (!value?.startsWith("role:")) return undefined;
  if (value === "role:builtin-scout" || value === "role:builtin-researcher") {
    return "role:builtin-explorer";
  }
  if (value === "role:builtin-worker") return "role:builtin-executor";
  return value;
}

function legacyCreatedAt(record: Record<string, unknown>, fallback: string): string {
  return legacyString(record.createdAt) ?? fallback;
}

function legacyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function legacyRequiredString(value: unknown, field: string): string {
  const result = legacyString(value);
  if (!result) throw new Error(`legacy session ${field} is required`);
  return result;
}

function legacyPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`legacy session ${field} must be a positive integer`);
  }
  return value;
}

function closeMigratedDescendantsOfUnavailableOwners(
  sessions: SparkSessionState[],
  migratedAt: string,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index]!;
      if (session.lifecycle === "closed" || session.owner.kind === "workspace") continue;
      const supervisorId = ownerSessionId(session.owner);
      const supervisor = sessions.find((candidate) => candidate.sessionId === supervisorId);
      if (!supervisor || supervisor.lifecycle !== "open" || supervisor.placement === "archived") {
        sessions[index] = {
          ...session,
          lifecycle: "closed",
          placement: "archived",
          bindings: [],
          updatedAt: migratedAt,
        };
        changed = true;
      }
    }
  }
}

function validateRegistryOwnership(sessions: SparkSessionState[]): void {
  const byId = new Map<string, SparkSessionState>();
  for (const session of sessions) {
    if (byId.has(session.sessionId)) throw new Error(`duplicate Session id: ${session.sessionId}`);
    byId.set(session.sessionId, session);
  }
  const workspaceIds = new Set(
    sessions.flatMap((session) =>
      session.scope.kind === "workspace" ? [session.scope.workspaceId] : [],
    ),
  );
  for (const workspaceId of workspaceIds) {
    const administrators = sessions.filter(
      (session) =>
        session.scope.kind === "workspace" &&
        session.scope.workspaceId === workspaceId &&
        session.owner.kind === "workspace",
    );
    if (administrators.length !== 1) {
      throw new Error(`workspace ${workspaceId} must have exactly one Administrator Session`);
    }
  }
  for (const session of sessions) {
    if (session.scope.kind === "daemon" || session.owner.kind === "workspace") continue;
    const seen = new Set([session.sessionId]);
    let current: SparkSessionState | undefined = session;
    while (current && current.owner.kind !== "workspace") {
      const supervisorId = ownerSessionId(current.owner);
      if (!supervisorId) break;
      if (seen.has(supervisorId)) throw new Error(`Session owner cycle: ${session.sessionId}`);
      seen.add(supervisorId);
      const supervisor = byId.get(supervisorId);
      if (!supervisor) throw new Error(`Session owner is missing: ${supervisorId}`);
      if (!sameSessionScope(session.scope, supervisor.scope)) {
        throw new Error(`Session owner scope mismatch: ${session.sessionId}`);
      }
      if (session.cwdArtifactRef && session.cwdArtifactRef !== supervisor.cwdArtifactRef) {
        throw new Error(`Session GitChange boundary widened: ${session.sessionId}`);
      }
      if (
        session.cwd &&
        supervisor.cwd &&
        !isPathWithin(resolve(session.cwd), resolve(supervisor.cwd))
      ) {
        throw new Error(`Session cwd boundary widened: ${session.sessionId}`);
      }
      current = supervisor;
    }
  }
}

function createSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createScope(
  input: CreateSparkSessionInput,
): Extract<SparkSessionScope, { kind: "workspace" }> {
  if (input.scope.kind !== "workspace") {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "New top-level sessions must belong to a workspace.",
    );
  }
  return input.scope;
}

function requireAdministratorOwner(
  sessions: SparkSessionState[],
  scope: SparkSessionScope,
): SparkSessionOwner {
  if (scope.kind !== "workspace") {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "new executable Sessions must belong to a Workspace Administrator",
    );
  }
  const administrators = sessions.filter(
    (session) =>
      session.scope.kind === "workspace" &&
      session.scope.workspaceId === scope.workspaceId &&
      session.owner.kind === "workspace" &&
      session.lifecycle === "open",
  );
  if (administrators.length !== 1) {
    throw new SparkSessionRegistryError(
      "session_owner_not_found",
      `workspace ${scope.workspaceId} requires exactly one Administrator Session`,
    );
  }
  return { kind: "session", supervisorSessionId: administrators[0]!.sessionId };
}

function ownerSessionId(owner: SparkSessionOwner): string | undefined {
  switch (owner.kind) {
    case "workspace":
      return undefined;
    case "side_thread":
      return owner.parentSessionId;
    default:
      return owner.supervisorSessionId;
  }
}

function assertOwnerWithinScope(
  sessions: SparkSessionState[],
  owner: SparkSessionOwner,
  scope: SparkSessionScope,
  cwd: string | undefined,
  cwdArtifactRef: string | undefined,
): void {
  const supervisorId = ownerSessionId(owner);
  if (!supervisorId) return;
  const supervisor = sessions.find((session) => session.sessionId === supervisorId);
  if (!supervisor) {
    throw new SparkSessionRegistryError(
      "session_owner_not_found",
      `unknown Session owner: ${supervisorId}`,
    );
  }
  assertSessionInvocable(supervisor, "own another Session from");
  if (!sameSessionScope(supervisor.scope, scope)) {
    throw new SparkSessionRegistryError(
      "session_owner_scope_mismatch",
      `Session owner ${supervisorId} belongs to a different scope`,
    );
  }
  if (supervisor.cwdArtifactRef && cwdArtifactRef !== supervisor.cwdArtifactRef) {
    throw new SparkSessionRegistryError(
      "session_owner_scope_mismatch",
      "child Session cannot change its owner's GitChange boundary",
    );
  }
  if (cwd && supervisor.cwd && !isPathWithin(resolve(cwd), resolve(supervisor.cwd))) {
    throw new SparkSessionRegistryError(
      "session_owner_scope_mismatch",
      `child cwd must remain inside owner cwd ${supervisor.cwd}`,
    );
  }
}

function inheritedSessionLocation(
  sessions: SparkSessionState[],
  owner: SparkSessionOwner,
  cwd: string | undefined,
  cwdArtifactRef: string | undefined,
): Pick<SparkSessionState, "cwd" | "cwdArtifactRef"> {
  const supervisorId = ownerSessionId(owner);
  const supervisor = supervisorId
    ? sessions.find((session) => session.sessionId === supervisorId)
    : undefined;
  const effectiveCwd = cwd?.trim() || supervisor?.cwd;
  const effectiveArtifactRef = cwdArtifactRef?.trim() || supervisor?.cwdArtifactRef;
  return {
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    ...(effectiveArtifactRef ? { cwdArtifactRef: effectiveArtifactRef } : {}),
  };
}

function isPathWithin(candidate: string, boundary: string): boolean {
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

function assertSessionInvocable(session: SparkSessionState, action: string): void {
  if (session.lifecycle !== "open") {
    throw new SparkSessionRegistryError(
      session.lifecycle === "closing" ? "session_closing" : "session_closed",
      `cannot ${action} ${session.lifecycle} Session ${session.sessionId}`,
    );
  }
  if (session.placement === "archived") {
    throw new SparkSessionRegistryError(
      "session_archived",
      `cannot ${action} archived Session ${session.sessionId}`,
    );
  }
}

function beginCloseDescendants(
  sessions: SparkSessionState[],
  parentSessionId: string,
  now: Date,
  reason: string,
): void {
  for (let index = 0; index < sessions.length; index += 1) {
    const child = sessions[index]!;
    if (ownerSessionId(child.owner) !== parentSessionId || child.lifecycle === "closed") continue;
    beginCloseDescendants(sessions, child.sessionId, now, reason);
    sessions[index] = {
      ...child,
      lifecycle: "closing",
      tags: mergeSessionTags(child.tags ?? [], [
        `owner:${encodeSessionTagValue(parentSessionId)}`,
        `close-reason:${encodeSessionTagValue(reason).slice(0, 96)}`,
      ]),
      updatedAt: now.toISOString(),
    };
  }
}

function finalizeCloseDescendants(
  sessions: SparkSessionState[],
  parentSessionId: string,
  now: Date,
): void {
  for (let index = 0; index < sessions.length; index += 1) {
    const child = sessions[index]!;
    if (ownerSessionId(child.owner) !== parentSessionId || child.lifecycle === "closed") continue;
    finalizeCloseDescendants(sessions, child.sessionId, now);
    sessions[index] = {
      ...child,
      lifecycle: "closed",
      placement: "archived",
      bindings: [],
      tags: mergeSessionTags(child.tags ?? [], ["lifecycle:closed"]),
      updatedAt: now.toISOString(),
    };
  }
}

function requireParent(
  sessions: SparkSessionState[],
  sessionId: string,
): SparkSessionState & {
  scope: Extract<SparkSessionScope, { kind: "workspace" }>;
} {
  const parent = sessions.find((s) => s.sessionId === sessionId);
  if (!parent)
    throw new SparkSessionRegistryError(
      "side_thread_parent_not_found",
      `unknown side-thread parent: ${sessionId}`,
    );
  if (parent.owner.kind === "side_thread")
    throw new SparkSessionRegistryError(
      "side_thread_nesting_forbidden",
      "a side thread cannot be parented by a side thread",
    );
  if (parent.scope.kind !== "workspace") {
    throw new SparkSessionRegistryError(
      "session_owner_scope_mismatch",
      "a side thread requires a Workspace-owned parent",
    );
  }
  assertSessionInvocable(parent, "parent a side thread from");
  if (parent.placement === "archived")
    throw new SparkSessionRegistryError(
      "side_thread_parent_archived",
      `archived parent: ${sessionId}`,
    );
  return parent as SparkSessionState & {
    scope: Extract<SparkSessionScope, { kind: "workspace" }>;
  };
}
function requireChild(session: SparkSessionState): SparkSessionState & {
  owner: Extract<SparkSessionOwner, { kind: "side_thread" }>;
} {
  if (session.owner.kind !== "side_thread")
    throw new SparkSessionRegistryError(
      "side_thread_not_found",
      `not a side thread: ${session.sessionId}`,
    );
  if (session.placement === "archived")
    throw new SparkSessionRegistryError(
      "side_thread_archived",
      `archived side thread: ${session.sessionId}`,
    );
  assertSessionInvocable(session, "use");
  return session as SparkSessionState & {
    owner: Extract<SparkSessionOwner, { kind: "side_thread" }>;
  };
}
function requireSideThreadRecord(session: SparkSessionState): SparkSessionState & {
  owner: Extract<SparkSessionOwner, { kind: "side_thread" }>;
} {
  if (session.owner.kind !== "side_thread") {
    throw new SparkSessionRegistryError(
      "side_thread_not_found",
      `not a side thread: ${session.sessionId}`,
    );
  }
  return session as SparkSessionState & {
    owner: Extract<SparkSessionOwner, { kind: "side_thread" }>;
  };
}

function sideThreadGeneration(session: SparkSessionState): number {
  return session.owner.kind === "side_thread" ? session.owner.generation : 0;
}
function assertGeneration(
  session: SparkSessionState & {
    owner: Extract<SparkSessionOwner, { kind: "side_thread" }>;
  },
  expected: number,
): void {
  if (session.owner.generation !== expected)
    throw new SparkSessionRegistryError(
      "side_thread_generation_conflict",
      `expected generation ${expected}, found ${session.owner.generation}`,
    );
}

function sameSessionScope(left: SparkSessionScope, right: SparkSessionScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "workspace"
    ? left.workspaceId === (right as Extract<SparkSessionScope, { kind: "workspace" }>).workspaceId
    : left.daemonId === (right as Extract<SparkSessionScope, { kind: "daemon" }>).daemonId;
}

function normalizeSessionName(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function isInactiveRetentionCandidate(session: SparkSessionState): boolean {
  return (
    session.lifecycle === "open" &&
    session.placement === "active" &&
    session.owner.kind !== "workspace" &&
    session.roleBinding.kind === "none" &&
    !session.name?.trim() &&
    session.bindings.length === 0
  );
}

function createArchiveEvent(
  session: SparkSessionState,
  input: Omit<ArchiveSparkSessionInput, "sessionId" | "now">,
  now: Date,
): SparkSessionArchiveEvent {
  const source = input.source ?? "manual";
  const tags = [
    `archive-source:${source}`,
    `archived:${now.toISOString().slice(0, 7)}`,
    `scope:${session.scope.kind}`,
    ...(session.scope.kind === "workspace"
      ? [`workspace:${encodeSessionTagValue(session.scope.workspaceId)}`]
      : [`daemon:${encodeSessionTagValue(session.scope.daemonId)}`]),
    ...(session.roleBinding.kind === "explicit"
      ? [`role:${encodeSessionTagValue(session.roleBinding.roleRef)}`]
      : [`role:${session.roleBinding.kind}`]),
    `owner:${session.owner.kind}`,
    ...(input.tags ?? []),
  ];
  return {
    archivedAt: now.toISOString(),
    source,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    tags: mergeSessionTags([], tags),
  };
}

function mergeSessionTags(current: readonly string[], additions: readonly string[]): string[] {
  return [...new Set([...current, ...additions].map(normalizeSessionTag))];
}

function normalizeSessionTag(value: string): string {
  const tag = value.trim();
  if (!tag || tag.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(tag)) {
    throw new SparkSessionRegistryError(
      "invalid_session_tag",
      "session tag must be 1-128 characters without whitespace or controls",
    );
  }
  return tag;
}

function encodeSessionTagValue(value: string): string {
  return encodeURIComponent(value.trim());
}

function sessionMatchesQuery(session: SparkSessionState, rawQuery: string): boolean {
  const terms = rawQuery.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    session.sessionId,
    session.name,
    session.roleBinding.kind === "explicit"
      ? session.roleBinding.roleRef
      : session.roleBinding.kind,
    session.owner.kind,
    session.cwd,
    session.sessionPath,
    session.scope.kind === "workspace" ? session.scope.workspaceId : session.scope.daemonId,
    ...(session.tags ?? []),
    ...(session.archiveHistory ?? []).flatMap((event) => [
      event.source,
      event.reason,
      ...event.tags,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function normalizedSessionPath(value: string, sessionId: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new SparkSessionRegistryError(
      "invalid_session_path",
      `session path must not be blank: ${sessionId}`,
    );
  }
  return resolve(normalized);
}

function assertSessionRunFence(
  current: SparkSessionState,
  input: RecordSparkSessionRunInput,
): void {
  if (
    input.expectedIncarnation !== undefined &&
    (current.incarnation ?? 1) !== input.expectedIncarnation
  ) {
    throw new SparkSessionRegistryError(
      "session_transcript_cas_failed",
      `session ${input.sessionId} incarnation changed before transcript mutation`,
    );
  }
  if (
    input.expectedLifecycle !== undefined &&
    (current.lifecycle !== input.expectedLifecycle || current.placement !== "active")
  ) {
    throw new SparkSessionRegistryError(
      "session_transcript_cas_failed",
      `session ${input.sessionId} lifecycle or placement changed before transcript mutation`,
    );
  }
}

interface ChannelBindingSelector {
  externalKey: string;
  adapterId?: string;
  adapterAccountIdentity?: string;
  allowLegacyAccountClaim?: boolean;
}

interface SelectedChannelBinding {
  session: SparkSessionState;
  binding: SparkSessionChannelBinding;
}

/**
 * Select one channel binding without ever guessing between provider accounts.
 *
 * Modern callers use the rename-stable account identity. A legacy binding that
 * already recorded the same configured adapter can be upgraded safely. A fully
 * unscoped legacy binding is claimable only when the caller has independently
 * established that this is the sole configured account of that platform type.
 */
function selectChannelBinding(
  sessions: SparkSessionState[],
  selector: ChannelBindingSelector,
): SelectedChannelBinding | undefined {
  const matches = sessions.flatMap((session) =>
    session.bindings
      .filter((binding) => binding.externalKey === selector.externalKey)
      .map((binding) => ({ session, binding })),
  );
  if (selector.adapterAccountIdentity) {
    const exact = matches.filter(
      ({ binding }) => binding.adapterAccountIdentity === selector.adapterAccountIdentity,
    );
    if (exact.length > 1) throwAmbiguousBinding(selector);
    if (exact[0]) return exact[0];

    const adapterScopedLegacy = selector.adapterId
      ? matches.filter(
          ({ binding }) =>
            !binding.adapterAccountIdentity && binding.adapterId === selector.adapterId,
        )
      : [];
    if (adapterScopedLegacy.length > 1) throwAmbiguousBinding(selector);
    if (adapterScopedLegacy[0]) return adapterScopedLegacy[0];

    if (selector.allowLegacyAccountClaim) {
      const unscopedLegacy = matches.filter(
        ({ binding }) => !binding.adapterAccountIdentity && !binding.adapterId,
      );
      if (unscopedLegacy.length > 1) throwAmbiguousBinding(selector);
      if (unscopedLegacy[0]) return unscopedLegacy[0];
    }
    return undefined;
  }
  if (selector.adapterId) {
    const exact = matches.filter(({ binding }) => binding.adapterId === selector.adapterId);
    if (exact.length > 1) throwAmbiguousBinding(selector);
    if (exact[0]) return exact[0];
  }
  if (matches.length > 1) throwAmbiguousBinding(selector);
  return matches[0];
}

function throwAmbiguousBinding(selector: ChannelBindingSelector): never {
  throw new SparkSessionRegistryError(
    "binding_ambiguous",
    `multiple provider accounts match ${bindingIdentityLabel(selector)}`,
  );
}

function bindingIdentityLabel(
  selector: Pick<ChannelBindingSelector, "externalKey" | "adapterAccountIdentity">,
): string {
  return selector.adapterAccountIdentity
    ? `${selector.adapterAccountIdentity}:${selector.externalKey}`
    : selector.externalKey;
}
