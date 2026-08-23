import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
  type ServerCommandEnvelope,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  attachRuntimeWebSocket,
  createWorkspaceWithLease,
  requireRuntimeControlCommand,
  submitRuntimeControlCommand,
  type RuntimeWebSocketConnection,
} from "@zendev-lab/spark-hub-coordination";
import {
  handleCommand,
  handleServerMessage,
  type MessageContext,
  type ServerSocket,
} from "./daemon.ts";
import { commandAck } from "./protocol/outbound.ts";
import {
  acknowledgeRuntimeCommandTerminal,
  runtimeCommandReceipt,
} from "./runtime-command-receipts.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

class HubSocket extends EventEmitter implements RuntimeWebSocketConnection {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.emit("close", code, Buffer.from(reason));
  }

  emitMessage(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

class CapturingDaemonSocket implements ServerSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
  }
}

it("typed runtime control reconnect executes once and stores one terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-typed-control-e2e-"));
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
  const hubDb = openMemoryDatabase();
  const daemonDb = openSparkDaemonDatabase(paths);
  try {
    migrate(hubDb);
    const now = "2026-07-15T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    hubDb
      .prepare(
        `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
         created_at, updated_at)
       VALUES (?, 'install-typed-control', 'Typed daemon', 'offline', ?, '{}', '{}', ?, ?)`,
      )
      .run(runtimeId, runtimeProtocolVersion, now, now);
    hubDb
      .prepare(
        `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, local_path, display_name, status,
         capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'typed-control', ?, 'Typed control', 'available', '{}', '{}', ?, ?)`,
      )
      .run(bindingId, runtimeId, root, now, now);
    const workspace = createWorkspaceWithLease(hubDb, {
      slug: "typed-control",
      name: "Typed control",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const daemonWorkspace = registerWorkspace(daemonDb, {
      serverUrl: "https://hub.example.test/",
      serverBindingId: bindingId,
      serverWorkspaceId: workspace.id,
      serverStatus: "available",
      localWorkspaceKey: "typed-control",
      displayName: "Typed control",
      workspaceName: "Typed control",
      workspaceSlug: "typed-control",
      localPath: root,
      now,
    });
    const queued = submitRuntimeControlCommand(hubDb, {
      runtimeId,
      workspaceId: workspace.id,
      idempotencyKey: createId("idem"),
      payload: {
        kind: "task.start.request",
        scope: "workspace",
        title: "Execute exactly once",
        payload: { prompt: "return a bounded result" },
      },
      createdAt: now,
    });

    const firstHubSocket = connectHub(hubDb, runtimeId, daemonWorkspace.id, now);
    const firstDelivery = latestCommand(firstHubSocket);
    const firstDaemonSocket = new CapturingDaemonSocket();
    let executionCount = 0;
    const daemonContext = messageContext(paths, daemonDb, runtimeId, () => {
      executionCount += 1;
    });
    await handleCommand(firstDaemonSocket, firstDelivery, daemonContext);
    expect(executionCount).toBe(1);
    expect(firstDaemonSocket.sent.some(isCommandResult)).toBe(true);

    firstHubSocket.close(1006, "drop before ack and result");
    const secondHubSocket = connectHub(hubDb, runtimeId, daemonWorkspace.id, now);
    const redelivery = latestCommand(secondHubSocket);
    expect(redelivery.commandId).toBe(firstDelivery.commandId);
    expect(redelivery.messageId).not.toBe(firstDelivery.messageId);

    const secondDaemonSocket = new CapturingDaemonSocket();
    await handleCommand(secondDaemonSocket, redelivery, daemonContext);
    expect(executionCount).toBe(1);
    const replayedTerminal = secondDaemonSocket.sent.find(isCommandResult);
    expect(replayedTerminal).toBeDefined();
    if (!replayedTerminal) throw new Error("Expected a replayed terminal result.");
    expect(replayedTerminal.payload.replayed).toBe(true);
    for (const message of secondDaemonSocket.sent) secondHubSocket.emitMessage(message);
    secondHubSocket.emitMessage(replayedTerminal);

    const hubRecord = requireRuntimeControlCommand(hubDb, queued.commandId);
    const terminalEventCount = hubDb
      .prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE kind = 'runtime.control.result' AND subject_id = ?`,
      )
      .get(queued.commandId) as { count: number };
    const daemonReceiptBeforeAck = runtimeCommandReceipt(daemonDb, queued.commandId);
    const ingestAck = secondHubSocket.sent
      .map((message) => JSON.parse(message) as { type?: string; ackOf?: string })
      .findLast(
        (message) =>
          message.type === "server.ingest_ack" && message.ackOf === replayedTerminal.messageId,
      );
    expect(ingestAck).toBeDefined();
    if (!ingestAck?.ackOf) throw new Error("Expected a result ingest acknowledgement.");
    await handleServerMessage(new CapturingDaemonSocket(), JSON.stringify(ingestAck), {
      ...daemonContext,
      onIngestAck(ackOf) {
        const message = secondHubSocket.sent
          .map((value) => JSON.parse(value) as { ackOf?: string })
          .find((value) => value.ackOf === ackOf);
        expect(message).toBeDefined();
        expect(acknowledgeRuntimeCommandTerminal(daemonDb, ackOf, now)).toBe(true);
      },
    });
    const daemonReceiptAfterAck = runtimeCommandReceipt(daemonDb, queued.commandId);
    const maxPayloadBytes = Math.max(
      ...secondDaemonSocket.sent.map((message) => Buffer.byteLength(JSON.stringify(message))),
    );

    expect(hubRecord.status).toBe("succeeded");
    expect(hubRecord.attemptCount).toBe(2);
    expect(terminalEventCount.count).toBe(1);
    expect(daemonReceiptBeforeAck?.deliveryCount).toBe(2);
    expect(daemonReceiptAfterAck?.terminalAckedAt).toBe(now);
    expect(maxPayloadBytes).toBeLessThanOrEqual(64 * 1024);
    console.log(
      "SPARK_TYPED_CONTROL_RECONNECT_TRANSCRIPT",
      JSON.stringify({
        commandId: queued.commandId,
        deliveryAttempts: hubRecord.attemptCount,
        daemonExecutionCount: executionCount,
        terminalResultCount: terminalEventCount.count,
        daemonDeliveryCount: daemonReceiptAfterAck?.deliveryCount,
        maxPayloadBytes,
      }),
    );
  } finally {
    hubDb.close();
    daemonDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function connectHub(
  db: ReturnType<typeof openMemoryDatabase>,
  runtimeId: string,
  bindingId: string,
  sentAt: string,
): HubSocket {
  const ws = new HubSocket();
  attachRuntimeWebSocket(ws, { db, runtimeId });
  ws.emitMessage({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "runtime.hello",
    sentAt,
    payload: {
      runtimeId,
      runtimeVersion: "0.1.0-test",
      supportedFeatures: ["ws-control-v1", "command-routing-v1"],
      workspaceBindings: [
        {
          bindingId,
          localWorkspaceKey: "typed-control",
          displayName: "Typed control",
          status: "available",
          capabilities: {},
          diagnostics: {},
        },
      ],
    },
  });
  return ws;
}

function latestCommand(ws: HubSocket): ServerCommandEnvelope {
  const raw = ws.sent
    .map((message) => JSON.parse(message) as unknown)
    .findLast(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        (message as { type?: string }).type === "server.command",
    );
  return serverCommandEnvelopeSchema.parse(raw);
}

function messageContext(
  paths: ReturnType<typeof resolveSparkPaths>,
  db: ReturnType<typeof openSparkDaemonDatabase>,
  runtimeId: string,
  onExecute: () => void,
): MessageContext {
  return {
    paths,
    config: { installationId: "install-typed-control", displayName: "Typed daemon", runtimeId },
    db,
    runtimeId,
    sparkHome: paths.dataDir,
    runtimeSessionId: undefined,
    setRuntimeSessionId() {},
    ensureHeartbeat() {},
    runSparkCommand: async (input) => {
      onExecute();
      const invocationId = createId("inv");
      input.emit(commandAck({ accepted: true, invocationId }, { ...input.route, invocationId }));
      return {
        invocationId,
        taskRuntimeId: `task-${invocationId}`,
        status: "succeeded",
        outputArtifactIds: [],
      };
    },
    cancelSparkInvocation: async ({ invocationId }) => ({
      invocationId,
      cancelled: false,
      message: "not used",
    }),
  };
}

function isCommandResult(value: unknown): value is {
  type: "runtime.command.result";
  messageId: string;
  payload: { replayed?: boolean };
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: string }).type === "runtime.command.result"
  );
}
