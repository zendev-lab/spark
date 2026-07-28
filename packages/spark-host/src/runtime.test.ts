import { describe, expect, it } from "vitest";
import { SparkHostRuntime } from "./runtime.ts";

function registerTool(
  host: SparkHostRuntime,
  name: string,
  effect?: "read" | "local_write" | "external_write" | "destructive",
  execute?: () => void,
): void {
  host.registerTool({
    name,
    description: name,
    parameters: {},
    ...(effect ? { policy: { effect } } : {}),
    async execute() {
      execute?.();
      return { content: [{ type: "text" as const, text: name }] };
    },
  });
}

describe("SparkHostRuntime effect contract", () => {
  it("HOST-EFFECT-001 admits read and denies write, destructive, and unknown effects", () => {
    const host = new SparkHostRuntime({
      cwd: "/tmp/spark-host-runtime-read-only-test",
      allowedTools: ["read", "local", "external", "destructive", "unknown"],
      allowedToolEffects: ["read"],
    });
    const executions: string[] = [];
    registerTool(host, "read", "read", () => executions.push("read"));
    registerTool(host, "local", "local_write", () => executions.push("local"));
    registerTool(host, "external", "external_write", () => executions.push("external"));
    registerTool(host, "destructive", "destructive", () => executions.push("destructive"));
    registerTool(host, "unknown", undefined, () => executions.push("unknown"));

    expect(host.getActiveTools()).toEqual(["read"]);
    expect(host.isToolDispatchAllowed("read", host.getTool("read")!)).toBe(true);
    expect(executions).toEqual([]);

    // A stale or mutated active bit cannot bypass final dispatch admission.
    for (const name of ["local", "external", "destructive", "unknown"]) {
      const tool = host.getTool(name)!;
      tool.active = true;
      expect(host.isToolDispatchAllowed(name, tool), name).toBe(false);
    }
  });

  it("HOST-EFFECT-002 suppresses unclassified and write lifecycle listeners", async () => {
    const host = new SparkHostRuntime({
      cwd: "/tmp/spark-host-runtime-lifecycle-policy-test",
      allowedToolEffects: ["read"],
    });
    const invoked: string[] = [];
    host.on("session_before_compact", () => invoked.push("unknown"));
    host.on("session_before_compact", () => invoked.push("local"), {
      effects: ["local_write"],
    });
    host.on("session_before_compact", () => invoked.push("external"), {
      effects: ["external_write"],
    });
    host.on("session_before_compact", () => invoked.push("destructive"), {
      effects: ["destructive"],
    });
    host.on(
      "session_before_compact",
      () => {
        invoked.push("read");
        return "read-checkpoint";
      },
      { effects: ["read"] },
    );

    await expect(host.emit("session_before_compact", {})).resolves.toEqual(["read-checkpoint"]);
    expect(invoked).toEqual(["read"]);
  });

  it("HOST-EFFECT-003 preserves unrestricted ordinary-session behavior", async () => {
    const host = new SparkHostRuntime({
      cwd: "/tmp/spark-host-runtime-unrestricted-test",
    });
    const invoked: string[] = [];
    host.on("session_start", () => invoked.push("unknown"));
    host.on("session_start", () => invoked.push("write"), {
      effects: ["local_write"],
    });

    await host.emit("session_start", {});
    expect(invoked).toEqual(["unknown", "write"]);
  });
});
