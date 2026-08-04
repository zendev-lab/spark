import { describe, expect, it } from "vitest";
import { z } from "zod";
import { localRpcMethodToSparkCommandKind } from "./command-events.ts";
import {
  isSparkLocalRpcOrpcErrorCodeForMethod,
  sparkLocalRpcChannelOrpcErrors,
  sparkLocalRpcDaemonOrpcErrors,
  sparkLocalRpcLoopOrpcErrors,
  sparkLocalRpcHumanOrpcErrors,
  sparkLocalRpcInvocationOrpcErrors,
  sparkLocalRpcModelOrpcErrors,
  sparkLocalRpcOrpcContract,
  sparkLocalRpcOrpcLiveMethods,
  sparkLocalRpcOrpcMethodPaths,
  sparkLocalRpcProcedureSchemas,
  sparkLocalRpcReadinessOrpcErrors,
  sparkLocalRpcSessionOrpcErrors,
  sparkLocalRpcSideThreadOrpcErrors,
  sparkLocalRpcTaskClaimOrpcErrors,
  sparkLocalRpcUplinkOrpcErrors,
  sparkLocalRpcWorkspaceOrpcErrors,
  type SparkLocalRpcOrpcMethod,
} from "./local-rpc-orpc-contract.ts";
import {
  sparkChannelRpcErrorCodeOptions,
  sparkDaemonLifecycleRpcErrorCodeOptions,
  sparkLoopRpcErrorCodeOptions,
  sparkHumanRpcErrorCodeOptions,
  sparkInvocationRpcErrorCodeOptions,
  sparkModelRpcErrorCodeOptions,
  sparkTaskClaimRpcErrorCodeOptions,
  sparkUplinkRpcErrorCodeOptions,
  sparkWorkspaceRpcErrorCodeOptions,
} from "./daemon-rpc-errors.ts";
import { sparkLoopScheduleRequestSchema } from "./loop.ts";
import { sparkSessionRegistryErrorCodeOptions } from "./session-errors.ts";
import { sparkSideThreadErrorCodeOptions } from "./side-thread.ts";

function requireSchema<T extends { parse(value: unknown): unknown }>(schema: T | undefined): T {
  expect(schema).toBeDefined();
  if (!schema) throw new Error("Expected oRPC procedure schema.");
  return schema;
}

function resolveContractPath(path: readonly string[]): unknown {
  let cursor: unknown = sparkLocalRpcOrpcContract;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function opaqueSchemaPaths(
  schema: z.ZodType,
  path = schema.constructor.name,
  seen = new WeakSet<object>(),
): string[] {
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return [path];
  if (seen.has(schema)) return [];
  seen.add(schema);

  const definition = (schema as z.ZodType & { _def: Record<string, unknown> })._def;
  return Object.entries(definition).flatMap(([key, value]) => {
    const childPath = `${path}.${key}`;
    if ((key === "getter" || key === "shape") && typeof value === "function") {
      return opaqueSchemaValuePaths(value(), childPath, seen);
    }
    return opaqueSchemaValuePaths(value, childPath, seen);
  });
}

function opaqueSchemaValuePaths(value: unknown, path: string, seen: WeakSet<object>): string[] {
  if (value instanceof z.ZodType) return opaqueSchemaPaths(value, path, seen);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => opaqueSchemaValuePaths(item, `${path}[${index}]`, seen));
  }
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, child]) =>
    opaqueSchemaValuePaths(child, `${path}.${key}`, seen),
  );
}

