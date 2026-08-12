import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultArtifactStore, defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import {
  sparkLocalRpcProcedureSchemas,
  type SparkLocalRpcMethod,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { upsertSparkDaemonServerProfile } from "../server-profiles.ts";
import { createDaemonSessionRegistry } from "../session-registry.ts";
import { createDaemonWorkspaceSession } from "../../../../test/support/session-fixtures.ts";
import { SparkReproFormalEvidenceReceiptStore } from "../store/repro-formal-evidence.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { SparkTokenUsageStore } from "../store/token-usage.ts";
import { registerWorkspace } from "../store/workspaces.ts";
import { handleLocalRpcLine } from "./dispatch.ts";
import { invokeLocalRpcService, localRpcServiceHandlerMethodGroups } from "./service.ts";
import { parseLocalRpcServiceOutput, SparkDaemonStillStartingError } from "./types.ts";

describe("transport-neutral local RPC service", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy envelope outside the shared service", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    const { paths, db } = createFixture();
    registerWorkspace(db, { localPath: join(paths.dataDir, "workspace") });

    const direct = await invokeLocalRpcService("workspace.list", {}, { paths, db });
    const legacy = await handleLocalRpcLine(
      JSON.stringify({ id: "rpc_workspace_list", method: "workspace.list" }),
      paths,
      db,
      undefined,
    );

    expect(direct).not.toHaveProperty("id");
    expect(direct).not.toHaveProperty("ok");
    expect(legacy).toEqual({ id: "rpc_workspace_list", ok: true, result: direct });
    db.close();
  });

  it("routes session.compact through the typed service into a durable invocation", async () => {
    const { paths, db } = createFixture();
    const workspaceRoot = join(paths.dataDir, "compact-workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const sessionRegistry = createDaemonSessionRegistry(join(paths.dataDir, ".spark"), {
      daemonId: "compact-service-test",
      daemonCwd: workspaceRoot,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-compact-service",
      workspaceId: "workspace-compact-service",
      cwd: workspaceRoot,
    });
    const onInvocationQueued = vi.fn();

    const result = await invokeLocalRpcService(
      "session.compact",
      {
        sessionId: "session-compact-service",
        customInstructions: "preserve durable decisions",
        idempotencyKey: "compact-service-once",
      },
      {
        paths,
        db,
        handlerOptions: { sessionRegistry, onInvocationQueued },
      },
    );

    expect(result).toMatchObject({ status: "queued", invocationId: expect.any(String) });
    expect(new SparkInvocationStore(db).require(result.invocationId)).toMatchObject({
      sourceKind: "session.compact",
      task: {
        type: "session.compact",
        sessionId: "session-compact-service",
        customInstructions: "preserve durable decisions",
      },
    });
    expect(onInvocationQueued).toHaveBeenCalledOnce();
    db.close();
  });

  it("records only registered-verifier formal Evidence receipts in daemon-owned SQLite", async () => {
    const { paths, db } = createFixture();
    const cwd = join(paths.dataDir, "workspace");
    mkdirSync(cwd, { recursive: true });
    const workspace = registerWorkspace(db, { localPath: cwd });
    const evidence = await defaultEvidenceStore(cwd).put({
      ref: "evidence:formal-proof",
      kind: "record",
      title: "formal proof",
      format: "json",
      body: { signed: true },
      provenance: { producer: "spark" },
    });
    if (!evidence.hash) throw new Error("test Evidence lacks a durable hash");
    const candidate = {
      workspaceCwd: cwd,
      evidenceRef: evidence.ref,
      evidenceHash: evidence.hash,
      reproId: "repro-rpc",
      requirementId: "alignment",
      stepId: "S1",
      planRevision: 3,
      stepDefinitionDigest: "digest:S1",
      invocationClass: "owning_entrypoint" as const,
      evidenceClass: "entrypoint" as const,
      profileDigest: "b".repeat(64),
      topologyDigest: "c".repeat(64),
    };
    const receipt = {
      schema: "spark.repro.formal-evidence-receipt/v1" as const,
      ...candidate,
      workspaceCwd: workspace.localPath,
      verifierId: "registered-verifier",
      verifierVersion: "1",
      verdict: "accepted" as const,
      verifiedAt: "2026-08-09T00:00:00.000Z",
      stale: false,
      superseded: false,
    };

    await expect(
      invokeLocalRpcService(
        "repro.formal-evidence.record",
        { workspaceCwd: cwd, candidate },
        { paths, db },
      ),
    ).rejects.toThrow("no registered daemon formal Evidence verifier");
    await expect(
      invokeLocalRpcService(
        "repro.formal-evidence.record",
        { workspaceCwd: cwd, candidate: { ...candidate, evidenceHash: "d".repeat(64) } },
        {
          paths,
          db,
          handlerOptions: {
            reproFormalEvidenceVerifier: {
              async verify() {
                throw new Error("must not verify a mismatched durable Evidence hash");
              },
            },
          },
        },
      ),
    ).rejects.toThrow("does not match durable workspace Evidence");
    await expect(
      invokeLocalRpcService(
        "repro.formal-evidence.record",
        { workspaceCwd: cwd, candidate },
        {
          paths,
          db,
          handlerOptions: {
            reproFormalEvidenceVerifier: {
              async verify(actual, body) {
                expect(actual).toEqual(candidate);
                expect(body).toEqual({ signed: true });
                return {
                  verifierId: "registered-verifier",
                  verifierVersion: "1",
                  verdict: "accepted",
                  verifiedAt: "2026-08-09T00:00:00.000Z",
                };
              },
            },
          },
        },
      ),
    ).resolves.toEqual({ recorded: true, receipt });
    expect(new SparkReproFormalEvidenceReceiptStore(db).get(cwd, candidate)).toEqual(receipt);
    db.close();
  });

  it("serves the persisted repro token aggregate through read-only usage.summary", async () => {
    const { paths, db } = createFixture();
    const invocations = new SparkInvocationStore(db);
    const tokenUsage = new SparkTokenUsageStore(db);
    const invocation = invocations.submit({
      sessionId: "session-usage-rpc",
      prompt: "measure",
      now: "2026-08-03T00:00:00.000Z",
    });
    invocations.claimNext("worker", "2026-08-03T00:00:01.000Z");
    tokenUsage.recordTurnComplete({
      invocationId: invocation.invocationId,
      scope: { kind: "repro", reproId: "repro-rpc" },
      event: {
        type: "turn_complete",
        message: {
          provider: "openai",
          model: "test-model",
          responseId: "response-rpc",
          content: [{ type: "text", text: "done" }],
          usage: {
            input: 5,
            output: 3,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 999,
          },
          stopReason: "stop",
          timestamp: Date.parse("2026-08-03T00:00:02.000Z"),
        },
        reason: "stop",
      },
    });
    invocations.complete(invocation.invocationId, {
      status: "succeeded",
      now: "2026-08-03T00:00:03.000Z",
    });
    const before = tokenUsage.receiptCount();

    const result = await invokeLocalRpcService(
      "usage.summary",
      { scope: { kind: "repro", reproId: "repro-rpc" } },
      { paths, db },
    );

    expect(result).toMatchObject({
      scope: { kind: "repro", reproId: "repro-rpc" },
      quality: "exact",
      totalTokens: 11,
      activeExecutionCount: 0,
      responseCount: 1,
      missingResponseCount: 0,
      reported: { totalTokens: 11 },
      estimated: { totalTokens: 0 },
      byExecutionKind: { root_session: { totalTokens: 11 } },
      byModel: { "openai/test-model": { totalTokens: 11 } },
    });
    expect(result).not.toHaveProperty("executionCount");
    expect(result).not.toHaveProperty("unsupportedSources");
    const persistence = await invokeLocalRpcService(
      "usage.persistence",
      { scope: { kind: "repro", reproId: "repro-rpc" } },
      { paths, db },
    );
    expect(persistence).toMatchObject({
      scope: { kind: "repro", reproId: "repro-rpc" },
      byPersistence: {
        anonymous: { quality: "unknown", totalTokens: 0, responseCount: 0 },
        persistent: { quality: "exact", totalTokens: 11, responseCount: 1 },
      },
    });
    expect(persistence).not.toHaveProperty("receipts");
    expect(tokenUsage.receiptCount()).toBe(before);
    db.close();
  });

  it("imports only explicitly attributed legacy usage and records provable coverage gaps", async () => {
    const { paths, db } = createFixture();
    const invocation = new SparkInvocationStore(db).submit({
      sessionId: "session-legacy-rpc",
      prompt: "legacy",
      now: "2026-08-03T00:00:00.000Z",
    });
    const common = {
      invocationId: invocation.invocationId,
      scope: { kind: "repro" as const, reproId: "repro-legacy-rpc" },
      executionKind: "root_session" as const,
      persistence: "persistent" as const,
      observedAt: "2026-08-03T00:00:01.000Z",
    };
    const response = {
      ...common,
      action: "response" as const,
      sourceEventId: "assistant-entry-1",
      provider: "openai",
      model: "legacy-model",
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        totalTokens: 9,
      },
    };
    await expect(invokeLocalRpcService("usage.backfill", response, { paths, db })).resolves.toEqual(
      { recorded: true },
    );
    await expect(invokeLocalRpcService("usage.backfill", response, { paths, db })).resolves.toEqual(
      { recorded: false },
    );
    await expect(
      invokeLocalRpcService(
        "usage.backfill",
        {
          ...common,
          action: "coverage_gap",
          sourceEventId: "assistant-range-unproven",
          executionId: "legacy-gap:assistant-range-unproven",
          reason: "unproven_seed_boundary",
        },
        { paths, db },
      ),
    ).resolves.toEqual({ recorded: true });

    const aggregate = await invokeLocalRpcService(
      "usage.summary",
      { scope: common.scope },
      { paths, db },
    );
    expect(aggregate).toMatchObject({
      quality: "partial",
      totalTokens: 9,
      responseCount: 2,
      missingResponseCount: 1,
      coverageGapCount: 1,
    });
    db.close();
  });

  it("shares readiness semantics while preserving the legacy error envelope", async () => {
    const { paths, db } = createFixture();
    const handlerOptions = { isReady: () => false };

    await expect(
      invokeLocalRpcService("session.list", {}, { paths, db, handlerOptions }),
    ).rejects.toBeInstanceOf(SparkDaemonStillStartingError);
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "rpc_starting", method: "session.list", params: {} }),
        paths,
        db,
        undefined,
        handlerOptions,
      ),
    ).resolves.toEqual({
      id: "rpc_starting",
      ok: false,
      error: {
        code: "daemon_starting",
        message: "Spark daemon is still starting; retry after readiness.",
      },
    });
    db.close();
  });

  it("never projects uplink credentials through service or legacy results", async () => {
    const { paths, db } = createFixture();
    const serverUrl = "https://hub.example.test/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl,
      runtimeId: "rt_private",
      runtimeToken: "token_private",
      refreshToken: "refresh_private",
    });

    const direct = await invokeLocalRpcService("uplink.park", { serverUrl }, { paths, db });
    const legacy = await handleLocalRpcLine(
      JSON.stringify({
        id: "rpc_unpark",
        method: "uplink.unpark",
        params: { serverUrl },
      }),
      paths,
      db,
      undefined,
    );

    expect(direct).toEqual({ serverUrl, parked: true });
    expect(legacy).toEqual({
      id: "rpc_unpark",
      ok: true,
      result: { serverUrl, parked: false },
    });
    expect(JSON.stringify({ direct, legacy })).not.toContain("private");
    db.close();
  });

  it("executes internal Lens status through the typed daemon procedure", async () => {
    const { paths, db } = createFixture();
    const cwd = join(paths.dataDir, "workspace");
    mkdirSync(cwd, { recursive: true });

    const health = await invokeLocalRpcService(
      "lens.execute",
      {
        cwd,
        toolCallId: "lens-health-1",
        operationId: "lens:health:service-test",
        params: { action: "status" },
      },
      { paths, db },
    );

    expect(health.content[0]?.text).toContain("typescript-dual-verification-v1");
    expect(health.details).toMatchObject({
      health: {
        providers: [{ providerId: "typescript-6-tsc" }, { providerId: "vite-plus-native-check" }],
      },
    });
    db.close();
  });

  it("resolves Lens artifact scope from workspace state for a nested session cwd", async () => {
    const { paths, db } = createFixture();
    const workspaceRoot = join(paths.dataDir, "workspace");
    const sessionCwd = join(workspaceRoot, "packages", "demo");
    const worktree = join(paths.dataDir, "managed-worktree");
    mkdirSync(sessionCwd, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const workspace = registerWorkspace(db, { localPath: workspaceRoot });
    const artifact = await defaultArtifactStore(workspaceRoot).put({
      kind: "git_change",
      title: "Managed Lens target",
      body: {
        schemaVersion: 2,
        kind: "git_change",
        repository: { forge: "github", repo: "zendev-lab/spark" },
        trunk: "main",
        worktree: {
          path: worktree,
          branch: "feature/lens",
          ownership: "spark",
          status: "attached",
        },
        stack: {
          authority: "gh-stack",
          currentBranch: "feature/lens",
          entries: [
            {
              branch: "feature/lens",
              base: "base-oid",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
          ],
        },
        lifecycle: "local",
      },
    });

    const health = await invokeLocalRpcService(
      "lens.execute",
      {
        cwd: sessionCwd,
        toolCallId: "lens-artifact-health-1",
        operationId: "lens:artifact-health:service-test",
        params: { action: "status", artifactRef: artifact.ref },
        hostContext: { workspaceId: workspace.id },
      },
      { paths, db },
    );

    expect(health.content[0]?.text).toContain("Lens status");
    expect(health.details).toMatchObject({
      health: { profile: "typescript-dual-verification-v1" },
    });
    db.close();
  });

  it("executes daemon-owned file and artifact tools through typed procedures", async () => {
    const { paths, db } = createFixture();
    const cwd = join(paths.dataDir, "workspace");
    mkdirSync(cwd, { recursive: true });

    const write = await invokeLocalRpcService(
      "file.execute",
      {
        cwd,
        tool: "write",
        toolCallId: "write-1",
        operationId: "file:write:service-test",
        params: {
          path: "note.md",
          content: "# daemon-owned\n",
          expectedVersion: "missing",
        },
      },
      { paths, db },
    );
    expect(write.isError).not.toBe(true);

    const read = await invokeLocalRpcService(
      "file.execute",
      {
        cwd,
        tool: "read",
        toolCallId: "read-1",
        operationId: "file:read:service-test",
        params: { path: "note.md" },
      },
      { paths, db },
    );
    expect(read.content[0]?.text).toContain("# daemon-owned");

    const artifact = await invokeLocalRpcService(
      "artifact.execute",
      {
        cwd,
        toolCallId: "artifact-1",
        operationId: "artifact:service-test",
        params: {
          action: "create",
          kind: "document",
          title: "Daemon document",
          content: "owned by daemon",
        },
      },
      { paths, db },
    );
    expect(artifact.content[0]?.text).toContain("Created artifact:");
    db.close();
  });

  it("exhaustively groups methods behind their protocol output parser", () => {
    const groupedMethods = Object.values(localRpcServiceHandlerMethodGroups).flat();
    const catalogMethods = Object.keys(sparkLocalRpcProcedureSchemas) as SparkLocalRpcMethod[];

    expect(new Set(groupedMethods).size).toBe(groupedMethods.length);
    expect([...groupedMethods].sort()).toEqual([...catalogMethods].sort());

    for (const method of catalogMethods) {
      const raw = { rawMethod: method };
      const sentinel = { parsedMethod: method };
      const outputSchema = sparkLocalRpcProcedureSchemas[method].output as {
        parse(value: unknown): unknown;
      };
      const parse = vi.spyOn(outputSchema, "parse").mockReturnValueOnce(sentinel);

      expect(parseLocalRpcServiceOutput(method, raw)).toBe(sentinel);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse).toHaveBeenCalledWith(raw);
      parse.mockRestore();
    }
  });

  function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "spark-local-rpc-service-"));
    roots.push(root);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    return { paths, db: openSparkDaemonDatabase(paths) };
  }
});
