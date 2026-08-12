import {
  runtimeEphemeralSecretResultEnvelopeSchema,
  runtimeHeartbeatEnvelopeSchema,
  runtimeHelloEnvelopeSchema,
} from "@zendev-lab/spark-protocol/runtime";
import { createId } from "@zendev-lab/spark-protocol/domain";
import { bearerTokenFromAuthorization } from "@zendev-lab/spark-system";
import {
  registerRuntimeControlDispatcher,
  RuntimeControlCommandError,
} from "../runtime-control.ts";
import { hashSecret } from "../security.ts";
import {
  recordRuntimeEphemeralSecretProjection,
  registerRuntimeEphemeralSecretDispatcher,
} from "../runtime-model-channel-control.ts";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";

import {
  parseRuntimeWebSocketMessage,
  sendRuntimeProtocolDiagnostic,
  shouldCloseForRuntimeProtocolDiagnostic,
} from "./diagnostics.ts";
import type { RuntimeWebSocketContext, RuntimeWebSocketConnection } from "./types.ts";
import {
  handleMvpRuntimeMessage,
  sendReconcileRequest,
  handleHello,
  handleHeartbeat,
  upsertWorkspaceBindings,
  listWorkspaceBindingAssignments,
  flushPendingRuntimeDeliveries,
  markSessionClosed,
  sendError,
  runtimeTokenScopes,
} from "./protocol.ts";

