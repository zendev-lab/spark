import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelDeliveryError, ChannelRegistryError } from "@zendev-lab/dsh-channel-transports";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOrpcClient,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { resolveSparkPaths, type SparkPaths } from "@zendev-lab/spark-system";
import {
  createSparkDaemonOrpcClient,
  invokeSparkDaemonOrpcLiveMethod,
} from "@zendev-lab/spark-daemon-client";
import { createDaemonSessionRegistry } from "../session-registry.ts";
import { SparkDaemonControlError } from "../control-error.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { openSparkDaemonDatabase } from "../store/schema.js";
import { registerWorkspace } from "../store/workspaces.js";
import { handleLocalRpcLine } from "./dispatch.ts";
import { startLocalRpcOrpcServer } from "./orpc-server.ts";
import { startLocalRpcServer } from "./transport.ts";
import type { LocalRpcHandlerOptions } from "./types.ts";
import { createDaemonWorkspaceSession } from "../../../../test/support/session-fixtures.ts";

describe("local-rpc direct oRPC service", () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("round-trips live methods over daemon-orpc.sock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-orpc-live-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { SPARK_HOME: dir },
      overrides: { runtimeDir: join(dir, "r") },
    });
    const db = openSparkDaemonDatabase(paths);
    registerWorkspace(db, { localPath: join(dir, "workspace") });

    const server = await startLocalRpcOrpcServer({
      paths,
      db,
      handlerOptions: {
        getLifecycle: () => ({ state: "running" as const }),
        getExecutionStatus: () => ({
          backend: "in_process" as const,
          rootConcurrency: 8,
          questionOverflow: 1 as const,
        }),
      },
    });
    closers.push(() => server.close());

    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => {
      handle.close();
    });

    await expect(handle.client.daemon.status({})).resolves.toMatchObject({
      lifecycle: { state: "running" },
      execution: { backend: "in_process", rootConcurrency: 8, questionOverflow: 1 },
    });
    await expect(handle.client.workspace.list({})).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ localPath: join(dir, "workspace") })],
    });
    await expect(handle.client.uplink.status({})).resolves.toMatchObject({
      origins: expect.any(Array),
    });
    await expect(handle.client.invocation.list({})).resolves.toMatchObject({
      invocations: expect.any(Array),
    });
  });

  it("reads bounded durable user prompt history only over daemon oRPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-orpc-prompt-history-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: dir },
      overrides: {
        dataDir: join(dir, "data"),
        cacheDir: join(dir, "cache"),
        stateDir: join(dir, "state"),
        runtimeDir: join(dir, "run"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    closers.push(async () => db.close());
    const sessionRegistry = createDaemonSessionRegistry(join(dir, ".spark"), {
      daemonCwd: dir,
    });
    const sessionId = "prompt-history-live";
    const transcriptPath = join(dir, "prompt-history.jsonl");
    writeFileSync(
      transcriptPath,
      `${[
        {
          type: "session",
          version: 4,
          id: sessionId,
          timestamp: "2026-08-12T00:00:00.000Z",
          cwd: dir,
        },
        {
          type: "message",
          id: "prompt-1",
          parentId: null,
          timestamp: "2026-08-12T00:00:01.000Z",
          message: { role: "user", content: "first prompt" },
        },
        {
          type: "message",
          id: "answer-1",
          parentId: "prompt-1",
          timestamp: "2026-08-12T00:00:02.000Z",
          message: { role: "assistant", content: "first answer" },
        },
        {
          type: "message",
          id: "prompt-2",
          parentId: "answer-1",
          timestamp: "2026-08-12T00:00:03.000Z",
          message: { role: "user", content: "second prompt" },
        },
        {
          type: "message",
          id: "image-1",
          parentId: "prompt-2",
          timestamp: "2026-08-12T00:00:03.500Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "image",
                data: Buffer.from("native image").toString("base64"),
                mimeType: "image/png",
                name: "result.png",
              },
            ],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId,
      workspaceId: "workspace-prompt-history",
      cwd: dir,
      sessionPath: transcriptPath,
    });
    const retrySource = new SparkInvocationStore(db).submit({
      sessionId,
      task: {
        type: "session.run",
        sessionId,
        prompt: "retry this TUI turn",
        messageMetadata: {
          origin: { kind: "user", host: "tui", surface: "local" },
        },
      },
      now: "2026-08-12T00:00:04.000Z",
    });
    new SparkInvocationStore(db).complete(retrySource.invocationId, {
      status: "failed",
      errorCode: "EXECUTION_TRANSIENT",
      errorMessage: "empty response",
      now: "2026-08-12T00:00:05.000Z",
    });
    const server = await startLocalRpcOrpcServer({
      paths,
      db,
      handlerOptions: { sessionRegistry },
    });
    closers.push(() => server.close());
    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => handle.close());

    await expect(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.prompt-history", {
        sessionId,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      sessionId,
      prompts: [{ messageId: "prompt-2", text: "second prompt" }],
      totalPrompts: 2,
      truncated: true,
    });
    await expect(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.retry-target", { sessionId }),
    ).resolves.toEqual({
      sessionId,
      target: {
        invocationId: retrySource.invocationId,
        failedAt: "2026-08-12T00:00:05.000Z",
      },
    });
    const latestPage = await invokeSparkDaemonOrpcLiveMethod(
      handle.client,
      "session.snapshot-page",
      { sessionId, messageLimit: 2 },
    );
    expect(latestPage).toMatchObject({
      history: {
        totalMessages: 4,
        loadedMessages: 2,
        earlierMessages: 2,
        laterMessages: 0,
        hasEarlierMessages: true,
        nextBeforeMessageId: "prompt-2",
      },
    });
    await expect(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.media.read", {
        sessionId,
        messageId: "image-1",
        contentIndex: 0,
        limit: 7,
      }),
    ).resolves.toMatchObject({
      sessionId,
      messageId: "image-1",
      contentIndex: 0,
      mediaType: "image/png",
      name: "result.png",
      offset: 0,
      sizeBytes: 12,
      nextOffset: 7,
      complete: false,
    });
    for (const method of ["session.snapshot-page", "session.media.read"] as const) {
      await expect(
        handleLocalRpcLine(
          JSON.stringify({ id: `legacy-${method}`, method, params: { sessionId } }),
          paths,
          db,
          undefined,
          { sessionRegistry },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: `Unknown local RPC method: ${method}` },
      });
    }
    await expect(
      handleLocalRpcLine(
        JSON.stringify({
          id: "legacy-prompt-history",
          method: "session.prompt-history",
          params: { sessionId, limit: 1 },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "Unknown local RPC method: session.prompt-history" },
    });
    await expect(
      handleLocalRpcLine(
        JSON.stringify({
          id: "legacy-retry-target",
          method: "session.retry-target",
          params: { sessionId },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "Unknown local RPC method: session.retry-target" },
    });
  });

  it("preserves actionable daemon restart scheduling failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-orpc-restart-error-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { SPARK_HOME: dir },
      overrides: { runtimeDir: join(dir, "r") },
    });
    const db = openSparkDaemonDatabase(paths);
    const restartLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let restartFailure =
      "Spark daemon restart helper IPC is unavailable. authorization: Bearer super-secret Authorization=QQBot qq-secret file:///root/private/launcher";
    const server = await startLocalRpcOrpcServer({
      paths,
      db,
      handlerOptions: {
        onRestart: async () => {
          throw new Error(restartFailure);
        },
      },
    });
    closers.push(() => server.close());
    closers.push(async () => db.close());
    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => handle.close());

    const error = await rejectionOf(handle.client.daemon.restart({}));
    expect(error).toMatchObject({
      code: "daemon_restart_unavailable",
      message: expect.stringContaining("Inspect `spark daemon logs --lines 100`"),
    });
    expect(error).not.toMatchObject({ message: expect.stringContaining("super-secret") });
    expect(error).not.toMatchObject({ message: expect.stringContaining("/root/private") });
    expect(restartLog).toHaveBeenCalledWith(
      "[spark-daemon] restart scheduling failed: restart helper IPC is unavailable",
    );
    expect(restartLog).not.toHaveBeenCalledWith(expect.stringContaining("super-secret"));
    expect(restartLog).not.toHaveBeenCalledWith(expect.stringContaining("qq-secret"));
    expect(restartLog).not.toHaveBeenCalledWith(expect.stringContaining("file:///root/private"));

    restartLog.mockClear();
    restartFailure =
      "unexpected authorization: Bearer unknown-secret file:///root/private/unknown-launcher";
    const unknownError = await rejectionOf(handle.client.daemon.restart({}));
    expect(unknownError).toMatchObject({
      code: "daemon_restart_unavailable",
      message: expect.stringContaining("Inspect `spark daemon logs --lines 100`"),
    });
    expect(restartLog).toHaveBeenCalledWith(
      "[spark-daemon] restart scheduling failed: internal restart scheduling failure",
    );
    expect(restartLog).not.toHaveBeenCalledWith(expect.stringContaining("unknown-secret"));
    expect(restartLog).not.toHaveBeenCalledWith(expect.stringContaining("unknown-launcher"));
    restartLog.mockRestore();
  });

  it("waits for an admitted handler after the socket force-closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-orpc-close-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { SPARK_HOME: dir },
      overrides: { runtimeDir: join(dir, "r") },
    });
    const db = openSparkDaemonDatabase(paths);
    const started = deferred<void>();
    const restart = deferred<{
      accepted: true;
      state: "draining";
      restartId: string;
      processInstanceId: string;
      processGeneration: string;
      targetInstanceId: string;
      targetGeneration: string;
      requestedAt: string;
    }>();
    const server = await startLocalRpcServer({
      paths,
      sparkHome: join(dir, ".spark"),
      db,
      forceCloseTimeoutMs: 10,
      onRestart: async () => {
        started.resolve();
        return await restart.promise;
      },
    });
    const handle = await createSparkDaemonOrpcClient({ paths });
    const request = handle.client.daemon.restart({}).catch(() => undefined);
    await started.promise;

    let closeSettled = false;
    const closing = server.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closeSettled).toBe(false);

    restart.resolve({
      accepted: true,
      state: "draining",
      restartId: "restart_close_test",
      processInstanceId: "instance_current",
      processGeneration: "generation_current",
      targetInstanceId: "instance_target",
      targetGeneration: "generation_target",
      requestedAt: "2026-07-27T12:00:00.000Z",
    });
    await closing;
    await request;
    handle.close();
    db.close();
  });

  it("preserves registered session errors across direct oRPC and the legacy adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-orpc-session-errors-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: dir },
      overrides: {
        dataDir: join(dir, "data"),
        cacheDir: join(dir, "cache"),
        stateDir: join(dir, "state"),
        runtimeDir: join(dir, "run"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    closers.push(async () => {
      db.close();
    });
    const sparkHome = join(dir, ".spark");
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonCwd: dir,
    });
    const server = await startLocalRpcOrpcServer({
      paths,
      db,
      handlerOptions: { sessionRegistry },
    });
    closers.push(() => server.close());
    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => {
      handle.close();
    });

    const createInput = {
      sessionId: "missing-daemon-identity",
      scope: { kind: "daemon" as const },
    };
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "legacy-create", method: "session.create", params: createInput }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_scope" },
    });

    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "parent-session",
      workspaceId: "workspace-errors",
      cwd: dir,
    });
    const child = await sessionRegistry.ensureSideThread({
      parentSessionId: "parent-session",
      mode: "contextual",
    });
    const bindInput = {
      sessionId: child.sessionId,
      externalKey: "qqbot:c2c:side-thread",
    };
    await expect(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.bind", bindInput),
    ).resolves.toMatchObject({ sessionId: child.sessionId });
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "legacy-bind", method: "session.bind", params: bindInput }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({ ok: true });

    const submitInput = {
      sessionId: child.sessionId,
      prompt: "must use the Side Thread controller",
    };
    await expect(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "turn.submit", submitInput),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "legacy-submit", method: "turn.submit", params: submitInput }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({ ok: true });

    const mismatchPath = join(dir, "mismatched-session.jsonl");
    writeFileSync(
      mismatchPath,
      `${JSON.stringify({
        type: "session",
        id: "different-session",
        timestamp: "2026-07-27T12:00:00.000Z",
      })}\n`,
    );
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "snapshot-mismatch",
      workspaceId: "workspace-errors",
      cwd: dir,
      sessionPath: mismatchPath,
    });
    const mismatchInput = { sessionId: "snapshot-mismatch" };
    const mismatchError = await rejectionOf(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.snapshot", mismatchInput),
    );
    expect(mismatchError).toMatchObject({ code: "session_snapshot_mismatch" });
    await expect(
      handleLocalRpcLine(
        JSON.stringify({
          id: "legacy-snapshot-mismatch",
          method: "session.snapshot",
          params: mismatchInput,
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "session_snapshot_mismatch" },
    });

    const invalidPath = join(dir, "invalid-session.jsonl");
    writeFileSync(invalidPath, `${JSON.stringify({ type: "invalid" })}\n`);
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "snapshot-invalid",
      workspaceId: "workspace-errors",
      cwd: dir,
      sessionPath: invalidPath,
    });
    const invalidError = await rejectionOf(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.snapshot", {
        sessionId: "snapshot-invalid",
      }),
    );
    expect(invalidError).toMatchObject({ code: "invalid_session_snapshot" });
    await expect(
      handleLocalRpcLine(
        JSON.stringify({
          id: "legacy-snapshot-invalid",
          method: "session.snapshot",
          params: { sessionId: "snapshot-invalid" },
        }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_session_snapshot" },
    });
  });

  it("preserves expected driver, invocation, and OAuth errors across both transports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-orpc-domain-errors-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: dir },
      overrides: {
        dataDir: join(dir, "data"),
        cacheDir: join(dir, "cache"),
        stateDir: join(dir, "state"),
        runtimeDir: join(dir, "run"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    closers.push(async () => {
      db.close();
    });
    const sessionRegistry = createDaemonSessionRegistry(join(dir, ".spark"), {
      daemonId: "domain-error-daemon",
      daemonCwd: dir,
    });
    new SparkInvocationStore(db).submit({
      invocationId: "inv_11111111111111111111111111111111",
      task: { type: "session.run", sessionId: "missing-owner", prompt: "queued" },
    });
    const unusedModelControlMethod = async (): Promise<never> => {
      throw new Error("unused model-control method");
    };
    const modelControl: SparkDaemonModelControl = {
      snapshot: unusedModelControlMethod,
      setDefaultModel: unusedModelControlMethod,
      setEnabledModels: unusedModelControlMethod,
      setSessionModel: unusedModelControlMethod,
      setSessionThinkingLevel: unusedModelControlMethod,
      setApiKey: unusedModelControlMethod,
      importPiAuth: unusedModelControlMethod,
      logout: unusedModelControlMethod,
      startOAuth: unusedModelControlMethod,
      async oauthStatus(flowId: string) {
        throw new SparkDaemonControlError(
          "provider_oauth_flow_not_found",
          `Unknown OAuth flow: ${flowId}`,
        );
      },
      respondOAuth: unusedModelControlMethod,
      cancelOAuth: unusedModelControlMethod,
      effectiveModel: unusedModelControlMethod,
      effectiveThinkingLevel: unusedModelControlMethod,
      prepareModel: unusedModelControlMethod,
      testModel: unusedModelControlMethod,
    };
    const channelStatus = {
      plane: "daemon" as const,
      resource: "channel" as const,
      workspaceId: "ws_channel",
      configPath: join(dir, "channels.json"),
      available: true as const,
      configured: true,
      ingressEnabled: true,
      state: "running" as const,
      adapters: [],
      routes: [],
      observedAt: "2026-07-27T12:00:00.000Z",
      text: "running",
    };
    const handlerOptions: LocalRpcHandlerOptions = {
      sessionRegistry,
      modelControl,
      channelIngress: {
        status: () => channelStatus,
        configure: async () => channelStatus,
        reload: async () => channelStatus,
        async notify(input) {
          if (input.text === "not-sent") {
            throw new ChannelDeliveryError("provider rejected before send", "not-sent");
          }
          if (input.text === "unknown") {
            throw new ChannelDeliveryError("provider outcome is unknown", "unknown");
          }
          throw new ChannelRegistryError("adapter_not_found", "adapter is missing");
        },
      },
    };
    const server = await startLocalRpcOrpcServer({ paths, db, handlerOptions });
    closers.push(() => server.close());
    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => {
      handle.close();
    });

    await expectRpcErrorParity({
      client: handle.client,
      paths,
      db,
      handlerOptions,
      method: "loop.start",
      params: {
        binding: { goalId: "goal-missing" },
        ownerSessionId: "missing-owner",
        continuity: "session",
        prompt: "drive",
        cwd: dir,
      },
      code: "loop_owner_not_found",
    });
    await expectRpcErrorParity({
      client: handle.client,
      paths,
      db,
      handlerOptions,
      method: "loop.stop",
      params: { loopId: "drv_missing" },
      code: "loop_not_found",
    });
    for (const method of ["turn.status", "turn.result"] as const) {
      await expectRpcErrorParity({
        client: handle.client,
        paths,
        db,
        handlerOptions,
        method,
        params: { invocationId: "inv_00000000000000000000000000000000" },
        code: "invocation_not_found",
      });
    }
    await expectRpcErrorParity({
      client: handle.client,
      paths,
      db,
      handlerOptions,
      method: "invocation.retry",
      params: { invocationId: "inv_11111111111111111111111111111111" },
      code: "invocation_not_retryable",
    });
    await expectRpcErrorParity({
      client: handle.client,
      paths,
      db,
      handlerOptions,
      method: "provider.auth.login.status",
      params: { flowId: "flow_missing" },
      code: "provider_oauth_flow_not_found",
    });

    for (const [text, code, certainty] of [
      ["not-sent", "channel_delivery_not_sent", "not-sent"],
      ["unknown", "channel_delivery_outcome_unknown", "unknown"],
    ] as const) {
      const params = {
        workspaceId: "ws_channel",
        action: "send" as const,
        adapter: "missing",
        recipient: "recipient",
        text,
        deliveryId: `delivery-${text}`,
      };
      const directError = await rejectionOf(
        invokeSparkDaemonOrpcLiveMethod(handle.client, "channel.notify", params),
      );
      expect(directError).toMatchObject({ code, data: { certainty } });
      await expect(
        handleLocalRpcLine(
          JSON.stringify({
            id: `legacy-channel-${text}`,
            method: "channel.notify",
            params,
          }),
          paths,
          db,
          undefined,
          handlerOptions,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code, certainty },
      });
    }
    await expectRpcErrorParity({
      client: handle.client,
      paths,
      db,
      handlerOptions,
      method: "channel.notify",
      params: {
        action: "send",
        adapter: "missing",
        recipient: "recipient",
        text: "registry-error",
        deliveryId: "delivery-registry",
      },
      code: "channel_adapter_not_found",
    });

    const unknownDirect = await rejectionOf(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "model.catalog", {}),
    );
    expect(unknownDirect).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(String(unknownDirect)).not.toContain("unused model-control method");
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "legacy-unknown", method: "model.catalog", params: {} }),
        paths,
        db,
        undefined,
        handlerOptions,
      ),
    ).resolves.toEqual({
      id: "legacy-unknown",
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Spark daemon request failed.",
      },
    });
  });

  it("rejects a structured error that is not declared by the invoked procedure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s-orpc-domain-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: dir },
      overrides: {
        dataDir: join(dir, "data"),
        cacheDir: join(dir, "cache"),
        stateDir: join(dir, "state"),
        runtimeDir: join(dir, "run"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    closers.push(async () => {
      db.close();
    });
    const crossDomainFailure = async (): Promise<never> => {
      throw new SparkDaemonControlError("loop_not_found", "cross-domain detail must not escape");
    };
    const modelControl: SparkDaemonModelControl = {
      snapshot: crossDomainFailure,
      setDefaultModel: crossDomainFailure,
      setEnabledModels: crossDomainFailure,
      setSessionModel: crossDomainFailure,
      setSessionThinkingLevel: crossDomainFailure,
      setApiKey: crossDomainFailure,
      importPiAuth: crossDomainFailure,
      logout: crossDomainFailure,
      startOAuth: crossDomainFailure,
      oauthStatus: crossDomainFailure,
      respondOAuth: crossDomainFailure,
      cancelOAuth: crossDomainFailure,
      effectiveModel: crossDomainFailure,
      effectiveThinkingLevel: crossDomainFailure,
      prepareModel: crossDomainFailure,
      testModel: crossDomainFailure,
    };
    const handlerOptions: LocalRpcHandlerOptions = { modelControl };
    const server = await startLocalRpcOrpcServer({ paths, db, handlerOptions });
    closers.push(() => server.close());
    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => {
      handle.close();
    });

    const direct = await rejectionOf(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "model.catalog", {}),
    );
    expect(direct).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(String(direct)).not.toContain("cross-domain detail");

    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "legacy-cross-domain", method: "model.catalog", params: {} }),
        paths,
        db,
        undefined,
        handlerOptions,
      ),
    ).resolves.toEqual({
      id: "legacy-cross-domain",
      ok: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Spark daemon request failed.",
      },
    });
  });
});

async function expectRpcErrorParity<M extends SparkLocalRpcMethod>(input: {
  client: SparkLocalRpcOrpcClient;
  paths: SparkPaths;
  db: DatabaseSync;
  handlerOptions: LocalRpcHandlerOptions;
  method: M;
  params: SparkLocalRpcInput<M>;
  code: string;
}): Promise<void> {
  const directError = await rejectionOf(
    invokeSparkDaemonOrpcLiveMethod(input.client, input.method, input.params),
  );
  expect(directError).toMatchObject({ code: input.code });
  await expect(
    handleLocalRpcLine(
      JSON.stringify({
        id: `legacy-${input.method}`,
        method: input.method,
        params: input.params,
      }),
      input.paths,
      input.db,
      undefined,
      input.handlerOptions,
    ),
  ).resolves.toMatchObject({ ok: false, error: { code: input.code } });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
