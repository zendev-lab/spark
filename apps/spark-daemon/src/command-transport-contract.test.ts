import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createId, createServerCommandEnvelope } from "@zendev-lab/spark-protocol";
import {
  decideSparkDaemonCommandPolicy,
  sparkCommandFromLocalRpcRequest,
  sparkCommandFromServerCommandEnvelope,
} from "./command-dispatcher.ts";

const route = {
  runtimeId: "rt_01234567890123456789012345678901",
  workspaceBindingId: "rtwb_01234567890123456789012345678901",
  workspaceId: "ws_01234567890123456789012345678901",
  projectId: "proj_01234567890123456789012345678901",
  commandId: "cmd_01234567890123456789012345678901",
};
const knownWorkspaceBindingIds = new Set([route.workspaceBindingId]);

describe("turn command transport contract", () => {
  it("normalizes local socket submit/cancel/status to SparkCommand", () => {
    expect(
      sparkCommandFromLocalRpcRequest({ id: "local_restart", method: "daemon.restart" }).kind,
    ).toBe("daemon.restart.request");
    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_side_thread",
        method: "side-thread.ensure",
        params: { parentSessionId: "session-a" },
      }),
    ).toMatchObject({ kind: "side-thread.ensure.request", route: { sessionId: "session-a" } });

    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_submit",
        method: "turn.submit",
        params: { sessionId: "session-a", prompt: "continue" },
      }),
    ).toMatchObject({ kind: "turn.submit.request", route: { sessionId: "session-a" } });

    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_cancel",
        method: "turn.cancel",
        params: { invocationId: "inv_01234567890123456789012345678901", reason: "stop" },
      }),
    ).toMatchObject({
      kind: "turn.cancel.request",
      route: { invocationId: "inv_01234567890123456789012345678901" },
    });

    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_status",
        method: "turn.status",
        params: { invocationId: "inv_01234567890123456789012345678901" },
      }).kind,
    ).toBe("turn.status.request");
    expect(() =>
      sparkCommandFromLocalRpcRequest({ id: "removed_queue", method: "daemon.queue" }),
    ).toThrow(/Unknown local RPC command method/u);
  });

  it("normalizes runtime WebSocket submit/cancel/status to SparkCommand", () => {
    const submit = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        payload: { kind: "task.start.request", payload: { prompt: "run" } },
      }),
    );
    expect(submit).toMatchObject({ kind: "task.start.request", route });

    const cancel = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_11111111111111111111111111111111",
        payload: {
          kind: "invocation.cancel.request",
          payload: { runtimeInvocationId: "inv_01234567890123456789012345678901" },
        },
      }),
    );
    expect(cancel).toMatchObject({
      kind: "invocation.cancel.request",
      payload: { runtimeInvocationId: "inv_01234567890123456789012345678901" },
    });

    const status = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_22222222222222222222222222222222",
        payload: { kind: "workspace.snapshot.request" },
      }),
    );
    expect(status.kind).toBe("workspace.snapshot.request");
  });

  it("normalizes session create/bind/archive/restore and turn submit/cancel across both transports", () => {
    const sessionId = "sess_transport_contract";
    for (const [method, kind, params] of [
      [
        "session.create",
        "session.create.request",
        { sessionId, scope: { kind: "daemon" }, title: "Transport contract" },
      ],
      [
        "session.bind",
        "session.bind.request",
        { sessionId, externalKey: "infoflow:user:transport" },
      ],
      ["session.archive", "session.archive.request", { sessionId }],
      ["session.restore", "session.restore.request", { sessionId }],
      ["turn.submit", "turn.submit.request", { sessionId, prompt: "continue" }],
    ] as const) {
      const local = sparkCommandFromLocalRpcRequest({
        id: `local_${kind}`,
        method,
        params,
      });
      const runtime = sparkCommandFromServerCommandEnvelope(
        createServerCommandEnvelope({
          runtimeId: route.runtimeId,
          sessionId,
          commandId: createId("cmd"),
          payload: { kind, scope: "daemon", payload: params },
        }),
      );
      expect(local).toMatchObject({ kind, route: { sessionId }, payload: params });
      expect(runtime).toMatchObject({ kind, route: { sessionId }, payload: params });
      expect(
        decideSparkDaemonCommandPolicy({
          command: runtime,
          runtimeId: route.runtimeId,
          expectedRuntimeId: route.runtimeId,
          allowMutation: true,
        }),
      ).toEqual({ accepted: true });
    }

    const cancelParams = {
      invocationId: "inv_01234567890123456789012345678901",
      reason: "stop",
    };
    const localCancel = sparkCommandFromLocalRpcRequest({
      id: "local_session_cancel",
      method: "turn.cancel",
      params: cancelParams,
    });
    const runtimeCancel = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        runtimeId: route.runtimeId,
        sessionId,
        commandId: createId("cmd"),
        payload: {
          kind: "turn.cancel.request",
          scope: "daemon",
          payload: cancelParams,
        },
      }),
    );
    expect(localCancel).toMatchObject({ kind: "turn.cancel.request", payload: cancelParams });
    expect(runtimeCancel).toMatchObject({
      kind: "turn.cancel.request",
      route: { sessionId },
      payload: cancelParams,
    });
  });

  it("uses one daemon policy path for transport-independent errors", () => {
    const submit = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        payload: { kind: "task.start.request", payload: { prompt: "run" } },
      }),
    );
    const cancel = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_33333333333333333333333333333333",
        payload: {
          kind: "invocation.cancel.request",
          payload: { runtimeInvocationId: "inv_01234567890123456789012345678901" },
        },
      }),
    );

    expect(
      decideSparkDaemonCommandPolicy({
        command: submit,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true },
      }),
    ).toMatchObject({ accepted: false, reasonCode: "WORKSPACE_BORROWED", retryable: true });
    expect(
      decideSparkDaemonCommandPolicy({
        command: cancel,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true, detached: true },
      }).accepted,
    ).toBe(true);
    expect(
      decideSparkDaemonCommandPolicy({
        command: submit,
        workspaceBindingId: "rtwb_missing",
        knownWorkspaceBindingIds,
      }),
    ).toMatchObject({ accepted: false, reasonCode: "UNKNOWN_WORKSPACE_BINDING" });
  });

  it("keeps runtime WebSocket control schema-only without RPC or HTTP tunneling", () => {
    const sources = ["daemon.ts", "command-dispatcher.ts"].map((file) =>
      ts.createSourceFile(
        file,
        readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ),
    );
    const calls = new Set<string>();
    const calledIdentifiers = new Set<string>();
    const importedBindings = new Set<string>();
    const imports = new Set<string>();
    const reasonCodes = new Set<string>();
    const commandPayloadProperties = new Set<string>();
    for (const source of sources) {
      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.add(node.moduleSpecifier.text);
          const clause = node.importClause;
          if (clause?.name) importedBindings.add(clause.name.text);
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) importedBindings.add(element.name.text);
          }
          if (bindings && ts.isNamespaceImport(bindings)) importedBindings.add(bindings.name.text);
        }
        if (ts.isCallExpression(node)) {
          calls.add(node.expression.getText(source));
          if (ts.isIdentifier(node.expression)) calledIdentifiers.add(node.expression.text);
          if (ts.isPropertyAccessExpression(node.expression)) {
            calledIdentifiers.add(node.expression.name.text);
          }
        }
        if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
          const name = node.name.getText(source);
          if (name === "reasonCode") reasonCodes.add(node.initializer.text);
        }
        if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const chain = `${node.expression.getText(source)}.${node.name.text}`;
          if (chain.startsWith("command.payload.")) commandPayloadProperties.add(node.name.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }

    expect(calls).toContain("serverCommandEnvelopeSchema.safeParse");
    expect(reasonCodes).toContain("WORKSPACE_ROUTE_MISMATCH");
    expect(imports).not.toContain("node:http");
    expect(commandPayloadProperties).not.toContain("scope");
    expect(commandPayloadProperties).not.toContain("method");
    expect(commandPayloadProperties).not.toContain("params");
    expect(imports).not.toContain("./local-rpc/client-transport.ts");
    expect(importedBindings).not.toContain("requestSparkDaemonLocalRpcWire");
    expect(calledIdentifiers).not.toContain("requestSparkDaemonLocalRpcWire");
  });

  it("keeps the turn spec aligned with canonical fixture vocabulary", () => {
    const spec = readFileSync(
      fileURLToPath(new URL("../../../docs/specs/turn.md", import.meta.url)),
      "utf8",
    );
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../packages/spark-protocol/src/fixtures/command-events-v1/vocabulary-samples.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as { commands: Array<{ kind: string }>; events: Array<{ kind: string }> };

    for (const command of fixture.commands) expect(spec).toContain(command.kind);
    for (const event of fixture.events) expect(spec).toContain(event.kind);
    expect(spec).toContain("SparkCommand");
    expect(spec).toContain("SparkEvent");
  });
});
