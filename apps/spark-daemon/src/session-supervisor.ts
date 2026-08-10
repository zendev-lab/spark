import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  sparkSessionCloseCandidateSchema,
  sparkSessionCloseReceiptSchema,
  type SparkSessionCloseCandidate,
  type SparkSessionCloseReceipt,
  type SparkSessionAuthority,
  type SparkSessionOwner,
  type SparkSessionRegistryRecord,
  type SparkSessionRetention,
  type SparkSessionStateBinding,
  type SparkSessionVisibility,
} from "@zendev-lab/spark-protocol/session-assignment";
import type { SparkRoleSpec } from "@zendev-lab/spark-protocol/role-session";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import type { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import {
  SparkInvocationStore,
  type SparkInvocationRecord,
  type SparkInvocationPayloadRedactionResult,
} from "./store/invocations.ts";

export interface InstantiateSupervisedSessionInput {
  workspaceId: string;
  role: SparkRoleSpec;
  title?: string;
  parentSessionId?: string;
  owner?: SparkSessionOwner;
  sessionId?: string;
  cwd?: string;
  purpose: string;
  visibility?: SparkSessionVisibility;
  retention?: SparkSessionRetention;
  transcriptRef?: string;
}

export interface InvokeSupervisedSessionInput {
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  sourceKind?: string;
  sourceRef?: string;
  parentInvocationId?: string;
  structured?: boolean;
  model?: string;
  roleSystemPrompt?: string;
  roleAllowedTools?: string[];
  roleRunRef?: string;
  requireStructuredOutcome?: boolean;
  signal?: AbortSignal;
  now?: string;
}

export interface InstantiateOwnedContextInput {
  sessionId: string;
  parentSessionId: string;
  owner: SparkSessionOwner;
  authority: SparkSessionAuthority;
  stateBinding: SparkSessionStateBinding;
  purpose: string;
  cwd?: string;
  visibility?: SparkSessionVisibility;
  retention?: SparkSessionRetention;
}

export interface CloseSupervisedSessionInput {
  sessionId: string;
  reason?: string;
  completion?: SparkSessionCloseCandidate;
  now?: Date;
  settleTimeoutMs?: number;
}

export interface SessionSupervisorReconcileResult {
  ensuredWorkspaceIds: string[];
  closedSessionIds: string[];
  closingSessionIds: string[];
  openSessionIds: string[];
}

export interface SessionSupervisorOptions {
  registry: DaemonSessionRegistry;
  invocations: SparkInvocationStore;
  scheduler?: Pick<SparkInvocationScheduler, "cancel" | "executeStructured">;
  deleteTranscript?: (path: string) => Promise<void>;
  ownerExists?: (owner: SparkSessionOwner, session: SparkSessionRegistryRecord) => Promise<boolean>;
  resolveWorkspaceBindingId?: (workspaceId: string) => string | undefined;
}

/**
 * Daemon owner for RoleSpec -> Session -> Invocation lifecycle transitions.
 * The registry and SQLite invocation store remain the only persistence owners.
 */
export class SessionSupervisor {
  readonly registry: DaemonSessionRegistry;
  readonly invocations: SparkInvocationStore;
  private scheduler?: SessionSupervisorOptions["scheduler"];
  private readonly deleteTranscript: NonNullable<SessionSupervisorOptions["deleteTranscript"]>;
  private readonly ownerExists?: SessionSupervisorOptions["ownerExists"];
  private readonly resolveWorkspaceBindingId?: SessionSupervisorOptions["resolveWorkspaceBindingId"];

  constructor(options: SessionSupervisorOptions) {
    this.registry = options.registry;
    this.invocations = options.invocations;
    this.scheduler = options.scheduler;
    this.deleteTranscript = options.deleteTranscript ?? deleteTranscriptArtifacts;
    this.ownerExists = options.ownerExists;
    this.resolveWorkspaceBindingId = options.resolveWorkspaceBindingId;
  }

  attachScheduler(scheduler: NonNullable<SessionSupervisorOptions["scheduler"]>): void {
    if (this.scheduler && this.scheduler !== scheduler) {
      throw new Error("SessionSupervisor scheduler is already attached");
    }
    this.scheduler = scheduler;
  }

  async ensureWorkspaceAdministrator(workspaceId: string): Promise<SparkSessionRegistryRecord> {
    return await this.registry.ensureWorkspaceMain(workspaceId);
  }

  async instantiate(input: InstantiateSupervisedSessionInput): Promise<SparkSessionRegistryRecord> {
    const workspaceId = required(input.workspaceId, "workspaceId");
    const purpose = required(input.purpose, "purpose");
    if (
      input.role.ref === "role:builtin-administrator" &&
      input.role.instantiation === "persistent" &&
      !input.parentSessionId &&
      !input.owner &&
      !input.sessionId
    ) {
      return await this.ensureWorkspaceAdministrator(workspaceId);
    }

    const parent = input.parentSessionId
      ? await this.requireOpen(input.parentSessionId)
      : undefined;
    if (parent?.scope.kind !== "workspace" || parent.scope.workspaceId !== workspaceId) {
      if (parent) {
        throw new SparkSessionRegistryError(
          "session_scope_mismatch",
          `parent ${parent.sessionId} does not belong to workspace ${workspaceId}`,
        );
      }
    }
    const owner =
      input.owner ?? (parent ? ({ kind: "session", ref: parent.sessionId } as const) : undefined);
    if (input.role.instantiation === "owned" && !owner) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `owned Role ${input.role.ref} requires an owner`,
      );
    }
    if (input.role.instantiation === "persistent" && owner && owner.kind !== "session") {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `persistent Role ${input.role.ref} requires a Session owner`,
      );
    }
    if (owner && !(await this.isOwnerReferenceValid(owner, workspaceId))) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `owner ${owner.kind}:${owner.ref} is not active in workspace ${workspaceId}`,
      );
    }
    return await this.registry.createSupervised({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      scope: { kind: "workspace", workspaceId },
      workspaceId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.role.ref === "role:builtin-administrator" ? {} : { role: input.role.id }),
      roleRef: input.role.ref,
      roleRevision: input.role.revision,
      modelType: input.role.modelType,
      lifetime: input.role.instantiation,
      ...(owner ? { owner } : {}),
      authority:
        input.role.ref === "role:builtin-administrator"
          ? { kind: "administrator", ref: input.role.ref }
          : { kind: "role", ref: input.role.ref },
      ...(parent
        ? { stateBinding: { kind: "session" as const, ref: parent.sessionId } }
        : input.sessionId
          ? { stateBinding: { kind: "session" as const, ref: input.sessionId } }
          : {}),
      visibility:
        input.visibility ?? (input.role.instantiation === "owned" ? "internal" : "public"),
      retention:
        input.retention ?? (input.role.instantiation === "owned" ? "discard_on_close" : "retain"),
      purpose,
      ...(input.transcriptRef ? { transcriptRef: input.transcriptRef } : {}),
    });
  }

  async invoke(input: InvokeSupervisedSessionInput): Promise<SparkInvocationRecord> {
    const session = await this.requireOpen(input.sessionId);
    const prompt = required(input.prompt, "prompt");
    const structured = input.structured === true;
    const workspaceId = session.scope.kind === "workspace" ? session.scope.workspaceId : undefined;
    const workspaceBindingId = workspaceId
      ? this.resolveWorkspaceBindingId?.(workspaceId)
      : undefined;
    if (structured && !input.parentInvocationId) {
      throw new Error("structured Session invocation requires parentInvocationId");
    }
    const invocation = this.invocations.submit({
      sessionId: session.sessionId,
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
      prompt,
      task: {
        type: "session.run",
        sessionId: session.sessionId,
        prompt,
        ...(workspaceId
          ? {
              workspaceId,
              ...(workspaceBindingId ? { workspaceBindingId } : {}),
            }
          : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.roleSystemPrompt ? { roleSystemPrompt: input.roleSystemPrompt } : {}),
        ...(input.roleAllowedTools ? { roleAllowedTools: input.roleAllowedTools } : {}),
        ...(input.roleRunRef ? { roleRunRef: input.roleRunRef } : {}),
        ...(input.requireStructuredOutcome !== undefined
          ? { requireStructuredOutcome: input.requireStructuredOutcome }
          : {}),
        reset: true,
      },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      sourceKind: input.sourceKind ?? "session.supervised",
      sourceRef: input.sourceRef ?? session.roleRef ?? session.owner?.ref,
      ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
      claimClass: structured ? "structured" : "root",
      ...(input.now ? { now: input.now } : {}),
    });
    if (!structured) return invocation;
    if (!this.scheduler) throw new Error("structured Session scheduler is unavailable");
    const cancelFromSignal = () =>
      this.scheduler?.cancel(invocation.invocationId, "structured Role caller cancelled");
    if (input.signal?.aborted) {
      cancelFromSignal();
      return this.invocations.require(invocation.invocationId);
    }
    input.signal?.addEventListener("abort", cancelFromSignal, { once: true });
    if (invocation.status === "queued") {
      try {
        return await this.scheduler.executeStructured(invocation.invocationId);
      } finally {
        input.signal?.removeEventListener("abort", cancelFromSignal);
      }
    }
    input.signal?.removeEventListener("abort", cancelFromSignal);
    return invocation;
  }

  /** Instantiate a daemon-owned non-Role context under an open parent Session. */
  async instantiateOwnedContext(
    input: InstantiateOwnedContextInput,
  ): Promise<SparkSessionRegistryRecord> {
    const sessionId = required(input.sessionId, "sessionId");
    const parent = await this.requireOpen(required(input.parentSessionId, "parentSessionId"));
    if (parent.scope.kind !== "workspace") {
      throw new SparkSessionRegistryError(
        "session_scope_mismatch",
        `owned Session parent ${parent.sessionId} is not workspace-scoped`,
      );
    }
    const existing = await this.registry.get(sessionId);
    if (existing) {
      if (
        existing.lifecycle === "open" &&
        existing.scope.kind === "workspace" &&
        existing.scope.workspaceId === parent.scope.workspaceId &&
        existing.owner?.kind === input.owner.kind &&
        existing.owner.ref === input.owner.ref &&
        existing.stateBinding?.kind === input.stateBinding.kind &&
        existing.stateBinding.ref === input.stateBinding.ref
      ) {
        return existing;
      }
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `owned Session identity ${sessionId} conflicts with its persisted owner`,
      );
    }
    if (!(await this.isOwnerReferenceValid(input.owner, parent.scope.workspaceId))) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `owner ${input.owner.kind}:${input.owner.ref} is not active in workspace ${parent.scope.workspaceId}`,
      );
    }
    return await this.registry.createSupervised({
      sessionId,
      scope: parent.scope,
      workspaceId: parent.scope.workspaceId,
      ...((input.cwd ?? parent.cwd) ? { cwd: input.cwd ?? parent.cwd } : {}),
      lifetime: "owned",
      owner: input.owner,
      authority: input.authority,
      stateBinding: input.stateBinding,
      visibility: input.visibility ?? "internal",
      retention: input.retention ?? "discard_on_close",
      purpose: required(input.purpose, "purpose"),
    });
  }

  async close(input: CloseSupervisedSessionInput): Promise<SparkSessionRegistryRecord> {
    return await this.closeRecursive(input, new Set<string>());
  }

  async restore(sessionId: string, now = new Date()): Promise<SparkSessionRegistryRecord> {
    const session = await this.require(sessionId);
    if (
      session.lifecycle !== "closed" ||
      session.status !== "archived" ||
      session.lifetime !== "persistent" ||
      session.visibility !== "public" ||
      session.retention === "discard_on_close" ||
      session.relation
    ) {
      throw new SparkSessionRegistryError(
        "session_restore_forbidden",
        `session ${sessionId} does not retain a restorable public record`,
      );
    }
    if (!(await this.isOwnerValid(session))) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `session ${sessionId} owner is no longer valid`,
      );
    }
    if (!this.registry.restore) {
      throw new SparkSessionRegistryError(
        "session_restore_forbidden",
        "session restore is unavailable",
      );
    }
    return await this.registry.restore(sessionId, now);
  }

  async reconcile(
    input: {
      workspaceIds?: string[];
      now?: Date;
    } = {},
  ): Promise<SessionSupervisorReconcileResult> {
    const ensuredWorkspaceIds: string[] = [];
    for (const workspaceId of [...new Set(input.workspaceIds ?? [])]) {
      await this.ensureWorkspaceAdministrator(workspaceId);
      ensuredWorkspaceIds.push(workspaceId);
    }
    const sessions = await this.registry.list({
      includeArchived: true,
      includeSideThreads: true,
    });
    const closedSessionIds: string[] = [];
    const closingSessionIds: string[] = [];
    const openSessionIds: string[] = [];
    for (const session of sessions) {
      if (session.lifecycle === "closed" || session.status === "archived") {
        closedSessionIds.push(session.sessionId);
        continue;
      }
      if (session.lifecycle === "closing") {
        const closed = await this.close({
          sessionId: session.sessionId,
          reason: "startup reconcile",
          ...(input.now ? { now: input.now } : {}),
          settleTimeoutMs: 0,
        });
        (closed.lifecycle === "closed" ? closedSessionIds : closingSessionIds).push(
          session.sessionId,
        );
        continue;
      }
      if (session.lifetime === "owned" && !(await this.isOwnerValid(session))) {
        const closed = await this.close({
          sessionId: session.sessionId,
          reason: "orphaned owner",
          ...(input.now ? { now: input.now } : {}),
          settleTimeoutMs: 0,
        });
        (closed.lifecycle === "closed" ? closedSessionIds : closingSessionIds).push(
          session.sessionId,
        );
        continue;
      }
      openSessionIds.push(session.sessionId);
    }
    return { ensuredWorkspaceIds, closedSessionIds, closingSessionIds, openSessionIds };
  }

  private async closeRecursive(
    input: CloseSupervisedSessionInput,
    visited: Set<string>,
  ): Promise<SparkSessionRegistryRecord> {
    if (visited.has(input.sessionId)) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `cyclic Session ownership at ${input.sessionId}`,
      );
    }
    visited.add(input.sessionId);
    const current = await this.require(input.sessionId);
    if (current.lifecycle === "closed" || current.status === "archived") return current;
    if (current.relation?.kind === "workspace_main") {
      throw new SparkSessionRegistryError(
        "workspace_main_session_mutation_forbidden",
        `workspace Administrator ${current.sessionId} cannot be closed`,
      );
    }
    await this.registry.markClosing({
      sessionId: current.sessionId,
      ...(current.lifecycle === "open" ? { expectedLifecycle: "open" } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
    const all = await this.registry.list({ includeArchived: false, includeSideThreads: true });
    const children = all.filter(
      (session) =>
        session.sessionId !== current.sessionId &&
        ((session.owner?.kind === "session" && session.owner.ref === current.sessionId) ||
          (session.relation?.kind === "side_thread" &&
            session.relation.parentSessionId === current.sessionId)),
    );
    for (const child of children) {
      const closedChild = await this.closeRecursive(
        {
          sessionId: child.sessionId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.now ? { now: input.now } : {}),
          ...(input.settleTimeoutMs !== undefined
            ? { settleTimeoutMs: input.settleTimeoutMs }
            : {}),
        },
        visited,
      );
      if (closedChild.lifecycle !== "closed") return await this.require(current.sessionId);
    }

    await this.cancelPending(current.sessionId);
    await this.waitForIdle(current.sessionId, input.settleTimeoutMs ?? 5_000);
    if (this.invocations.sessionActivity(current.sessionId).active) {
      return await this.require(current.sessionId);
    }
    const redaction = await this.prepareContentDiscard(current, input);
    if (redaction?.blockedInvocationIds.length) return await this.require(current.sessionId);
    const archiveInput: Parameters<DaemonSessionRegistry["archiveOwned"]>[0] = {
      sessionId: current.sessionId,
      source: "manual",
      reason: input.reason ?? "closed by SessionSupervisor",
      tags: ["lifecycle:closed", `owner:${current.owner?.kind ?? "unknown"}`],
      discardTranscript: current.retention === "discard_on_close",
      ...(input.now ? { now: input.now } : {}),
    };
    return current.relation?.kind === "side_thread"
      ? await this.registry.archiveOwned(archiveInput)
      : await this.registry.archive(archiveInput);
  }

  private async prepareContentDiscard(
    session: SparkSessionRegistryRecord,
    input: CloseSupervisedSessionInput,
  ): Promise<SparkInvocationPayloadRedactionResult | undefined> {
    if (session.retention !== "discard_on_close") return undefined;
    const now = input.now ?? new Date();
    const receipt = this.createCloseReceipt(session, input.completion, now);
    await this.registry.sealCloseReceipt({
      sessionId: session.sessionId,
      expectedIncarnation: session.incarnation ?? 1,
      expectedLifecycle: "closing",
      receipt,
      now,
    });
    let redaction = this.invocations.redactSessionPayloads(session.sessionId, {
      now: now.toISOString(),
    });
    const deliveryDeadline = Date.now() + Math.max(0, input.settleTimeoutMs ?? 5_000);
    while (redaction.blockedInvocationIds.length && Date.now() < deliveryDeadline) {
      await delay(10);
      redaction = this.invocations.redactSessionPayloads(session.sessionId);
    }
    const transcript = session.transcriptRef ?? session.sessionPath;
    if (redaction.blockedInvocationIds.length === 0 && transcript) {
      await this.deleteTranscript(transcript);
    }
    return redaction;
  }

  private createCloseReceipt(
    session: SparkSessionRegistryRecord,
    completion: SparkSessionCloseCandidate | undefined,
    now: Date,
  ): SparkSessionCloseReceipt {
    const terminal = this.invocations
      .listPage({
        sessionId: session.sessionId,
        limit: 100,
      })
      .invocations.filter(isTerminalInvocation)
      .slice(0, 64);

    if (completion) {
      const candidate = sparkSessionCloseCandidateSchema.safeParse(completion);
      if (candidate.success && this.candidateInvocationsBelongToSession(candidate.data, session)) {
        const semantic = sparkSessionCloseReceiptSchema.safeParse({
          version: 1,
          ...candidate.data,
          quality: "semantic",
          incarnation: session.incarnation ?? 1,
          createdAt: now.toISOString(),
        });
        if (semantic.success) return semantic.data;
      }
      console.warn(
        `[spark-daemon] Session ${session.sessionId} close completion was invalid; using deterministic fallback`,
      );
      return fallbackCloseReceipt(session, terminal, now);
    }

    const latest = terminal[0];
    const assistantSummary =
      latest?.status === "succeeded" ? assistantText(latest.result) : undefined;
    if (latest && assistantSummary) {
      const semantic = sparkSessionCloseReceiptSchema.safeParse({
        version: 1,
        source: "terminal_result",
        quality: "semantic",
        status: "completed",
        code: "session_terminal_result",
        summary: assistantSummary,
        evidenceRefs: [],
        artifactRefs: [],
        sourceInvocationIds: [latest.invocationId],
        incarnation: session.incarnation ?? 1,
        createdAt: now.toISOString(),
      });
      if (semantic.success) return semantic.data;
      console.warn(
        `[spark-daemon] Session ${session.sessionId} terminal result exceeded close receipt bounds; using deterministic fallback`,
      );
    }
    return fallbackCloseReceipt(session, terminal, now);
  }

  private candidateInvocationsBelongToSession(
    candidate: SparkSessionCloseCandidate,
    session: SparkSessionRegistryRecord,
  ): boolean {
    return candidate.sourceInvocationIds.every((invocationId) => {
      const invocation = this.invocations.getSummary(invocationId);
      return Boolean(
        invocation &&
        invocation.sessionId === session.sessionId &&
        invocation.status !== "queued" &&
        invocation.status !== "running",
      );
    });
  }

  private async cancelPending(sessionId: string): Promise<void> {
    for (const invocation of this.invocations.listPendingForSession(sessionId)) {
      if (this.scheduler) this.scheduler.cancel(invocation.invocationId, "owning Session closed");
      else this.invocations.requestCancellation(invocation.invocationId, "owning Session closed");
    }
  }

  private async waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.invocations.sessionActivity(sessionId).active && Date.now() < deadline) {
      await delay(10);
    }
  }

  private async isOwnerValid(session: SparkSessionRegistryRecord): Promise<boolean> {
    const owner = session.owner;
    if (!owner) return false;
    if (owner.kind === "session") {
      if (owner.ref === session.sessionId) return session.lifetime === "persistent";
      const parent = await this.registry.get(owner.ref);
      return Boolean(parent && parent.lifecycle === "open" && parent.status !== "archived");
    }
    if (owner.kind === "role_call") {
      const invocation = this.invocations.getSummary(owner.ref);
      return invocation?.status === "queued" || invocation?.status === "running";
    }
    return (await this.ownerExists?.(owner, session)) ?? false;
  }

  private async isOwnerReferenceValid(
    owner: SparkSessionOwner,
    workspaceId: string,
  ): Promise<boolean> {
    if (owner.kind === "session") {
      const session = await this.registry.get(owner.ref);
      return Boolean(
        session &&
        session.lifecycle === "open" &&
        session.status !== "archived" &&
        session.scope.kind === "workspace" &&
        session.scope.workspaceId === workspaceId,
      );
    }
    if (owner.kind === "role_call") {
      const invocation = this.invocations.getSummary(owner.ref);
      return invocation?.status === "queued" || invocation?.status === "running";
    }
    if (!this.ownerExists) return false;
    return await this.ownerExists(owner, {
      sessionId: "session-owner-validation",
      scope: { kind: "workspace", workspaceId },
      workspaceId,
      status: "ready",
      lifecycle: "open",
      lifetime: "owned",
      owner,
      bindings: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  }

  private async requireOpen(sessionId: string): Promise<SparkSessionRegistryRecord> {
    const session = await this.require(sessionId);
    if (session.lifecycle !== "open" || session.status === "archived") {
      throw new SparkSessionRegistryError("session_archived", `session ${sessionId} is not open`);
    }
    return session;
  }

  private async require(sessionId: string): Promise<SparkSessionRegistryRecord> {
    const session = await this.registry.get(sessionId);
    if (!session) {
      throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
    }
    return session;
  }
}

async function deleteTranscriptArtifacts(path: string): Promise<void> {
  await Promise.all(
    [path, `${path}.side-thread-index.json`, `${path}.snapshot-index.json`].map(
      async (candidate) => await rm(candidate, { force: true }),
    ),
  );
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function isTerminalInvocation(invocation: SparkInvocationRecord): boolean {
  return invocation.status !== "queued" && invocation.status !== "running";
}

function assistantText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = (result as Record<string, unknown>).assistantText;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 4_096).trim() : undefined;
}