export function attachRuntimeWebSocket(
  ws: WebSocket | RuntimeWebSocketConnection,
  context: RuntimeWebSocketContext,
): void {
  let runtimeSessionId: string | undefined;
  let unregisterControlDispatcher: (() => void) | undefined;
  let unregisterEphemeralSecretDispatcher: (() => void) | undefined;
  const pendingEphemeralSecrets = new Map<
    string,
    {
      envelope: Parameters<
        Parameters<typeof registerRuntimeEphemeralSecretDispatcher>[2]
      >[0]["envelope"];
      resolve: Parameters<
        Parameters<typeof registerRuntimeEphemeralSecretDispatcher>[2]
      >[0]["resolve"];
      reject: Parameters<
        Parameters<typeof registerRuntimeEphemeralSecretDispatcher>[2]
      >[0]["reject"];
    }
  >();

  ws.on("message", (data) => {
    const parsed = parseRuntimeWebSocketMessage(data);
    if (!parsed.ok) {
      sendRuntimeProtocolDiagnostic(ws, parsed.diagnostic);
      if (shouldCloseForRuntimeProtocolDiagnostic(parsed.diagnostic)) {
        ws.close(1002, parsed.diagnostic.code);
      }
      return;
    }

    const hello = runtimeHelloEnvelopeSchema.safeParse(parsed.value);
    if (hello.success) {
      if (hello.data.payload.runtimeId !== context.runtimeId) {
        sendError(
          ws,
          "runtime_id_mismatch",
          `Runtime hello route mismatch at Hub runtime WebSocket: payload.runtimeId ${JSON.stringify(hello.data.payload.runtimeId)} does not match URL runtimeId ${JSON.stringify(context.runtimeId)}. Action: reconnect using the runtime URL and token returned for this runtime registration.`,
        );
        ws.close(1008, "runtime_id_mismatch");
        return;
      }

      runtimeSessionId = handleHello(context, hello.data.payload);
      const workspaceBindingAssignments = listWorkspaceBindingAssignments(
        context.db,
        context.runtimeId,
        hello.data.payload.workspaceBindings.map(({ bindingId }) => bindingId),
      );
      ws.send(
        JSON.stringify({
          protocolVersion: hello.data.protocolVersion,
          messageId: createId("msg"),
          type: "server.hello_ack",
          sentAt: new Date().toISOString(),
          payload: {
            runtimeSessionId,
            acceptedFeatures: hello.data.payload.supportedFeatures,
            heartbeatIntervalMs: context.heartbeatIntervalMs ?? 15_000,
            serverTime: new Date().toISOString(),
            workspaceBindingAssignments,
          },
        }),
      );
      if (hello.data.payload.supportedFeatures.includes("reconcile-v1")) {
        sendReconcileRequest(ws, hello.data.protocolVersion, context.runtimeId, "startup");
      }
      unregisterControlDispatcher?.();
      unregisterControlDispatcher = registerRuntimeControlDispatcher(
        context.db,
        context.runtimeId,
        () => flushPendingRuntimeDeliveries(ws, context),
      );
      unregisterEphemeralSecretDispatcher?.();
      unregisterEphemeralSecretDispatcher = undefined;
      if (
        context.secureTransport === true &&
        hello.data.payload.supportedFeatures.includes("ephemeral-secret-v1")
      ) {
        unregisterEphemeralSecretDispatcher = registerRuntimeEphemeralSecretDispatcher(
          context.db,
          context.runtimeId,
          (dispatch) => {
            const { envelope } = dispatch;
            if (pendingEphemeralSecrets.has(envelope.ephemeralRequestId)) {
              dispatch.reject(
                new RuntimeControlCommandError(
                  `Secret request ${JSON.stringify(envelope.ephemeralRequestId)} is already active on this runtime connection. Wait for the existing request to finish before retrying.`,
                  "SECRET_REPLAY_REJECTED",
                ),
              );
              return () => {};
            }
            pendingEphemeralSecrets.set(envelope.ephemeralRequestId, {
              envelope,
              resolve: (result) => dispatch.resolve(result),
              reject: (error) => dispatch.reject(error),
            });
            try {
              ws.send(JSON.stringify(envelope));
            } catch {
              pendingEphemeralSecrets.delete(envelope.ephemeralRequestId);
              dispatch.reject(
                new RuntimeControlCommandError(
                  `Secure runtime connection closed before secret request ${JSON.stringify(envelope.ephemeralRequestId)} was sent. Reconnect the runtime and retry the original operation.`,
                  "SECRET_RUNTIME_DISCONNECTED",
                ),
              );
            }
            return () => {
              pendingEphemeralSecrets.delete(envelope.ephemeralRequestId);
            };
          },
        );
      }
      flushPendingRuntimeDeliveries(ws, context);
      return;
    }

    const heartbeat = runtimeHeartbeatEnvelopeSchema.safeParse(parsed.value);
    if (heartbeat.success) {
      if (heartbeat.data.payload.runtimeId !== context.runtimeId) {
        sendError(
          ws,
          "runtime_id_mismatch",
          `Runtime heartbeat route mismatch at Hub runtime WebSocket: payload.runtimeId ${JSON.stringify(heartbeat.data.payload.runtimeId)} does not match URL runtimeId ${JSON.stringify(context.runtimeId)}. Action: stop this uplink and reconnect with the registration for the expected runtime.`,
        );
        ws.close(1008, "runtime_id_mismatch");
        return;
      }

      runtimeSessionId = handleHeartbeat(
        context,
        runtimeSessionId,
        heartbeat.data.payload.runtimeSessionId,
      );
      if (heartbeat.data.payload.workspaceBindings) {
        upsertWorkspaceBindings(
          context.db,
          context.runtimeId,
          heartbeat.data.payload.workspaceBindings,
          new Date().toISOString(),
        );
      }
      ws.send(
        JSON.stringify({
          protocolVersion: heartbeat.data.protocolVersion,
          messageId: createId("msg"),
          type: "server.heartbeat_ack",
          sentAt: new Date().toISOString(),
          payload: {
            runtimeSessionId,
            sequence: heartbeat.data.payload.sequence,
            serverTime: new Date().toISOString(),
            workspaceBindingAssignments: listWorkspaceBindingAssignments(
              context.db,
              context.runtimeId,
              heartbeat.data.payload.workspaceBindings?.map(({ bindingId }) => bindingId) ?? [],
            ),
          },
        }),
      );
      flushPendingRuntimeDeliveries(ws, context);
      return;
    }

    const ephemeralSecretResult = runtimeEphemeralSecretResultEnvelopeSchema.safeParse(
      parsed.value,
    );
    if (ephemeralSecretResult.success) {
      const result = ephemeralSecretResult.data;
      const pending = pendingEphemeralSecrets.get(result.ephemeralRequestId);
      if (!pending) {
        sendError(
          ws,
          "unknown_ephemeral_secret_request",
          `Secret result ${JSON.stringify(result.ephemeralRequestId)} has no active in-memory request on this Hub connection. The request may have expired, completed, or belonged to a previous connection; retry the original operation instead of replaying the result.`,
        );
        return;
      }
      if (
        result.runtimeId !== context.runtimeId ||
        result.payload.operation !== pending.envelope.payload.operation ||
        result.workspaceId !== pending.envelope.workspaceId ||
        result.workspaceBindingId !== pending.envelope.workspaceBindingId
      ) {
        pendingEphemeralSecrets.delete(result.ephemeralRequestId);
        pending.reject(
          new RuntimeControlCommandError(
            `Secret result route mismatch for ${JSON.stringify(result.ephemeralRequestId)}: expected runtimeId=${JSON.stringify(context.runtimeId)}, operation=${JSON.stringify(pending.envelope.payload.operation)}, workspaceId=${JSON.stringify(pending.envelope.workspaceId ?? null)}, workspaceBindingId=${JSON.stringify(pending.envelope.workspaceBindingId ?? null)}; received runtimeId=${JSON.stringify(result.runtimeId)}, operation=${JSON.stringify(result.payload.operation)}, workspaceId=${JSON.stringify(result.workspaceId ?? null)}, workspaceBindingId=${JSON.stringify(result.workspaceBindingId ?? null)}. Retry the original operation on the correct runtime connection.`,
            "SECRET_ROUTE_MISMATCH",
          ),
        );
        return;
      }
      pendingEphemeralSecrets.delete(result.ephemeralRequestId);
      try {
        recordRuntimeEphemeralSecretProjection(context.db, {
          runtimeId: context.runtimeId,
          runtimeWorkspaceBindingId: result.workspaceBindingId,
          result: result.payload,
        });
        pending.resolve(result.payload);
      } catch (error) {
        pending.reject(error);
      }
      return;
    }

    if (handleMvpRuntimeMessage(ws, context, parsed.value)) {
      return;
    }

    const messageType =
      parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
        ? (parsed.value as Record<string, unknown>).type
        : undefined;
    sendError(
      ws,
      "runtime_dispatch_gap",
      `Validated Spark runtime message ${JSON.stringify(messageType ?? "<missing>")} was not handled by the Hub dispatch table. This is a Hub implementation error, not a sender schema error. Action: capture the message type and Hub build version, then report the missing handler.`,
    );
    ws.close(1011, "runtime_dispatch_gap");
  });

  ws.on("close", (_code, reason) => {
    unregisterControlDispatcher?.();
    unregisterControlDispatcher = undefined;
    unregisterEphemeralSecretDispatcher?.();
    unregisterEphemeralSecretDispatcher = undefined;
    for (const pending of pendingEphemeralSecrets.values()) {
      pending.reject(
        new RuntimeControlCommandError(
          `Secure runtime connection closed while secret request ${JSON.stringify(pending.envelope.ephemeralRequestId)} was active; it will not be retried automatically. Reconnect the runtime and retry the original operation.`,
          "SECRET_RUNTIME_DISCONNECTED",
        ),
      );
    }
    pendingEphemeralSecrets.clear();
    if (runtimeSessionId) {
      markSessionClosed(context.db, runtimeSessionId, reason.toString("utf8") || null);
    }
  });
}

export function authenticateRuntimeToken(
  db: DatabaseSync,
  runtimeId: string,
  authorization: string | undefined,
): string | null {
  const token = bearerTokenFromAuthorization(authorization);
  if (!token) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT id,
              scopes_json AS scopesJson,
              expires_at AS expiresAt
       FROM runtime_tokens
       WHERE runtime_id = ? AND token_hash = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .get(runtimeId, hashSecret(token)) as
    | { id: string; scopesJson: string; expiresAt: string | null }
    | undefined;

  if (!row || !runtimeTokenScopes(row.scopesJson).includes("runtime:connect")) {
    return null;
  }

  if (row.expiresAt && row.expiresAt <= new Date().toISOString()) {
    return null;
  }

  return row.id;
}
