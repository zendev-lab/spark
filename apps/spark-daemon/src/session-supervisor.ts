import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SparkSessionOwner,
  SparkSessionRegistryRecord,
  SparkSessionRetention,
  SparkSessionVisibility,
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
  now?: string;
}

export interface CloseSupervisedSessionInput {
  sessionId: string;
  reason?: string;
  summary?: Record<string, unknown>;
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
}

/**
 * Daemon owner for RoleSpec -> Session -> Invocation lifecycle transitions.
 * The registry and SQLite invocation store remain the only persistence owners.
 */
export class SessionSupervisor {
  readonly registry: DaemonSessionRegistry;
  readonly invocations: SparkInvocationStore;
  private readonly scheduler?: SessionSupervisorOptions["scheduler"];
  private readonly deleteTranscript: NonNullable<SessionSupervisorOptions["deleteTranscript"]>;
  private readonly ownerExists?: SessionSupervisorOptions["ownerExists"];

  constructor(options: SessionSupervisorOptions) {
    this.registry = options.registry;
    this.invocations = options.invocations;
    this.scheduler = options.scheduler;
    this.deleteTranscript =
      options.deleteTranscript ?? (async (path) => await rm(path, { force: true }));
    this.ownerExists = options.ownerExists;
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
    return await this.registry.createSupervised({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      scope: { kind: "workspace", workspaceId },
      workspaceId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      role: input.role.ref,
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
    if (structured && !input.parentInvocationId) {
      throw new Error("structured Session invocation requires parentInvocationId");
    }
    const invocation = this.invocations.submit({
      sessionId: session.sessionId,
      prompt,
      task: {
        type: "session.run",
        sessionId: session.sessionId,
        prompt,
        ...(session.cwd ? { cwd: session.cwd } : {}),
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
    if (invocation.status === "queued") {
      return await this.scheduler.executeStructured(invocation.invocationId);
    }
    return invocation;
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
      if (child.relation?.kind === "side_thread") {
        await this.registry.markClosing({
          sessionId: child.sessionId,
          ...(child.lifecycle === "open" ? { expectedLifecycle: "open" } : {}),
          ...(input.now ? { now: input.now } : {}),
        });
        await this.cancelPending(child.sessionId);
        await this.waitForIdle(child.sessionId, input.settleTimeoutMs ?? 5_000);
        if (this.invocations.sessionActivity(child.sessionId).active) {
          return await this.require(current.sessionId);
        }
        const childRedaction = await this.prepareContentDiscard(child, input);
        if (childRedaction?.blockedInvocationIds.length) {
          return await this.require(current.sessionId);
        }
      } else {
        const closedChild = await this.closeRecursive(
          { ...input, sessionId: child.sessionId },
          visited,
        );
        if (closedChild.lifecycle !== "closed") return await this.require(current.sessionId);
      }
    }

    await this.cancelPending(current.sessionId);
    await this.waitForIdle(current.sessionId, input.settleTimeoutMs ?? 5_000);
    if (this.invocations.sessionActivity(current.sessionId).active) {
      return await this.require(current.sessionId);
    }
    const redaction = await this.prepareContentDiscard(current, input);
    if (redaction?.blockedInvocationIds.length) return await this.require(current.sessionId);
    if (current.relation?.kind === "side_thread") return await this.require(current.sessionId);
    return await this.registry.archive({
      sessionId: current.sessionId,
      source: "manual",
      reason: input.reason ?? "closed by SessionSupervisor",
      tags: ["lifecycle:closed", `owner:${current.owner?.kind ?? "unknown"}`],
      discardTranscript: current.retention === "discard_on_close",
      ...(input.now ? { now: input.now } : {}),
    });
  }

  private async prepareContentDiscard(
    session: SparkSessionRegistryRecord,
    input: CloseSupervisedSessionInput,
  ): Promise<SparkInvocationPayloadRedactionResult | undefined> {
    if (session.retention !== "discard_on_close") return undefined;
    const redaction = this.invocations.redactSessionPayloads(session.sessionId, {
      summary:
        input.summary ??
        ({
          purpose: session.purpose ?? "owned_session",
          roleRef: session.roleRef ?? "unknown",
          closed: true,
        } satisfies Record<string, unknown>),
      ...(input.now ? { now: input.now.toISOString() } : {}),
    });
    const transcript = session.transcriptRef ?? session.sessionPath;
    if (redaction.blockedInvocationIds.length === 0 && transcript) {
      await this.deleteTranscript(transcript);
    }
    return redaction;
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
    return (await this.ownerExists?.(owner, session)) ?? true;
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

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