function fallbackCloseReceipt(
  session: SparkSessionRegistryRecord,
  terminal: SparkInvocationRecord[],
  now: Date,
): SparkSessionCloseReceipt {
  const latest = terminal[0];
  const status =
    latest?.status === "failed"
      ? "failed"
      : latest?.status === "cancelled"
        ? "cancelled"
        : latest?.status === "succeeded"
          ? "completed"
          : "cancelled";
  const code = latest?.errorCode
    ? normalizeCloseCode(latest.errorCode)
    : latest?.status === "failed"
      ? "session_invocation_failed"
      : latest?.status === "cancelled"
        ? "session_invocation_cancelled"
        : latest?.status === "succeeded"
          ? "session_invocation_completed"
          : "session_closed_without_invocation";
  const summary = latest
    ? `Owned Session closed after its latest invocation ${status} (${latest.sourceKind ?? "unknown_source"}).`
    : `Owned Session closed before starting an invocation (${session.purpose ?? "owned_session"}).`;
  const sourceInvocationIds = terminal.map((invocation) => invocation.invocationId);
  while (sourceInvocationIds.length >= 0) {
    const parsed = sparkSessionCloseReceiptSchema.safeParse({
      version: 1,
      source: "deterministic_fallback",
      quality: "fallback",
      status,
      code,
      summary,
      evidenceRefs: [],
      artifactRefs: [],
      sourceInvocationIds,
      incarnation: session.incarnation ?? 1,
      createdAt: now.toISOString(),
    });
    if (parsed.success) return parsed.data;
    if (sourceInvocationIds.length === 0) break;
    sourceInvocationIds.pop();
  }
  throw new Error(`failed to create deterministic close receipt for ${session.sessionId}`);
}

function normalizeCloseCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 128);
  return (/^[a-z]/u.test(normalized) ? normalized : `session_${normalized || "failed"}`).slice(
    0,
    128,
  );
}
