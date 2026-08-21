import { describe, expect, it } from "vitest";
import {
  sparkLocalRpcOrpcOnlyMethods,
  sparkLocalRpcProcedureSchemas,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { isSparkLocalRpcMethod, parseLocalRpcRequest } from "./parse.ts";

describe("side-thread local RPC parsing", () => {
  it("parses every side-thread method through the protocol catalog", () => {
    const cases = [
      ["side-thread.ensure", { parentSessionId: "parent" }],
      ["side-thread.snapshot", { parentSessionId: "parent" }],
      [
        "side-thread.submit",
        {
          parentSessionId: "parent",
          expectedGeneration: 1,
          prompt: "inspect",
          idempotencyKey: "key",
        },
      ],
      ["side-thread.reset", { parentSessionId: "parent", expectedGeneration: 1, mode: "tangent" }],
      [
        "side-thread.configure",
        { parentSessionId: "parent", expectedGeneration: 1, thinkingOverride: "low" },
      ],
      [
        "side-thread.handoff",
        {
          parentSessionId: "parent",
          expectedGeneration: 1,
          expectedHeadExchangeId: "exchange",
          kind: "full",
          idempotencyKey: "key",
        },
      ],
    ] as const;

    for (const [method, params] of cases) {
      const request = parseLocalRpcRequest(JSON.stringify({ id: method, method, params }));
      expect(request).toEqual({
        id: method,
        method,
        params: sparkLocalRpcProcedureSchemas[method].input.parse(params),
      });
    }
  });

  it("recognizes every protocol-owned method and rejects unknown methods", () => {
    const methods = Object.keys(sparkLocalRpcProcedureSchemas);
    expect(methods.every(isSparkLocalRpcMethod)).toBe(true);
    expect(sparkLocalRpcOrpcOnlyMethods).toEqual([
      "daemon.logs",
      "artifact.list",
      "artifact.read",
      "role.list",
      "role.get",
      "role.create",
      "role.model.list",
      "role.model.get",
      "role.model.set",
      "role.model.delete",
      "skill.list",
      "skill.get",
      "workspace.directory.list",
      "search.global",
      "session.search",
      "session.export",
      "session.snapshot-page",
      "session.media.read",
      "session.prompt-history",
      "session.retry-target",
      "session.mode.set",
    ]);
    for (const method of sparkLocalRpcOrpcOnlyMethods) {
      expect(() =>
        parseLocalRpcRequest(
          JSON.stringify({
            id: "orpc-only",
            method,
            params: { sessionId: "session-1" },
          }),
        ),
      ).toThrow(`Unknown local RPC method: ${method}`);
    }
    expect(() =>
      parseLocalRpcRequest(JSON.stringify({ id: "unknown", method: "legacy.unknown", params: {} })),
    ).toThrow("Unknown local RPC method: legacy.unknown");
  });
});
