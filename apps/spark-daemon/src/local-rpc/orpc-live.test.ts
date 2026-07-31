import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelDeliveryError, ChannelRegistryError } from "@zendev-lab/spark-channels";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOrpcClient,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { resolveSparkPaths, type SparkPaths } from "@zendev-lab/spark-system";
import {
  createSparkDaemonOrpcClient,
  invokeSparkDaemonOrpcLiveMethod,
} from "@zendev-lab/spark-daemon-client/orpc";
import { createDaemonSessionRegistry } from "../session-registry.ts";
import { SparkDaemonControlError } from "../control-error.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { openSparkDaemonDatabase } from "../store/schema.js";
import { ensureLocalWorkspace } from "../store/workspaces.js";
import { handleLocalRpcLine } from "./dispatch.ts";
import { startLocalRpcOrpcServer } from "./orpc-server.ts";
import { startLocalRpcServer } from "./transport.ts";
import type { LocalRpcHandlerOptions } from "./types.ts";

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
    ensureLocalWorkspace(db, { localPath: join(dir, "workspace") });

    const server = await startLocalRpcOrpcServer({
      paths,
      db,
      handlerOptions: {
        getLifecycle: () => ({ state: "running" as const }),
      },
    });
    closers.push(() => server.close());

    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => {
      handle.close();
    });

    await expect(handle.client.daemon.status({})).resolves.toMatchObject({
      lifecycle: { state: "running" },
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
    const createError = await rejectionOf(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.create", createInput),
    );
    expect(createError).toMatchObject({ code: "daemon_identity_unavailable" });
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
      error: { code: "daemon_identity_unavailable" },
    });

    await sessionRegistry.create({
      sessionId: "parent-session",
      scope: { kind: "workspace", workspaceId: "workspace-errors" },
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
    const bindError = await rejectionOf(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "session.bind", bindInput),
    );
    expect(bindError).toMatchObject({ code: "side_thread_mutation_forbidden" });
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "legacy-bind", method: "session.bind", params: bindInput }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "side_thread_mutation_forbidden" },
    });

    const submitInput = {
      sessionId: child.sessionId,
      prompt: "must use the Side Thread controller",
    };
    const submitError = await rejectionOf(
      invokeSparkDaemonOrpcLiveMethod(handle.client, "turn.submit", submitInput),
    );
    expect(submitError).toMatchObject({ code: "side_thread_direct_submit_forbidden" });
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "legacy-submit", method: "turn.submit", params: submitInput }),
        paths,
        db,
        undefined,
        { sessionRegistry },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "side_thread_direct_submit_forbidden" },
    });

    const mismatchPath = join(dir, "mismatched-session.jsonl");
    writeFileSync(
      mismatchPath,
      `${JSON.stringify({
        type: "session",
        id: "different-session",
        timestamp: "2026-07-27T12:00:00.000Z",
      })}\n`,
    );
    await sessionRegistry.create({
      sessionId: "snapshot-mismatch",
      scope: { kind: "workspace", workspaceId: "workspace-errors" },
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
    await sessionRegistry.create({
      sessionId: "snapshot-invalid",
      scope: { kind: "workspace", workspaceId: "workspace-errors" },
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
        async notify(_workspaceId, input) {
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
      method: "driver.start",
      params: {
        kind: "goal",
        ownerSessionId: "missing-owner",
        continuity: "session",
        prompt: "drive",
        cwd: dir,
      },
      code: "driver_owner_not_found",
    });
    await expectRpcErrorParity({
      client: handle.client,
      paths,
      db,
      handlerOptions,
      method: "driver.stop",
      params: { driverId: "drv_missing" },
      code: "driver_not_found",
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
        workspaceId: "ws_channel",
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
      throw new SparkDaemonControlError("driver_not_found", "cross-domain detail must not escape");
    };
    const modelControl: SparkDaemonModelControl = {
      snapshot: crossDomainFailure,
      setDefaultModel: crossDomainFailure,
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
