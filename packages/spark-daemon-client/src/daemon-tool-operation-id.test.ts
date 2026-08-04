import { describe, expect, it } from "vitest";
import { createSparkDaemonToolOperationId } from "./daemon-tool-client.ts";

const base = {
  method: "file.execute" as const,
  tool: "read",
  toolCallId: "call/raw:500-679",
  cwd: "/workspace/spark",
  workspaceId: "workspace-one",
  sessionSource: "tui",
  sessionSurface: "local",
  clientInstanceId: "client-one",
};

describe("daemon tool operation identity", () => {
  it("is deterministic for one client and execution context", () => {
    const first = createSparkDaemonToolOperationId(base);
    const second = createSparkDaemonToolOperationId({ ...base });

    expect(first).toBe(second);
    expect(first).toMatch(/^tool:file\.execute:read:[0-9a-f]{24}:[0-9a-f]{24}$/u);
  });

  it("separates reused tool-call ids across client and execution boundaries", () => {
    const ids = new Set([
      createSparkDaemonToolOperationId(base),
      createSparkDaemonToolOperationId({ ...base, cwd: "/workspace/other" }),
      createSparkDaemonToolOperationId({ ...base, workspaceId: "workspace-two" }),
      createSparkDaemonToolOperationId({ ...base, sessionSource: "channel" }),
      createSparkDaemonToolOperationId({ ...base, sessionSurface: "channel" }),
      createSparkDaemonToolOperationId({ ...base, clientInstanceId: "client-two" }),
      createSparkDaemonToolOperationId({ ...base, method: "artifact.execute", tool: "artifact" }),
      createSparkDaemonToolOperationId({ ...base, tool: "write" }),
      createSparkDaemonToolOperationId({ ...base, toolCallId: "another-call" }),
    ]);

    expect(ids.size).toBe(9);
  });

  it("does not expose raw local paths or host tool-call ids", () => {
    const operationId = createSparkDaemonToolOperationId(base);

    expect(operationId).not.toContain(base.cwd);
    expect(operationId).not.toContain(base.toolCallId);
    expect(operationId.length).toBeLessThan(140);
  });
});
