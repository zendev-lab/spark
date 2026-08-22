import { Context } from "@deepseek-ai/cordis";
import { FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import { createScope } from "@deepseek-ai/dsh-scope";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, {
  defineTool,
  renderToolsSdk,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";

import { apply, createDshFileToolDefinitions, inject, name } from "./dsh-plugin.ts";

function execution(): ToolRunContext {
  return {
    callId: "call-1",
    rootCallId: "call-1",
    name: "read",
    arguments: {},
    signal: new AbortController().signal,
    agent: {
      session: {
        id: "session-1",
        header: { id: "session-1", cwd: "/workspace" },
      },
    },
  } as unknown as ToolRunContext;
}

function harness(content = "alpha\nbeta\n") {
  const tools: ToolDefinition[] = [];
  const target = {
    targetKey: FsTargetKey("/workspace/file.txt"),
    displayPath: "/workspace/file.txt",
  };
  const version = FsVersion("1:2:11:100:100");
  const nextVersion = FsVersion("1:2:12:101:101");
  const encodedVersion = `dshfs:v1:${Buffer.from(version, "utf8").toString("base64url")}`;
  const encodedNextVersion = `dshfs:v1:${Buffer.from(nextVersion, "utf8").toString("base64url")}`;
  const fs = {
    resolve: vi.fn(async () => target),
    stat: vi.fn(async () => ({ version, type: "file" as const, size: content.length })),
    readText: vi.fn(async () => content),
    writeText: vi.fn(async (_target, next: string) => ({
      operation: "update" as const,
      version: nextVersion,
      before: content,
      after: next,
    })),
  };
  const context = {
    fs,
    tools: {
      register(tool: ToolDefinition) {
        tools.push(tool);
        return () => undefined;
      },
    },
    systemPrompt: { section: vi.fn(() => () => undefined) },
    sandboxPolicy: {
      resolve: vi.fn(() => ({ mode: "danger-full-access", workspaceRoot: "/workspace" })),
    },
    emit: vi.fn(),
  };
  return {
    context: context as unknown as Context,
    rawContext: context,
    tools,
    version,
    nextVersion,
    encodedVersion,
    encodedNextVersion,
  };
}

function named(tools: ToolDefinition[], toolName: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`missing ${toolName}`);
  return tool;
}

describe("Spark DSH file tools", () => {
  it("shadows upstream text tools in preset scope while retaining global read_image", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      const emptyOutput = {
        schema: { type: "object", additionalProperties: false, properties: {} } as const,
        render: () => [],
      };
      const upstreamRead = defineTool({
        name: "read",
        description: "upstream read",
        parameters: {},
        output: emptyOutput,
        async execute() {
          return {};
        },
      });
      const upstreamImage = defineTool({
        name: "read_image",
        description: "upstream image",
        parameters: {},
        output: emptyOutput,
        async execute() {
          return {};
        },
      });
      ctx.tools.register(upstreamRead);
      ctx.tools.register(upstreamImage);

      const key = {};
      let scope: ReturnType<typeof createScope> | undefined;
      await ctx.plugin({
        name: "spark-files-scope-test",
        inject: ["tools"],
        apply(pluginCtx: Context) {
          scope = createScope(pluginCtx, key);
          for (const tool of createDshFileToolDefinitions(scope.ctx)) {
            scope.ctx.tools.register(tool);
          }
        },
      });
      expect(ctx.tools.get("read")).toBe(upstreamRead);
      expect(ctx.tools.get("read", key)?.description).toContain("versioned UTF-8 snapshot");
      expect(ctx.tools.get("read_image", key)).toBe(upstreamImage);
      await scope?.dispose();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("exports a scoped DSH plugin without approval or escalation ownership", () => {
    expect(name).toBe("spark-files-dsh");
    expect(inject).toEqual(["tools", "fs", "systemPrompt", "sandboxPolicy"]);
    const { context, rawContext, tools } = harness();
    apply(context);
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write", "edit"]);
    expect(rawContext.systemPrompt.section).toHaveBeenCalledTimes(3);
  });

  it("projects one escalation-free schema into Native and Code Mode", () => {
    const { context } = harness();
    const tools = createDshFileToolDefinitions(context);
    const write = named(tools, "write");
    const edit = named(tools, "edit");
    const writeProperties = (write.parameters as { properties: Record<string, unknown> })
      .properties;
    const editProperties = (edit.parameters as { properties: Record<string, unknown> }).properties;
    expect(writeProperties).toHaveProperty("expectedVersion");
    expect(editProperties).toHaveProperty("expectedVersion");
    expect(writeProperties).not.toHaveProperty("sandbox_permissions");
    expect(writeProperties).not.toHaveProperty("justification");
    expect(editProperties).not.toHaveProperty("sandbox_permissions");
    expect(editProperties).not.toHaveProperty("justification");

    const sdk = renderToolsSdk(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: tool.output!.schema,
      })),
    );
    expect(sdk).toContain("expectedVersion");
    expect(sdk).not.toContain("sandbox_permissions");
    expect(sdk).not.toContain("justification");
  });

  it("returns a provider version with Spark line anchors and records the observation", async () => {
    const { context, rawContext, version, encodedVersion } = harness();
    const read = named(createDshFileToolDefinitions(context), "read");
    const value = await read.execute({ path: "file.txt" }, execution());
    expect(value).toMatchObject({
      path: "/workspace/file.txt",
      version: encodedVersion,
      offset: 1,
      totalLines: 3,
      lines: [
        { number: 1, anchor: expect.stringMatching(/^1#[a-f0-9]{12}:alpha$/u) },
        { number: 2, anchor: expect.stringMatching(/^2#[a-f0-9]{12}:beta$/u) },
        { number: 3, anchor: expect.stringMatching(/^3#[a-f0-9]{12}:$/u) },
      ],
    });
    expect(rawContext.fs.resolve).toHaveBeenCalledWith("file.txt", {
      cwd: "/workspace",
      signal: expect.any(AbortSignal),
    });
    expect(rawContext.emit).toHaveBeenCalledWith(
      "fs/observed",
      expect.any(Object),
      { kind: "present", version },
      expect.any(Object),
    );
  });

  it("passes explicit CAS intent and standing sandbox policy to the DSH provider", async () => {
    const { context, rawContext, version, encodedVersion, encodedNextVersion } = harness();
    const write = named(createDshFileToolDefinitions(context), "write");
    const exec = execution();
    const value = await write.execute(
      {
        path: "file.txt",
        content: "replacement\n",
        expectedVersion: encodedVersion,
        // Old rc.8 callers may still send these open-root extras. They are
        // intentionally ignored instead of entering an approval path.
        sandbox_permissions: "danger-full-access",
        justification: "same mode",
      },
      exec,
    );
    expect(value).toMatchObject({
      version: encodedNextVersion,
      previousVersion: encodedVersion,
    });
    expect(rawContext.sandboxPolicy.resolve).toHaveBeenCalledWith({ session: exec.agent!.session });
    expect(rawContext.fs.writeText).toHaveBeenCalledWith(
      expect.any(Object),
      "replacement\n",
      { kind: "replaceIfVersion", version },
      exec.signal,
      { mode: "danger-full-access", workspaceRoot: "/workspace" },
    );
    await expect(
      write.execute(
        {
          path: "file.txt",
          content: "must not run\n",
          expectedVersion: encodedVersion,
          sandbox_permissions: "workspace-write",
          justification: "downgrade",
        },
        exec,
      ),
    ).rejects.toThrow("change the session sandbox policy");
    expect(rawContext.fs.writeText).toHaveBeenCalledTimes(1);
  });

  it("maps create-only writes and preserves provider sandbox denials", async () => {
    const { context, rawContext } = harness();
    const write = named(createDshFileToolDefinitions(context), "write");
    rawContext.fs.writeText.mockRejectedValueOnce(
      new FsError("outside workspace", "FS_SANDBOX_DENIED"),
    );
    await expect(
      write.execute({ path: "new.txt", content: "new\n", expectedVersion: "missing" }, execution()),
    ).rejects.toMatchObject({
      code: "FS_SANDBOX_DENIED",
      message: expect.stringContaining("current session sandbox"),
    });
    expect(rawContext.fs.writeText).toHaveBeenCalledWith(
      expect.any(Object),
      "new\n",
      { kind: "createIfAbsent" },
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });

  it("applies multi-edit against the observed version and commits through provider CAS", async () => {
    const { context, rawContext, version, encodedVersion, encodedNextVersion } =
      harness("alpha\nbeta\n");
    const edit = named(createDshFileToolDefinitions(context), "edit");
    const value = await edit.execute(
      {
        path: "file.txt",
        expectedVersion: encodedVersion,
        edits: [
          { oldText: "alpha", newText: "first" },
          { oldText: "beta", newText: "second" },
        ],
      },
      execution(),
    );
    expect(value).toMatchObject({
      version: encodedNextVersion,
      previousVersion: encodedVersion,
      before: "alpha\nbeta\n",
      after: "first\nsecond\n",
    });
    expect(rawContext.fs.writeText).toHaveBeenCalledWith(
      expect.any(Object),
      "first\nsecond\n",
      { kind: "replaceIfVersion", version },
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });
});
