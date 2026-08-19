import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isSparkInvocationTerminalStatus } from "@zendev-lab/spark-protocol";
import {
  sparkSessionCloseCandidateSchema,
  sparkSessionCloseReceiptSchema,
  sparkSessionLifetimeForLineage,
  sparkSessionLineageOriginKind,
  sparkSessionParentId,
  type SparkSessionCloseCandidate,
  type SparkSessionCloseReceipt,
  type SparkSessionLineage,
  type SparkSessionLineageOrigin,
  type SparkSessionState,
  type SparkSessionRetention,
  type SparkSessionVisibility,
} from "@zendev-lab/spark-protocol/session-assignment";
import type { SparkRoleSpec } from "@zendev-lab/spark-protocol/role-session";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import type { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import {
  SparkInvocationStore,
  type SparkInvocationReceiptContext,
  type SparkInvocationRecord,
  type SparkInvocationPayloadRedactionResult,
} from "./store/invocations.ts";

export interface InstantiateSupervisedSessionInput {
  workspaceId: string;
  role: SparkRoleSpec;
  title?: string;
  parentSessionId?: string;
  origin?: SparkSessionLineageOrigin;
  sessionId?: string;
  cwd?: string;
  purpose: string;
  visibility?: SparkSessionVisibility;
  retention?: SparkSessionRetention;
  transcriptRef?: string;
}

export interface InstantiateInvocationSessionInput extends Omit<
  InstantiateSupervisedSessionInput,
  "origin"
> {
  invocationId: string;
  parentSessionId: string;
}

export interface InvokeSupervisedSessionInput {
  invocationId?: string;
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  sourceKind?: string;
  sourceRef?: string;
  parentInvocationId?: string;
  structured?: boolean;
  model?: string;
  thinkingLevel?: string;
  roleRunRef?: string;
  requireStructuredOutcome?: boolean;
  signal?: AbortSignal;
  now?: string;
  receiptProfile?: Omit<
    SparkInvocationReceiptContext,
    "lifetime" | "originKind" | "authorizationSource"
  > & {
    authorizationSource: SparkInvocationReceiptContext["authorizationSource"];
  };
}

export interface InstantiateOwnedContextInput {
  sessionId: string;
  parentSessionId: string;
  origin: SparkSessionLineageOrigin;
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
  scheduler?: Pick<
    SparkInvocationScheduler,
    "cancel" | "executeStructured" | "isSessionActive" | "waitForSessionIdle"
  >;
  deleteTranscript?: (path: string) => Promise<void>;
  quiesceOwnedLoops?: (
    session: SparkSessionState,
    reason: string,
  ) => { invocationSessionIds: string[] } | Promise<{ invocationSessionIds: string[] }>;
  originExists?: (
    origin: SparkSessionLineageOrigin,
    session: SparkSessionState,
  ) => Promise<boolean>;
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
  private readonly quiesceOwnedLoops?: SessionSupervisorOptions["quiesceOwnedLoops"];
  private readonly originExists?: SessionSupervisorOptions["originExists"];
  private readonly resolveWorkspaceBindingId?: SessionSupervisorOptions["resolveWorkspaceBindingId"];
  private readonly reservedInvocationOwners = new Set<string>();
  private readonly inFlightCloses = new Map<
    string,
    { input: CloseSupervisedSessionInput; promise: Promise<SparkSessionState> }
  >();
  private readonly pendingCloseCompletions = new Map<string, SparkSessionCloseCandidate>();
  private readonly pendingCleanupSessionIds = new Set<string>();
  private cleanupRetryWorker: Promise<void> | undefined;
  private readonly idleCleanupWaits = new Map<string, Promise<void>>();
  private closedRepairTail: Promise<void> = Promise.resolve();

  constructor(options: SessionSupervisorOptions) {
    this.registry = options.registry;
    this.invocations = options.invocations;
    this.scheduler = options.scheduler;
    this.deleteTranscript = options.deleteTranscript ?? deleteTranscriptArtifacts;
    this.quiesceOwnedLoops = options.quiesceOwnedLoops;
    this.originExists = options.originExists;
    this.resolveWorkspaceBindingId = options.resolveWorkspaceBindingId;
  }

  attachScheduler(scheduler: NonNullable<SessionSupervisorOptions["scheduler"]>): void {
    if (this.scheduler && this.scheduler !== scheduler) {
      throw new Error("SessionSupervisor scheduler is already attached");
    }
    this.scheduler = scheduler;
  }

  requestInvocationCancellation(invocationId: string, reason: string): boolean {
    if (this.scheduler) return this.scheduler.cancel(invocationId, reason);
    const outcome = this.invocations.requestCancellation(invocationId, reason);
    return outcome === "cancelled" || outcome === "requested";
  }

  async ensureWorkspaceAdministrator(workspaceId: string): Promise<SparkSessionState> {
    return await this.registry.ensureWorkspaceAdministrator(workspaceId);
  }

  async instantiateInvocationSession(
    input: InstantiateInvocationSessionInput,
  ): Promise<SparkSessionState> {
    const invocationId = required(input.invocationId, "invocationId");
    if (
      this.reservedInvocationOwners.has(invocationId) ||
      this.invocations.getSummary(invocationId)
    ) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `invocation owner ${invocationId} is already reserved`,
      );
    }
    this.reservedInvocationOwners.add(invocationId);
    try {
      return await this.instantiate({
        ...input,
        origin: {
          kind: "invocation",
          invocationId,
        },
      });
    } finally {
      this.reservedInvocationOwners.delete(invocationId);
    }
  }

  async instantiate(input: InstantiateSupervisedSessionInput): Promise<SparkSessionState> {
    const workspaceId = required(input.workspaceId, "workspaceId");
    const purpose = required(input.purpose, "purpose");
    if (
      input.role.ref === "role:builtin-administrator" &&
      !input.parentSessionId &&
      !input.origin &&
      !input.sessionId
    ) {
      return await this.ensureWorkspaceAdministrator(workspaceId);
    }
    if (input.role.ref === "role:builtin-administrator") {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        "Administrator Role can only instantiate the unique workspace-owned Administrator Session",
      );
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
    if (!parent) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `Role ${input.role.ref} requires a parent Session`,
      );
    }
    const lineage: SparkSessionLineage = {
      kind: "child",
      parentSessionId: parent.sessionId,
      origin: input.origin ?? { kind: "session" },
    };
    if (!(await this.isLineageReferenceValid(lineage, workspaceId, input.sessionId))) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `lineage ${lineageIdentity(lineage)} is not active in workspace ${workspaceId}`,
      );
    }
    return await this.registry.createSupervised({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      scope: { kind: "workspace", workspaceId },
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.title ? { name: input.title } : {}),
      roleBinding: { kind: "explicit", roleRef: input.role.ref },
      lineage,
      visibility: input.visibility ?? "internal",
      retention: input.retention ?? "discard_on_close",
      purpose,
      ...(input.transcriptRef ? { transcriptRef: input.transcriptRef } : {}),
    });
  }

  async invoke(input: InvokeSupervisedSessionInput): Promise<SparkInvocationRecord> {
    const prompt = required(input.prompt, "prompt");
    const structured = input.structured === true;
    const scheduler = this.scheduler;
    if (structured && !input.parentInvocationId) {
      throw new Error("structured Session invocation requires parentInvocationId");
    }
    if (structured && !scheduler) {
      throw new Error("structured Session scheduler is unavailable");
    }
    const invocation = await this.registry.commitInvocationAdmission(input.sessionId, (session) => {
      const workspaceId =
        session.scope.kind === "workspace" ? session.scope.workspaceId : undefined;
      const workspaceBindingId = workspaceId
        ? this.resolveWorkspaceBindingId?.(workspaceId)
        : undefined;
      const admitted = this.invocations.submit({
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
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
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
          ...(input.roleRunRef ? { roleRunRef: input.roleRunRef } : {}),
          ...(input.requireStructuredOutcome !== undefined
            ? { requireStructuredOutcome: input.requireStructuredOutcome }
            : {}),
          reset: true,
        },
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        sourceKind: input.sourceKind ?? "session.supervised",
        sourceRef:
          input.sourceRef ??
          (session.roleBinding.kind === "explicit"
            ? session.roleBinding.roleRef
            : lineageIdentity(session.lineage)),
        ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
        claimClass: structured ? "structured" : "root",
        ...(input.now ? { now: input.now } : {}),
      });
      if (input.receiptProfile) {
        this.invocations.recordReceiptContext(
          admitted.invocationId,
          {
            lifetime: sparkSessionLifetimeForLineage(session.lineage),
            originKind: sparkSessionLineageOriginKind(session.lineage),
            ...input.receiptProfile,
          },
          input.now,
        );
      }
      return admitted;
    });
    if (!structured) return invocation;
    if (!scheduler) throw new Error("structured Session scheduler is unavailable");
    const cancelFromSignal = () =>
      scheduler.cancel(invocation.invocationId, "structured Role caller cancelled");
    if (input.signal?.aborted) {
      cancelFromSignal();
      return this.invocations.require(invocation.invocationId);
    }
    input.signal?.addEventListener("abort", cancelFromSignal, { once: true });
    if (invocation.status === "queued") {
      try {
        return await scheduler.executeStructured(invocation.invocationId);
      } finally {
        input.signal?.removeEventListener("abort", cancelFromSignal);
      }
    }
    input.signal?.removeEventListener("abort", cancelFromSignal);
    return invocation;
  }

  /** Instantiate a daemon-owned non-Role context under an open parent Session. */
  async instantiateOwnedContext(input: InstantiateOwnedContextInput): Promise<SparkSessionState> {
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
        sameChildLineage(existing.lineage, parent.sessionId, input.origin)
      ) {
        return existing;
      }
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `owned Session identity ${sessionId} conflicts with its persisted lineage`,
      );
    }
    const lineage: SparkSessionLineage = {
      kind: "child",
      parentSessionId: parent.sessionId,
      origin: input.origin,
    };
    if (!(await this.isLineageReferenceValid(lineage, parent.scope.workspaceId, sessionId))) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `lineage ${lineageIdentity(lineage)} is not active in workspace ${parent.scope.workspaceId}`,
      );
    }
    return await this.registry.createSupervised({
      sessionId,
      scope: parent.scope,
      ...((input.cwd ?? parent.cwd) ? { cwd: input.cwd ?? parent.cwd } : {}),
      lineage,
      visibility: input.visibility ?? "internal",
      retention: input.retention ?? "discard_on_close",
      purpose: required(input.purpose, "purpose"),
    });
  }

  async close(input: CloseSupervisedSessionInput): Promise<SparkSessionState> {
    return await this.closeCoalesced(input, new Set<string>());
  }

  async restore(sessionId: string, now = new Date()): Promise<SparkSessionState> {
    const session = await this.require(sessionId);
    if (
      session.lifecycle !== "open" ||
      session.placement !== "archived" ||
      session.lineage.kind === "root"
    ) {
      throw new SparkSessionRegistryError(
        "session_restore_forbidden",
        `session ${sessionId} is not an open archived scoped Session`,
      );
    }
    if (!(await this.isLineageValid(session))) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `session ${sessionId} owner is no longer valid`,
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
      includeClosed: true,
      includeSideThreads: true,
    });
    const closedSessionIds: string[] = [];
    const closingSessionIds: string[] = [];
    const openSessionIds: string[] = [];
    for (const snapshot of sessions) {
      const session = await this.registry.get(snapshot.sessionId);
      // A parent close can archive or tombstone descendants that were present
      // in the startup snapshot. Re-read before acting on each entry.
      if (!session) continue;
      if (session.lifecycle === "closed") {
        await this.repairClosedSessionContent(session, input.now);
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
      if (
        sparkSessionLifetimeForLineage(session.lineage) !== "persistent" &&
        !(await this.isLineageValid(session))
      ) {
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

  /** Retry lifecycle-owned cleanup when an Invocation settles or is delivered. */
  async repairClosedContentForInvocation(invocationId: string, now?: Date): Promise<void> {
    const repair = this.closedRepairTail.then(async () => {
      const invocation = this.invocations.get(invocationId);
      if (!invocation) return;
      for (const sessionId of closedRepairSessionIds(invocation)) {
        const session = await this.registry.get(sessionId);
        if (session?.lifecycle === "closed") {
          await this.repairClosedSessionContent(session, now);
          continue;
        }
        if (session?.lifecycle === "closing") {
          await this.close({
            sessionId: session.sessionId,
            reason: "closing lifecycle delivery reconcile",
            settleTimeoutMs: 0,
            ...(now ? { now } : {}),
          });
        }
      }
    });
    this.closedRepairTail = repair.catch(() => undefined);
    await repair;
  }

  private closeCoalesced(
    input: CloseSupervisedSessionInput,
    visited: Set<string>,
  ): Promise<SparkSessionState> {
    if (visited.has(input.sessionId)) {
      throw new SparkSessionRegistryError(
        "session_owner_invalid",
        `cyclic Session ownership at ${input.sessionId}`,
      );
    }
    if (input.completion && !this.pendingCloseCompletions.has(input.sessionId)) {
      this.pendingCloseCompletions.set(input.sessionId, input.completion);
    }
    const pendingCompletion = this.pendingCloseCompletions.get(input.sessionId);
    const inFlight = this.inFlightCloses.get(input.sessionId);
    if (inFlight) {
      if (!inFlight.input.completion && pendingCompletion) {
        inFlight.input.completion = pendingCompletion;
      }
      return inFlight.promise;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(input.sessionId);
    const sharedInput = {
      ...input,
      ...(pendingCompletion ? { completion: pendingCompletion } : {}),
    };
    let close!: Promise<SparkSessionState>;
    close = Promise.resolve()
      .then(async () => await this.closeRecursive(sharedInput, nextVisited))
      .then((session) => {
        if (session.lifecycle === "closed") {
          this.pendingCloseCompletions.delete(input.sessionId);
        }
        return session;
      })
      .finally(() => {
        if (this.inFlightCloses.get(input.sessionId)?.promise === close) {
          this.inFlightCloses.delete(input.sessionId);
        }
      });
    this.inFlightCloses.set(input.sessionId, { input: sharedInput, promise: close });
    return close;
  }

  private async closeRecursive(
    input: CloseSupervisedSessionInput,
    visited: Set<string>,
  ): Promise<SparkSessionState> {
    const current = await this.require(input.sessionId);
    if (current.lifecycle === "closed") return current;
    if (current.lineage.kind === "root") {
      throw new SparkSessionRegistryError(
        "workspace_administrator_session_mutation_forbidden",
        `workspace Administrator ${current.sessionId} cannot be closed`,
      );
    }
    const closing = await this.registry.markClosing({
      sessionId: current.sessionId,
      ...(current.lifecycle === "open" ? { expectedLifecycle: "open" } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
    const quiesced = await this.quiesceOwnedLoops?.(
      closing,
      input.reason ?? `owning Session ${closing.sessionId} closed`,
    );
    const invocationSessionIds = [
      ...new Set([closing.sessionId, ...(quiesced?.invocationSessionIds ?? [])]),
    ];
    const all = await this.registry.list({ includeArchived: false, includeSideThreads: true });
    const children = all.filter(
      (session) =>
        session.sessionId !== current.sessionId &&
        sparkSessionParentId(session.lineage) === current.sessionId,
    );
    for (const child of children) {
      const closedChild = await this.closeCoalesced(
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

    for (const sessionId of invocationSessionIds) await this.cancelPending(sessionId);
    await this.waitForIdle(invocationSessionIds, input.settleTimeoutMs ?? 5_000);
    if (this.anySessionActive(invocationSessionIds)) {
      this.retryCleanupAfterProcessIdle(current.sessionId, invocationSessionIds);
      return await this.require(current.sessionId);
    }
    // Invocation completion may bind the transcript while close waits for the
    // durable execution owner to settle. Refresh before redaction so
    // discard-on-close cannot orphan a transcript that was absent above.
    const settled = await this.require(current.sessionId);
    const redaction = await this.prepareContentDiscard(
      settled,
      input,
      invocationSessionIds.filter((sessionId) => sessionId !== settled.sessionId),
    );
    if (redaction?.blockedInvocationIds.length) return await this.require(current.sessionId);
    const archiveInput: Parameters<DaemonSessionRegistry["archiveOwned"]>[0] = {
      sessionId: settled.sessionId,
      source: "manual",
      reason: input.reason ?? "closed by SessionSupervisor",
      tags: ["lifecycle:closed", `origin:${sparkSessionLineageOriginKind(settled.lineage)}`],
      discardTranscript: settled.retention === "discard_on_close",
      ...(input.now ? { now: input.now } : {}),
    };
    const closed = await this.registry.archiveOwned(archiveInput);
    const parentSessionId = sparkSessionParentId(settled.lineage);
    if (parentSessionId) this.queueCleanupRetry(parentSessionId);
    return closed;
  }

  private async prepareContentDiscard(
    session: SparkSessionState,
    input: CloseSupervisedSessionInput,
    supplementalSessionIds: string[] = [],
  ): Promise<SparkInvocationPayloadRedactionResult | undefined> {
    const now = input.now ?? new Date();
    const receipt = this.createCloseReceipt(session, input.completion, now);
    await this.registry.sealCloseReceipt({
      sessionId: session.sessionId,
      expectedIncarnation: session.incarnation ?? 1,
      expectedLifecycle: "closing",
      receipt,
      now,
    });
    const redactionSessionIds = [
      ...new Set([
        ...(session.retention === "discard_on_close" ? [session.sessionId] : []),
        ...supplementalSessionIds,
      ]),
    ];
    if (redactionSessionIds.length === 0) return undefined;
    let redaction = this.redactSessionPayloads(redactionSessionIds, now.toISOString());
    const deliveryDeadline = Date.now() + Math.max(0, input.settleTimeoutMs ?? 5_000);
    while (redaction.blockedInvocationIds.length && Date.now() < deliveryDeadline) {
      await delay(10);
      redaction = this.redactSessionPayloads(redactionSessionIds);
    }
    if (redaction.blockedInvocationIds.length === 0 && session.retention === "discard_on_close") {
      for (const transcriptPath of sessionTranscriptPaths(session)) {
        await this.deleteTranscript(transcriptPath);
      }
    }
    return redaction;
  }

  /** Repair content left by daemon versions that finalized close outside the Supervisor. */
  private async repairClosedSessionContent(
    session: SparkSessionState,
    now: Date | undefined,
  ): Promise<void> {
    const repairedAt = now ?? new Date();
    const quiesced = await this.quiesceOwnedLoops?.(
      session,
      `closed Session ${session.sessionId} recovery`,
    );
    const invocationSessionIds = [
      ...new Set([session.sessionId, ...(quiesced?.invocationSessionIds ?? [])]),
    ];
    for (const sessionId of invocationSessionIds) await this.cancelPending(sessionId);
    await this.waitForIdle(invocationSessionIds, 0);
    if (this.anySessionActive(invocationSessionIds)) {
      this.retryCleanupAfterProcessIdle(session.sessionId, invocationSessionIds);
      return;
    }
    let repaired = session;
    const incarnation = repaired.incarnation ?? 1;
    if (!repaired.closeReceipts?.some((receipt) => receipt.incarnation === incarnation)) {
      repaired = await this.registry.sealCloseReceipt({
        sessionId: repaired.sessionId,
        expectedIncarnation: incarnation,
        expectedLifecycle: "closed",
        receipt: this.createCloseReceipt(repaired, undefined, repairedAt),
        now: repairedAt,
      });
    }
    const redactionSessionIds = [
      ...new Set([
        ...(repaired.retention === "discard_on_close" ? [repaired.sessionId] : []),
        ...invocationSessionIds.filter((sessionId) => sessionId !== repaired.sessionId),
      ]),
    ];
    const redaction =
      redactionSessionIds.length > 0
        ? this.redactSessionPayloads(redactionSessionIds, repairedAt.toISOString())
        : undefined;
    if (redaction?.blockedInvocationIds.length) return;
    if (repaired.retention !== "discard_on_close") return;
    const transcriptPaths = sessionTranscriptPaths(repaired);
    await this.registry.commitClosedTranscriptDiscard(
      {
        sessionId: repaired.sessionId,
        expectedIncarnation: repaired.incarnation ?? 1,
        ...(repaired.sessionPath ? { expectedSessionPath: repaired.sessionPath } : {}),
        ...(repaired.transcriptRef ? { expectedTranscriptRef: repaired.transcriptRef } : {}),
        now: repairedAt,
      },
      async () => {
        for (const transcriptPath of transcriptPaths) await this.deleteTranscript(transcriptPath);
      },
    );
  }

  private retryCleanupAfterProcessIdle(sessionId: string, invocationSessionIds: string[]): void {
    const scheduler = this.scheduler;
    if (!scheduler || this.idleCleanupWaits.has(sessionId)) return;
    const activeSessionIds = invocationSessionIds.filter((candidate) =>
      scheduler.isSessionActive(candidate),
    );
    if (activeSessionIds.length === 0) return;
    const wait = Promise.all(
      activeSessionIds.map(async (candidate) => await scheduler.waitForSessionIdle(candidate)),
    )
      .then(() => this.queueCleanupRetry(sessionId))
      .catch((error: unknown) => {
        console.error(`[spark-daemon] failed waiting to resume Session close ${sessionId}`, error);
      })
      .finally(() => {
        if (this.idleCleanupWaits.get(sessionId) === wait) this.idleCleanupWaits.delete(sessionId);
      });
    this.idleCleanupWaits.set(sessionId, wait);
  }

  private queueCleanupRetry(sessionId: string): void {
    this.pendingCleanupSessionIds.add(sessionId);
    this.startCleanupRetryWorker();
  }

  private startCleanupRetryWorker(): void {
    if (this.cleanupRetryWorker || this.pendingCleanupSessionIds.size === 0) return;
    const worker = (async () => {
      while (this.pendingCleanupSessionIds.size > 0) {
        const sessionId = this.pendingCleanupSessionIds.values().next().value;
        if (sessionId === undefined) return;
        this.pendingCleanupSessionIds.delete(sessionId);
        try {
          const session = await this.registry.get(sessionId);
          if (session?.lifecycle === "closing") {
            await this.close({
              sessionId,
              reason: "resume interrupted Session close",
              settleTimeoutMs: 0,
            });
          } else if (session?.lifecycle === "closed") {
            await this.repairClosedSessionContent(session, undefined);
          }
        } catch (error) {
          console.error(`[spark-daemon] failed to resume Session close ${sessionId}`, error);
        }
      }
    })().finally(() => {
      if (this.cleanupRetryWorker === worker) this.cleanupRetryWorker = undefined;
      this.startCleanupRetryWorker();
    });
    this.cleanupRetryWorker = worker;
    void worker;
  }

  private redactSessionPayloads(
    sessionIds: string[],
    now?: string,
  ): SparkInvocationPayloadRedactionResult {
    const results = sessionIds.map((sessionId) =>
      this.invocations.redactSessionPayloads(sessionId, now ? { now } : {}),
    );
    return {
      sessionId: sessionIds[0]!,
      redactedInvocationIds: [
        ...new Set(results.flatMap((result) => result.redactedInvocationIds)),
      ],
      deletedEventCount: results.reduce((total, result) => total + result.deletedEventCount, 0),
      blockedInvocationIds: [...new Set(results.flatMap((result) => result.blockedInvocationIds))],
      redactedAt: results[0]!.redactedAt,
    };
  }

  private createCloseReceipt(
    session: SparkSessionState,
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
    session: SparkSessionState,
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

  private async waitForIdle(sessionIds: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.anySessionActive(sessionIds) && Date.now() < deadline) {
      await delay(10);
    }
  }

  private anySessionActive(sessionIds: string[]): boolean {
    const activity = this.invocations.sessionActivities(sessionIds);
    return sessionIds.some(
      (sessionId) =>
        activity.get(sessionId)?.active === true || this.scheduler?.isSessionActive(sessionId),
    );
  }

  private async isLineageValid(session: SparkSessionState): Promise<boolean> {
    if (session.lineage.kind === "root") return true;
    const parent = await this.registry.get(session.lineage.parentSessionId);
    if (!parent || parent.lifecycle !== "open" || parent.placement !== "active") return false;
    const origin = session.lineage.origin;
    if (origin.kind === "session" || origin.kind === "side_thread") return true;
    if (origin.kind === "invocation") {
      const invocation = this.invocations.getSummary(origin.invocationId);
      return invocation?.status === "queued" || invocation?.status === "running";
    }
    return (await this.originExists?.(origin, session)) ?? false;
  }

  private async isLineageReferenceValid(
    lineage: SparkSessionLineage,
    workspaceId: string,
    sessionId?: string,
  ): Promise<boolean> {
    if (lineage.kind === "root") return lineage.workspaceId === workspaceId;
    const parent = await this.registry.get(lineage.parentSessionId);
    if (
      !parent ||
      parent.lifecycle !== "open" ||
      parent.placement !== "active" ||
      parent.scope.kind !== "workspace" ||
      parent.scope.workspaceId !== workspaceId
    ) {
      return false;
    }
    const origin = lineage.origin;
    if (origin.kind === "session" || origin.kind === "side_thread") return true;
    if (origin.kind === "invocation") {
      const invocation = this.invocations.getSummary(origin.invocationId);
      if (invocation) {
        return invocation.status === "queued" || invocation.status === "running";
      }
      return this.reservedInvocationOwners.has(origin.invocationId);
    }
    if (!this.originExists) return false;
    return await this.originExists(origin, {
      sessionId: sessionId?.trim() || "session-owner-validation",
      scope: { kind: "workspace", workspaceId },
      lifecycle: "open",
      placement: "active",
      roleBinding: { kind: "none" },
      incarnation: 1,
      lineage,
      visibility: "internal",
      retention: "discard_on_close",
      purpose: "owner_validation",
      bindings: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  }

  private async requireOpen(sessionId: string): Promise<SparkSessionState> {
    const session = await this.require(sessionId);
    if (session.lifecycle !== "open" || session.placement === "archived") {
      throw new SparkSessionRegistryError("session_archived", `session ${sessionId} is not open`);
    }
    return session;
  }

  private async require(sessionId: string): Promise<SparkSessionState> {
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

function lineageIdentity(lineage: SparkSessionLineage): string {
  if (lineage.kind === "root") return `root:${lineage.workspaceId}`;
  return `${lineage.parentSessionId}/${originIdentity(lineage.origin)}`;
}

function originIdentity(origin: SparkSessionLineageOrigin): string {
  switch (origin.kind) {
    case "session":
      return "session";
    case "side_thread":
      return `side_thread:${origin.generation}`;
    case "invocation":
      return `invocation:${origin.invocationId}`;
    case "task_run":
      return `task_run:${origin.runRef}`;
    case "task_revision":
      return `task_revision:${origin.revisionRef}`;
    case "workflow_run":
      return `workflow_run:${origin.workflowRef}:${origin.runRef}:${origin.generation}`;
    case "driver":
      return `driver:${origin.driverId}:${origin.generation}`;
    case "driver_tick":
      return `driver_tick:${origin.driverId}:${origin.generation}:${origin.tickInvocationId}`;
  }
}

function sameChildLineage(
  persisted: SparkSessionLineage,
  parentSessionId: string,
  origin: SparkSessionLineageOrigin,
): boolean {
  if (
    persisted.kind === "child" &&
    persisted.parentSessionId === parentSessionId &&
    persisted.origin.kind === "driver" &&
    origin.kind === "driver"
  ) {
    return persisted.origin.driverId === origin.driverId;
  }
  return (
    persisted.kind === "child" &&
    persisted.parentSessionId === parentSessionId &&
    originIdentity(persisted.origin) === originIdentity(origin)
  );
}

function closedRepairSessionIds(invocation: SparkInvocationRecord): string[] {
  const sessionIds = new Set<string>();
  if (invocation.sessionId) sessionIds.add(invocation.sessionId);
  if (invocation.task && typeof invocation.task === "object" && !Array.isArray(invocation.task)) {
    const task = invocation.task as { ownerSessionId?: unknown };
    const ownerSessionId = task.ownerSessionId;
    if (typeof ownerSessionId === "string" && ownerSessionId.trim()) {
      sessionIds.add(ownerSessionId.trim());
    }
  }
  return [...sessionIds];
}

function sessionTranscriptPaths(session: SparkSessionState): string[] {
  return [...new Set([session.transcriptRef, session.sessionPath].filter(isPresentString))];
}

function isPresentString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTerminalInvocation(invocation: SparkInvocationRecord): boolean {
  return isSparkInvocationTerminalStatus(invocation.status);
}

function assistantText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = (result as Record<string, unknown>).assistantText;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 4_096).trim() : undefined;
}

function fallbackCloseReceipt(
  session: SparkSessionState,
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