describe("sparkLocalRpcOrpcContract (Phase 4)", () => {
  it("covers every local-rpc method mapped in command events", () => {
    const commandMethods = Object.keys(localRpcMethodToSparkCommandKind).sort();
    const contractMethods = Object.keys(sparkLocalRpcOrpcMethodPaths).sort();
    expect(contractMethods).toEqual(commandMethods);
  });

  it("nests contracts under domain routers matching method path map", () => {
    for (const [method, path] of Object.entries(sparkLocalRpcOrpcMethodPaths)) {
      expect(resolveContractPath(path), method).toBeTruthy();
    }
    expect(sparkLocalRpcOrpcMethodPaths["side-thread.ensure"]).toEqual(["sideThread", "ensure"]);
    expect(sparkLocalRpcOrpcMethodPaths["workspace.ensure-local"]).toEqual([
      "workspace",
      "ensureLocal",
    ]);
    expect(sparkLocalRpcOrpcMethodPaths["workspace.resolve-session-cwd"]).toEqual([
      "workspace",
      "resolveSessionCwd",
    ]);
    expect(sparkLocalRpcOrpcMethodPaths["provider.auth.api-key.set"]).toEqual([
      "provider",
      "auth",
      "apiKey",
      "set",
    ]);
    expect(sparkLocalRpcOrpcMethodPaths["provider.auth.import.pi"]).toEqual([
      "provider",
      "auth",
      "import",
      "pi",
    ]);
  });

  it("marks every contracted method as live", () => {
    expect(sparkLocalRpcOrpcLiveMethods).toHaveLength(
      Object.keys(sparkLocalRpcOrpcMethodPaths).length,
    );
    for (const method of sparkLocalRpcOrpcLiveMethods) {
      expect(sparkLocalRpcOrpcMethodPaths[method as SparkLocalRpcOrpcMethod]).toBeTruthy();
    }
  });

  it("keeps spike leaves for daemon/workspace/uplink/model", () => {
    expect(sparkLocalRpcOrpcContract.daemon.status).toBeDefined();
    expect(sparkLocalRpcOrpcContract.daemon.stop).toBeDefined();
    expect(sparkLocalRpcOrpcContract.workspace.list).toBeDefined();
    expect(sparkLocalRpcOrpcContract.uplink.status).toBeDefined();
    expect(sparkLocalRpcOrpcContract.model.catalog).toBeDefined();
  });

  it("parses session-bound workspace client procedures through their oRPC schemas", () => {
    const attach = sparkLocalRpcOrpcContract.workspace.client.attach["~orpc"];
    const heartbeat = sparkLocalRpcOrpcContract.workspace.client.heartbeat["~orpc"];
    const release = sparkLocalRpcOrpcContract.workspace.client.release["~orpc"];
    const attachInput = requireSchema(attach.inputSchema);
    const heartbeatInput = requireSchema(heartbeat.inputSchema);
    const releaseInput = requireSchema(release.inputSchema);
    const outputSchemas = [attach, heartbeat, release].map(({ outputSchema }) =>
      requireSchema(outputSchema),
    );

    expect(
      attachInput.parse({
        workspaceId: "workspace-1",
        clientId: "client-1",
        kind: "interactive",
        sessionId: "session-1",
      }),
    ).toMatchObject({ workspaceId: "workspace-1", clientId: "client-1", sessionId: "session-1" });
    expect(
      heartbeatInput.parse({
        clientId: "client-1",
        leaseFence: "fence-1",
      }),
    ).toMatchObject({ clientId: "client-1", leaseFence: "fence-1" });
    expect(
      releaseInput.parse({
        clientId: "client-1",
        leaseFence: "fence-1",
      }),
    ).toMatchObject({ clientId: "client-1", leaseFence: "fence-1" });

    const result = {
      client: {
        id: "client-1",
        workspaceId: "workspace-1",
        kind: "interactive" as const,
        status: "connected" as const,
        attachedAt: "2026-07-27T11:59:00.000Z",
        sessionId: "session-1",
        lastSeenAt: "2026-07-27T12:00:00.000Z",
        leaseFence: "fence-1",
        leaseExpiresAt: "2026-07-27T12:01:00.000Z",
        metadata: {},
      },
      workspace: {
        id: "workspace-1",
        serverUrl: "http://127.0.0.1:4310",
        localWorkspaceKey: "workspace-1",
        displayName: "Workspace 1",
        localPath: "/workspace-1",
        status: "available" as const,
        capabilities: {},
        diagnostics: {},
        updatedAt: "2026-07-27T12:00:00.000Z",
      },
      observedAt: "2026-07-27T12:00:00.000Z",
    };
    for (const outputSchema of outputSchemas) {
      const parsed = outputSchema.parse(result);
      expect(parsed).toMatchObject({ client: result.client });
    }
  });

  it("requires fenced session leases for daemon-owned task claim mutations", () => {
    const acquire = sparkLocalRpcOrpcContract.task.claim.acquire["~orpc"];
    const release = sparkLocalRpcOrpcContract.task.claim.release["~orpc"];
    const recover = sparkLocalRpcOrpcContract.task.claim.recover["~orpc"];
    const identity = {
      workspaceId: "workspace-1",
      clientId: "client-1",
      leaseFence: "fence-1",
      sessionId: "session:one",
    };

    expect(
      requireSchema(acquire.inputSchema).parse({
        ...identity,
        taskRef: "task:one",
        status: "blocked",
      }),
    ).toMatchObject({ ...identity, status: "blocked" });
    expect(
      requireSchema(release.inputSchema).parse({
        ...identity,
        taskRef: "task:one",
        disposition: "release",
      }),
    ).toMatchObject(identity);
    expect(
      requireSchema(recover.inputSchema).parse({
        ...identity,
        taskRef: "task:one",
        previousSessionId: "session:old",
        reason: "claim_expired",
        evidenceRef: "evidence:recovery",
      }),
    ).toMatchObject(identity);
    expect(() =>
      requireSchema(acquire.inputSchema).parse({
        ...identity,
        taskRef: "task:one",
        status: "done",
      }),
    ).toThrow();
    expect(() =>
      requireSchema(acquire.inputSchema).parse({
        workspaceId: identity.workspaceId,
        clientId: identity.clientId,
        sessionId: identity.sessionId,
        taskRef: "task:one",
      }),
    ).toThrow();
  });

  it("declares only readiness and protocol-approved Side Thread domain errors", () => {
    expect(Object.keys(sparkLocalRpcSideThreadOrpcErrors).sort()).toEqual(
      [...sparkSideThreadErrorCodeOptions].sort(),
    );
    for (const procedure of Object.values(sparkLocalRpcOrpcContract.sideThread)) {
      expect(procedure["~orpc"].errorMap).toEqual({
        ...sparkLocalRpcReadinessOrpcErrors,
        ...sparkLocalRpcSideThreadOrpcErrors,
      });
    }
    expect(isSparkLocalRpcOrpcErrorCodeForMethod("side-thread.ensure", "session_not_found")).toBe(
      false,
    );
    expect(
      isSparkLocalRpcOrpcErrorCodeForMethod(
        "side-thread.ensure",
        "side_thread_generation_conflict",
      ),
    ).toBe(true);
    expect(isSparkLocalRpcOrpcErrorCodeForMethod("session.get", "session_not_found")).toBe(true);
    expect(
      isSparkLocalRpcOrpcErrorCodeForMethod("session.get", "relocation_source_not_found"),
    ).toBe(false);
  });

  it("freezes the complete typed session error family without widening other domains", () => {
    expect(Object.keys(sparkLocalRpcSessionOrpcErrors).sort()).toEqual(
      [...sparkSessionRegistryErrorCodeOptions].sort(),
    );

    const declaredCases = [
      ["session.create", "daemon_identity_unavailable"],
      ["session.create", "daemon_cwd_unavailable"],
      ["session.bind", "side_thread_mutation_forbidden"],
      ["session.snapshot", "invalid_session_snapshot"],
      ["session.snapshot", "session_snapshot_mismatch"],
      ["session.snapshot", "session_snapshot_cursor_not_found"],
      ["turn.submit", "side_thread_direct_submit_forbidden"],
      ["turn.submit", "session_cwd_unavailable"],
    ] as const;
    for (const [method, code] of declaredCases) {
      expect(isSparkLocalRpcOrpcErrorCodeForMethod(method, code), `${method}: ${code}`).toBe(true);
    }

    expect(isSparkLocalRpcOrpcErrorCodeForMethod("loop.start", "session_not_found")).toBe(false);
    expect(
      isSparkLocalRpcOrpcErrorCodeForMethod("session.create", "relocation_source_not_found"),
    ).toBe(false);
  });

  it("freezes each non-session error family and exposes it only on owning procedures", () => {
    const families = [
      [sparkLocalRpcDaemonOrpcErrors, sparkDaemonLifecycleRpcErrorCodeOptions],
      [sparkLocalRpcChannelOrpcErrors, sparkChannelRpcErrorCodeOptions],
      [sparkLocalRpcLoopOrpcErrors, sparkLoopRpcErrorCodeOptions],
      [sparkLocalRpcInvocationOrpcErrors, sparkInvocationRpcErrorCodeOptions],
      [sparkLocalRpcModelOrpcErrors, sparkModelRpcErrorCodeOptions],
      [sparkLocalRpcTaskClaimOrpcErrors, sparkTaskClaimRpcErrorCodeOptions],
      [sparkLocalRpcUplinkOrpcErrors, sparkUplinkRpcErrorCodeOptions],
      [sparkLocalRpcWorkspaceOrpcErrors, sparkWorkspaceRpcErrorCodeOptions],
      [sparkLocalRpcHumanOrpcErrors, sparkHumanRpcErrorCodeOptions],
    ] as const;
    for (const [errorMap, options] of families) {
      expect(Object.keys(errorMap).sort()).toEqual([...options].sort());
    }

    const declaredCases = [
      ["daemon.restart", "daemon_restart_conflict"],
      ["daemon.restart", "daemon_restart_unavailable"],
      ["channel.notify", "channel_delivery_outcome_unknown"],
      ["loop.start", "loop_owner_not_found"],
      ["loop.stop", "loop_not_found"],
      ["turn.status", "invocation_not_found"],
      ["turn.result", "invocation_not_terminal"],
      ["invocation.retry", "invocation_not_retryable"],
      ["provider.auth.login.status", "provider_oauth_flow_not_found"],
      ["provider.auth.login.respond", "provider_oauth_prompt_conflict"],
      ["workspace.transfer.respond", "workspace_transfer_not_found"],
      ["workspace.relocate", "relocation_target_invalid"],
      ["task.claim.acquire", "task_claim_lease_invalid"],
      ["task.claim.release", "task_claim_conflict"],
      ["task.claim.recover", "task_claim_recovery_refused"],
      ["uplink.prefer", "uplink_transfer_rejected"],
      ["human.interaction.respond", "human_wait_registry_unavailable"],
      ["session.notification.deliver", "channel_delivery_not_sent"],
      ["session.model.set", "model_control_unavailable"],
    ] as const;
    for (const [method, code] of declaredCases) {
      expect(isSparkLocalRpcOrpcErrorCodeForMethod(method, code), `${method}: ${code}`).toBe(true);
    }

    expect(isSparkLocalRpcOrpcErrorCodeForMethod("loop.start", "workspace_not_found")).toBe(false);
    expect(isSparkLocalRpcOrpcErrorCodeForMethod("model.catalog", "loop_not_found")).toBe(false);
    expect(isSparkLocalRpcOrpcErrorCodeForMethod("loop.status", "loop_not_found")).toBe(false);
    expect(isSparkLocalRpcOrpcErrorCodeForMethod("turn.status", "invocation_not_retryable")).toBe(
      false,
    );
    expect(
      isSparkLocalRpcOrpcErrorCodeForMethod(
        "provider.auth.login.status",
        "provider_oauth_prompt_conflict",
      ),
    ).toBe(false);
    expect(
      isSparkLocalRpcOrpcErrorCodeForMethod("channel.status", "channel_delivery_not_sent"),
    ).toBe(false);
    expect(isSparkLocalRpcOrpcErrorCodeForMethod("workspace.list", "workspace_not_found")).toBe(
      false,
    );
    expect(isSparkLocalRpcOrpcErrorCodeForMethod("uplink.status", "uplink_profile_not_found")).toBe(
      false,
    );
  });

  it("preserves channel delivery certainty as typed error data", () => {
    const notSent = sparkLocalRpcChannelOrpcErrors.channel_delivery_not_sent.data;
    const unknown = sparkLocalRpcChannelOrpcErrors.channel_delivery_outcome_unknown.data;
    expect(notSent.safeParse({ certainty: "not-sent" }).success).toBe(true);
    expect(unknown.safeParse({ certainty: "unknown" }).success).toBe(true);
    expect(notSent.safeParse({ certainty: "sent" }).success).toBe(false);
  });

  it("rejects driver schedules without dueAt or delayMs at the contract boundary", () => {
    expect(
      sparkLoopScheduleRequestSchema.safeParse({
        loopId: "drv_missing_due",
        generation: 1,
      }).success,
    ).toBe(false);
    expect(
      sparkLoopScheduleRequestSchema.safeParse({
        loopId: "drv_delay",
        generation: 1,
        delayMs: 0,
      }).success,
    ).toBe(true);
  });

  it("recursively rejects opaque output nodes for every procedure", () => {
    const lazyOpaqueFixture = z.lazy(() => z.object({ nested: z.array(z.unknown()) }));
    expect(opaqueSchemaPaths(lazyOpaqueFixture)).toHaveLength(1);

    for (const [method, schemas] of Object.entries(sparkLocalRpcProcedureSchemas)) {
      expect(opaqueSchemaPaths(schemas.output), method).toEqual([]);
    }
  });
});
