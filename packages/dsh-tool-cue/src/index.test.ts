import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { validateJsonSchemaValue, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { CUE_TOOL_NAMES } from "@zendev-lab/dsh-cue/operations";
import * as plugin from "./index.ts";
import { apply, presentCueCall, presentCueResult } from "./index.ts";

function harness(
  mode: "read-only" | "workspace-write" | "danger-full-access" = "danger-full-access",
) {
  const tools: ToolDefinition[] = [];
  const guards: Array<(exec: Record<string, unknown>) => string | undefined> = [];
  const pre: Array<(exec: Record<string, unknown>, next: () => Promise<unknown>) => unknown> = [];
  const dispose: Array<() => void> = [];
  const context = {
    cue: {
      execute: vi.fn(async (toolName: string) => validOutput(toolName)),
      releaseSession: vi.fn(),
    },
    tools: {
      register(tool: ToolDefinition) {
        tools.push(tool);
        return () => undefined;
      },
      guard(guard: (exec: Record<string, unknown>) => string | undefined) {
        guards.push(guard);
        return () => undefined;
      },
    },
    systemPrompt: {
      section: vi.fn((_section: { name: string; text: string }) => () => undefined),
    },
    sandboxPolicy: { resolve: vi.fn(() => ({ mode, workspaceRoot: "/workspace" })) },
    sandbox: { confine: vi.fn() },
    approval: { request: vi.fn() },
    shellEnv: { collect: vi.fn(() => ({ DSH_SHELL: "1" })) },
    on(
      event: string,
      listener: (exec: Record<string, unknown>, next: () => Promise<unknown>) => unknown,
    ) {
      if (event === "tools/pre-execute") pre.push(listener);
      return () => undefined;
    },
    effect(factory: () => () => void) {
      const cleanup = factory();
      dispose.push(cleanup);
      return cleanup;
    },
  };
  apply(context as unknown as Context);
  return { context, tools, guards, pre, dispose };
}

const stream = { text: "", encoding: "utf8", truncated: false };

function validOutput(name: string): Record<string, unknown> {
  const base = { tool: name, text: "ok", ok: true };
  if (name === "cue_exec") {
    return {
      ...base,
      kind: "foreground",
      stepIds: [],
      timedOut: false,
      detached: false,
      cancelled: false,
      stdout: stream,
      stderr: stream,
      warnings: [],
    };
  }
  if (name === "cue_run" || name === "cue_script") {
    return {
      ...base,
      status: "finished",
      timedOut: false,
      cancelled: false,
      stepIds: [],
      stdout: stream,
      stderr: stream,
    };
  }
  if (name === "script_run" || name === "script_eval") {
    return {
      ...base,
      language: "python",
      kind: "python-execution",
      stepIds: [],
      status: "finished",
      timedOut: false,
      cancelled: false,
      stdout: stream,
      stderr: stream,
    };
  }
  if (name === "cue_history") {
    return { ...base, rawChars: 2, shownChars: 2, lines: 1, truncated: false };
  }
  return {
    ...base,
    action: name === "cue_resources" ? "providers" : "list",
    timedOut: false,
    records: [],
  };
}

describe("dsh-tool-cue plugin", () => {
  it("keeps the namespace contract intact for the supported loader", () => {
    expect("default" in plugin).toBe(false);
    expect(plugin).toMatchObject({
      name: "dsh-tool-cue",
      inject: ["cue", "tools", "systemPrompt", "sandboxPolicy", "sandbox", "approval", "shellEnv"],
      apply: expect.any(Function),
    });
  });

  it("registers exactly ten closed, validator-compatible canonical schemas", () => {
    const { tools, dispose } = harness();
    expect(tools.map((tool) => tool.name)).toEqual(CUE_TOOL_NAMES);
    for (const tool of tools) {
      const schema = tool.output!.schema as {
        type?: unknown;
        additionalProperties?: unknown;
        oneOf?: Array<{ additionalProperties?: unknown }>;
      };
      if (schema.oneOf === undefined) {
        expect(schema).toMatchObject({ type: "object", additionalProperties: false });
      } else {
        expect(schema.oneOf.every((branch) => branch.additionalProperties === false)).toBe(true);
      }
      expect(validateJsonSchemaValue(tool.output!.schema, validOutput(tool.name), "")).toEqual([]);
      expect(
        validateJsonSchemaValue(
          tool.output!.schema,
          { ...validOutput(tool.name), details: {} },
          "",
        ),
      ).not.toEqual([]);
    }
    const cueScript = tools.find((tool) => tool.name === "cue_script");
    expect(
      validateJsonSchemaValue(
        cueScript!.output!.schema,
        {
          ...validOutput("cue_script"),
          ok: false,
          status: "cancelled",
          cancelled: true,
          cancelReason: "forced",
        },
        "",
      ),
    ).toEqual([]);
    const cueExec = tools.find((tool) => tool.name === "cue_exec");
    expect(
      validateJsonSchemaValue(
        cueExec!.output!.schema,
        {
          ...validOutput("cue_exec"),
          ok: false,
          status: "cancelled",
          cancelled: true,
          cancelReason: "forced",
        },
        "",
      ),
    ).toEqual([]);
    for (const cleanup of dispose) cleanup();
  });

  it("executes through the injected dsh-cue service", async () => {
    const { context, tools, dispose } = harness();
    const cueExec = tools.find((tool) => tool.name === "cue_exec");
    const agent = { session: { id: "s1", header: { cwd: "/workspace" } } };

    const result = await cueExec?.execute({ command: "pwd" }, {
      agent,
      callId: "cue-1",
      rootCallId: "cue-1",
      name: "cue_exec",
      arguments: { command: "pwd" },
      signal: new AbortController().signal,
    } as never);

    expect(context.cue.execute).toHaveBeenCalledWith(
      "cue_exec",
      { command: "pwd" },
      expect.objectContaining({ sessionId: "dsh:s1", cwd: "/workspace" }),
    );
    expect(result).toMatchObject({ tool: "cue_exec", ok: true });
    for (const cleanup of dispose) cleanup();
  });

  it("fails closed without an Agent and rejects future schedules outside persistent DFA", async () => {
    const { context, tools, guards, dispose } = harness("workspace-write");
    expect(guards).toHaveLength(1);
    expect(guards[0]?.({ name: "cue_exec" })).toContain("requires a DSH Agent and Session");
    expect(guards[0]?.({ name: "read" })).toBeUndefined();

    const agent = { session: { id: "s1", header: { cwd: "/workspace" } } };
    const cueSchedule = tools.find((tool) => tool.name === "cue_schedule");
    await expect(
      cueSchedule?.execute({ action: "add", schedule: "daily", command: "true" }, {
        agent,
        callId: "schedule-1",
        rootCallId: "schedule-1",
        name: "cue_schedule",
        arguments: {},
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow("persistent danger-full-access");
    expect(context.sandboxPolicy.resolve).toHaveBeenCalledWith({ session: agent.session });

    const cueExec = tools.find((tool) => tool.name === "cue_exec");
    await expect(
      cueExec?.execute({ command: "pwd" }, {
        callId: "c1",
        rootCallId: "c1",
        name: "cue_exec",
        arguments: { command: "pwd" },
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow("requires a DSH Agent and Session");
    for (const cleanup of dispose) cleanup();
  });

  it("keeps call/result presenters pure and replayable", () => {
    expect(presentCueCall("cue_exec", { command: "pwd", cwd: "/tmp" })).toEqual({
      card: "terminal",
      title: "pwd",
      cwd: "/tmp",
    });
    expect(
      presentCueResult("cue_exec", {
        content: [{ type: "text", text: "done" }],
        isError: false,
      }),
    ).toEqual({ card: "terminal", output: "done" });
  });

  it("exposes the not-bash guidance to the model before any call", () => {
    const { context, tools, dispose } = harness();
    const cueExec = tools.find((tool) => tool.name === "cue_exec");
    expect(cueExec?.description).toContain("not bash");
    expect(cueExec?.description).toContain("direct-exec");
    expect(cueExec?.description).toContain("|'");
    const sections = (
      context.systemPrompt.section.mock.calls as Array<[{ name: string; text: string }]>
    ).map((call) => call[0]);
    const cueSection = sections.find((section) => section.name === "tool:cue");
    expect(cueSection?.text).toContain("rewrite it to Cue operators first");
    for (const cleanup of dispose) cleanup();
  });
});
