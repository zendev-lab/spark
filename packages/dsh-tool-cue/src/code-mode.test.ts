import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import FileSystem from "@deepseek-ai/dsh-fs-local";
import Subprocess from "@deepseek-ai/dsh-subprocess-local";
import Sandbox from "@deepseek-ai/dsh-sandbox-local";
import SandboxPolicy from "@deepseek-ai/dsh-sandbox-policy";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { NodePtcRuntime } from "@deepseek-ai/dsh-ptc-runtime-node";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { apply as ShellEnv } from "@deepseek-ai/dsh-shell-env";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";
import type { CueToolRuntime } from "@zendev-lab/dsh-cue/operations";
import { describe, expect, it, vi } from "vitest";
import { registerCueToolDefinitions } from "./index.ts";

const signal = new AbortController().signal;

function agent(): Agent {
  return {
    session: Session.create(SessionId("code-session"), undefined, {
      version: 4,
      id: SessionId("code-session"),
      createdAt: 0,
      isSeeded: false,
      cwd: process.cwd(),
    }),
  } as unknown as Agent;
}

describe("DSH PTC contract", () => {
  it("runs a real generated-SDK program over canonical discriminants and blocks direct calls", async () => {
    const ctx = new Context();
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: "ptc" });
    await ctx.plugin(SessionStore);
    await ctx.plugin(FileSystem);
    await ctx.plugin(Subprocess);
    await ctx.plugin(Sandbox, {});
    await ctx.plugin(SessionProjections);
    await ctx.plugin(SandboxPolicy, { mode: "danger-full-access", workspaceRoot: process.cwd() });
    await ctx.plugin(NodePtcRuntime, {});
    await ctx.plugin(ShellEnv, { dshHome: "/tmp/dsh-code-test" });

    const execute = vi.fn(async () => ({
      tool: "cue_exec" as const,
      text: "Execution E1: succeeded\nhello",
      ok: true,
      kind: "foreground" as const,
      executionId: "E1",
      stepIds: ["E1/S1"],
      status: "succeeded",
      exitCode: 0,
      timedOut: false,
      detached: false,
      cancelled: false,
      stdout: { text: "hello\n", encoding: "utf8", truncated: false },
      stderr: { text: "", encoding: "utf8", truncated: false },
      warnings: [],
    }));
    registerCueToolDefinitions(ctx, { execute } as unknown as Pick<CueToolRuntime, "execute">);
    const callingAgent = agent();

    const direct = await ctx.tools.execute({
      signal,
      callId: ToolCallId("direct-1"),
      name: "cue_exec",
      arguments: { command: "echo hello" },
      agent: callingAgent,
    });
    expect(direct.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId("code-1"),
      name: RUN_CODE_NAME,
      arguments: {
        description: "Read canonical Cue execution fields",
        code: `
          const result = await tools.cue_exec({ command: "echo hello" });
          return {
            kind: result.kind,
            timedOut: result.timedOut,
            exitCode: result.exitCode,
            stdout: result.stdout.text,
          };
        `,
      },
      agent: callingAgent,
    });
    if (result.isError) {
      throw new Error(`expected PTC success: ${JSON.stringify(result.content)}`);
    }
    expect(result.value).toMatchObject({
      result: { kind: "foreground", timedOut: false, exitCode: 0, stdout: "hello\n" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await ctx.fiber.dispose();
  });
});
