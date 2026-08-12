import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  SPARK_SESSION_PROMPT_HISTORY_MAX_BYTES,
  SPARK_SESSION_SUBMITTED_INPUT_MAX_BYTES,
  parseSparkSessionRegistryRecord,
} from "@zendev-lab/spark-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSparkSessionMediaChunk,
  loadSparkSessionPromptHistory,
  loadSparkSessionSnapshot,
  loadSparkSessionSnapshotTail,
  refreshSparkSessionSnapshotIndex,
  sparkSessionSnapshotIndexPath,
} from "./snapshot.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createLinearTranscript(entryCount: number, sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), "spark-session-indexed-tail-"));
  roots.push(root);
  const transcriptPath = join(root, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-08-03T00:00:00.000Z",
      cwd: root,
    }),
  ];
  let parentId: string | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    const id = `message-${index}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-08-03T00:00:01.000Z",
        message: { role: "user", content: `消息 ${index}` },
      }),
    );
    parentId = id;
  }
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  const session = parseSparkSessionRegistryRecord({
    sessionId,
    scope: { kind: "workspace", workspaceId: "ws_large" },
    status: "ready",
    sessionPath: transcriptPath,
    bindings: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:01.000Z",
  });
  return { root, transcriptPath, session };
}

describe("loadSparkSessionSnapshot", () => {
  it("projects the latest 100 user prompts from a bounded inline index summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-prompt-history-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const sessionId = "sess_prompt_history";
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      }),
    ];
    let parentId: string | null = null;
    for (let index = 0; index < 1_000; index += 1) {
      const id = `message-${index}`;
      const user = index % 9 === 0;
      lines.push(
        JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp: "2026-08-12T00:00:01.000Z",
          message: {
            role: user ? "user" : "assistant",
            content: `${user ? "durable prompt" : "non-user reply"} ${index}`,
          },
        }),
      );
      parentId = id;
    }
    await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
    const session = parseSparkSessionRegistryRecord({
      sessionId,
      scope: { kind: "workspace", workspaceId: "ws_prompt_history" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    });

    const refreshed = await refreshSparkSessionSnapshotIndex({
      sessionPath: transcriptPath,
      sessionId,
    });
    const persistedIndex = JSON.parse(await readFile(refreshed.indexPath, "utf8")) as {
      prompts: Array<{ messageId: string; text: string }>;
      totalPrompts: number;
    };
    expect(persistedIndex.prompts).toHaveLength(100);
    expect(persistedIndex.prompts[0]).toEqual({
      messageId: "message-108",
      text: "durable prompt 108",
    });
    expect(persistedIndex.totalPrompts).toBe(112);

    const history = await loadSparkSessionPromptHistory({
      sessionsRoot: root,
      session,
      limit: 100,
    });

    expect(history.totalPrompts).toBe(112);
    expect(history.prompts).toHaveLength(100);
    expect(history.prompts[0]).toMatchObject({
      messageId: "message-108",
      text: "durable prompt 108",
    });
    expect(history.prompts.at(-1)).toMatchObject({
      messageId: "message-999",
      text: "durable prompt 999",
    });
    expect(history.truncated).toBe(true);
  });

  it("rebuilds an older additive index once before bounded prompt reads", async () => {
    const fixture = await createLinearTranscript(64, "sess_legacy_prompt_index");
    const refreshed = await refreshSparkSessionSnapshotIndex({
      sessionPath: fixture.transcriptPath,
      sessionId: fixture.session.sessionId,
    });
    const legacy = JSON.parse(await readFile(refreshed.indexPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete legacy.prompts;
    delete legacy.totalPrompts;
    await writeFile(refreshed.indexPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const history = await loadSparkSessionPromptHistory({
      sessionsRoot: fixture.root,
      session: fixture.session,
      limit: 8,
    });
    expect(history.prompts.map((prompt) => prompt.messageId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `message-${56 + index}`),
    );
    const rebuilt = JSON.parse(await readFile(refreshed.indexPath, "utf8")) as {
      prompts: unknown[];
      totalPrompts: number;
    };
    expect(rebuilt.prompts).toHaveLength(64);
    expect(rebuilt.totalPrompts).toBe(64);
  });

  it("recalls exact submitted file and image input while old entries fall back to text", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-raw-prompt-history-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const sessionId = "sess_raw_prompt_history";
    const entries = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "prompt-file",
        parentId: null,
        timestamp: "2026-08-12T00:00:01.000Z",
        message: {
          role: "user",
          content: '<file name="README.md">expanded contents</file>',
          metadata: {
            invocationId: "inv-file",
            submittedInput: { text: "@README.md" },
          },
        },
      },
      {
        type: "message",
        id: "prompt-image",
        parentId: "prompt-file",
        timestamp: "2026-08-12T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }],
          metadata: { submittedInput: { text: "./cat.png" } },
        },
      },
      {
        type: "message",
        id: "prompt-legacy",
        parentId: "prompt-image",
        timestamp: "2026-08-12T00:00:03.000Z",
        message: { role: "user", content: "legacy editor prompt" },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId,
      scope: { kind: "workspace", workspaceId: "ws_raw_prompt_history" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:03.000Z",
    });

    await refreshSparkSessionSnapshotIndex({ sessionPath: transcriptPath, sessionId });
    const history = await loadSparkSessionPromptHistory({
      sessionsRoot: root,
      session,
      limit: 100,
    });
    expect(history.prompts).toEqual([
      { messageId: "prompt-file", text: "@README.md" },
      { messageId: "prompt-image", text: "./cat.png" },
      { messageId: "prompt-legacy", text: "legacy editor prompt" },
    ]);
    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });
    expect(snapshot.messages[0]?.metadata).toEqual({ invocationId: "inv-file" });
    expect(snapshot.messages[0]?.metadata).not.toHaveProperty("submittedInput");
  });

  it("keeps huge expanded file content out of the bounded prompt-history index", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-huge-expanded-prompt-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const sessionId = "sess_huge_expanded_prompt";
    const expandedMarker = "expanded-file-content-must-not-enter-index";
    const expandedContent = `${expandedMarker}:${"x".repeat(2 * 1024 * 1024)}`;
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      }),
      JSON.stringify({
        type: "message",
        id: "prompt-huge-file",
        parentId: null,
        timestamp: "2026-08-12T00:00:01.000Z",
        message: {
          role: "user",
          content: `<file name="huge.txt">${expandedContent}</file>`,
          metadata: { submittedInput: { text: "@huge.txt summarize" } },
        },
      }),
    ];
    await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
    const session = parseSparkSessionRegistryRecord({
      sessionId,
      scope: { kind: "workspace", workspaceId: "ws_huge_expanded_prompt" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    });

    const refreshed = await refreshSparkSessionSnapshotIndex({
      sessionPath: transcriptPath,
      sessionId,
    });
    const indexText = await readFile(refreshed.indexPath, "utf8");
    const persistedIndex = JSON.parse(indexText) as {
      prompts: Array<{ messageId: string; text: string }>;
    };
    expect(persistedIndex.prompts).toEqual([
      { messageId: "prompt-huge-file", text: "@huge.txt summarize" },
    ]);
    expect(indexText).not.toContain(expandedMarker);
    expect(Buffer.byteLength(indexText)).toBeLessThan(SPARK_SESSION_PROMPT_HISTORY_MAX_BYTES);
    expect((await stat(refreshed.indexPath)).mode & 0o777).toBe(0o600);

    await expect(
      loadSparkSessionPromptHistory({ sessionsRoot: root, session, limit: 100 }),
    ).resolves.toEqual({
      sessionId,
      prompts: [{ messageId: "prompt-huge-file", text: "@huge.txt summarize" }],
      totalPrompts: 1,
      truncated: false,
    });
  });

  it("measures the exact returned prompt-history object against its byte bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-prompt-history-bytes-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const sessionId = "sess_prompt_history_bytes";
    const raw = "x".repeat(SPARK_SESSION_SUBMITTED_INPUT_MAX_BYTES - 128);
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-12T00:00:00.000Z",
        cwd: root,
      }),
    ];
    let parentId: string | null = null;
    for (let index = 0; index < 20; index += 1) {
      const id = `prompt-${index}`;
      lines.push(
        JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp: "2026-08-12T00:00:01.000Z",
          message: {
            role: "user",
            content: `expanded ${index}`,
            metadata: { submittedInput: { text: `${index}:${raw}` } },
          },
        }),
      );
      parentId = id;
    }
    await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
    const session = parseSparkSessionRegistryRecord({
      sessionId,
      scope: { kind: "workspace", workspaceId: "ws_prompt_history_bytes" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    });

    await refreshSparkSessionSnapshotIndex({ sessionPath: transcriptPath, sessionId });
    const history = await loadSparkSessionPromptHistory({
      sessionsRoot: root,
      session,
      limit: 100,
    });
    expect(history.prompts.length).toBeLessThan(20);
    expect(history.prompts.at(-1)?.messageId).toBe("prompt-19");
    expect(history.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(
      SPARK_SESSION_PROMPT_HISTORY_MAX_BYTES,
    );
  });

  it("projects persisted user images without folding bytes into message text", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-image-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const imageData = Buffer.from([137, 80, 78, 71]).toString("base64");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "sess_image",
        timestamp: "2026-07-23T10:00:00.000Z",
        cwd: "/workspace/demo",
      },
      {
        type: "message",
        id: "user-image",
        parentId: null,
        timestamp: "2026-07-23T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "[图片]\n这是什么动物" },
            { type: "image", data: imageData, mimeType: "image/png", name: "cat.png" },
          ],
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_image",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:01.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });

    expect(snapshot.messages).toMatchObject([
      {
        id: "user-image",
        text: "[图片]\n这是什么动物",
        parts: [
          { type: "text", text: "[图片]\n这是什么动物" },
          { type: "image", contentIndex: 1, mediaType: "image/png", name: "cat.png" },
        ],
      },
    ]);

    const media = await loadSparkSessionMediaChunk({
      sessionsRoot: root,
      session,
      messageId: "user-image",
      contentIndex: 1,
      offset: 0,
      limit: 2,
    });
    expect(media).toMatchObject({
      messageId: "user-image",
      contentIndex: 1,
      mediaType: "image/png",
      sizeBytes: 4,
      data: Buffer.from([137, 80]).toString("base64"),
      nextOffset: 2,
      complete: false,
    });
  });

  it("projects lifetime usage, current context, runtime selection, and daemon-local branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-usage-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "sess_usage",
        timestamp: "2026-07-17T01:00:00.000Z",
        cwd: "/workspace/demo",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-07-17T01:00:01.000Z",
        message: { role: "user", content: "first" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-07-17T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
          api: "openai-responses",
          provider: "baidu-oneapi",
          model: "gpt-5.6-sol",
          stopReason: "stop",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 50,
            cacheWrite: 10,
            totalTokens: 180,
            cost: { input: 0.02, output: 0.03, cacheRead: 0.01, cacheWrite: 0.04, total: 0.1 },
            providerSecret: "must-not-project",
          },
          providerSecret: "must-not-project",
        },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "assistant-1",
        timestamp: "2026-07-17T01:00:03.000Z",
      },
      {
        type: "message",
        id: "user-2",
        parentId: "compact-1",
        timestamp: "2026-07-17T01:00:04.000Z",
        message: { role: "user", content: "second" },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "user-2",
        timestamp: "2026-07-17T01:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second response" }],
          api: "openai-responses",
          provider: "baidu-oneapi",
          model: "gpt-5.6-sol",
          stopReason: "stop",
          usage: {
            input: 40,
            output: 10,
            cacheRead: 160,
            cacheWrite: 0,
            totalTokens: 210,
            cost: { input: 0.04, output: 0.06, cacheRead: 0.1, cacheWrite: 0, total: 0.2 },
          },
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_usage",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "ready",
      sessionPath: transcriptPath,
      model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
      bindings: [],
      createdAt: "2026-07-17T01:00:00.000Z",
      updatedAt: "2026-07-17T01:00:05.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({
      sessionsRoot: root,
      session,
      resolveGitBranch: async (cwd) => (cwd === "/workspace/demo" ? "main" : undefined),
    });

    expect(snapshot).toMatchObject({
      cwd: "/workspace/demo",
      gitBranch: "main",
      model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
      usage: {
        inputTokens: 140,
        outputTokens: 30,
        cacheReadTokens: 210,
        cacheWriteTokens: 10,
        costUsd: expect.closeTo(0.3, 10),
        latestCacheHitPercent: 80,
        contextTokens: 210,
      },
    });
    expect(snapshot.messages.find((message) => message.id === "assistant-2")?.metadata).toEqual({
      api: "openai-responses",
      provider: "baidu-oneapi",
      model: "gpt-5.6-sol",
      stopReason: "stop",
      usage: {
        input: 40,
        output: 10,
        cacheRead: 160,
        cacheWrite: 0,
        totalTokens: 210,
        cost: { input: 0.04, output: 0.06, cacheRead: 0.1, cacheWrite: 0, total: 0.2 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-project");
  });

  it("projects ordered thinking and tool parts without leaking native tool payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-snapshot-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "sess_parts",
        timestamp: "2026-07-13T01:00:00.000Z",
        cwd: "/workspace/demo",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-07-13T01:00:01.000Z",
        message: {
          role: "user",
          content: "Inspect the repository",
          timestamp: 1783904401000,
          metadata: {
            invocationId: "inv_user_1",
            channel: {
              adapter: "infoflow",
              externalKey: "infoflow:group:10838226",
              senderId: "xuxiaojian",
              senderName: "徐晓健",
              messageId: "1870315656716618699",
              contentType: "mixed",
              attachments: [
                { kind: "file", name: "plan.pdf", reference: "fid-plan" },
                { kind: "unknown", url: "https://signed.invalid" },
              ],
              secret: "must-not-project",
            },
            raw: { token: "must-not-project" },
          },
        },
      },
      {
        type: "message",
        id: "assistant-inactive",
        parentId: "user-1",
        timestamp: "2026-07-13T01:00:01.500Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret-inactive-thinking" },
            {
              type: "toolCall",
              id: "call-inactive",
              name: "inactive-tool",
              arguments: { token: "secret-inactive-argument" },
            },
          ],
          timestamp: 1783904401500,
        },
      },
      {
        type: "message",
        id: "assistant-tools",
        parentId: "user-1",
        timestamp: "2026-07-13T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check the relevant files first." },
            { type: "text", text: "I will inspect the repository." },
            {
              type: "toolCall",
              id: "call-success",
              name: "read",
              arguments: { path: "README.md", token: "secret-token" },
            },
            {
              type: "toolCall",
              id: "call-failure",
              name: "exec",
              arguments: { command: "pnpm test" },
            },
          ],
          timestamp: 1783904402000,
        },
      },
      {
        type: "message",
        id: "result-success",
        parentId: "assistant-tools",
        timestamp: "2026-07-13T01:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-success",
          toolName: "read",
          content: [{ type: "text", text: "safe-output" }],
          details: { token: "secret-details" },
          isError: false,
          timestamp: 1783904403000,
        },
      },
      {
        type: "message",
        id: "result-failure",
        parentId: "result-success",
        timestamp: "2026-07-13T01:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-failure",
          toolName: "exec",
          content: [
            {
              type: "text",
              text: "503 command failed<html><body><svg>unsafe-tool-error</svg></body></html>",
            },
          ],
          details: { stderr: "secret-error-details" },
          isError: true,
          timestamp: 1783904404000,
        },
      },
      {
        type: "message",
        id: "assistant-pending",
        parentId: "result-failure",
        timestamp: "2026-07-13T01:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "secret-redacted-thinking",
              thinkingSignature: "secret-signature",
              redacted: true,
            },
            {
              type: "toolCall",
              id: "call-pending",
              name: "search",
              arguments: { pattern: "TODO" },
            },
            { type: "text", text: "The next check is pending." },
          ],
          timestamp: 1783904405000,
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_parts",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "running",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-13T01:00:05.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });

    expect(snapshot.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-tools",
      "result-success",
      "result-failure",
      "assistant-pending",
    ]);
    expect(snapshot.messages).toMatchObject([
      {
        id: "user-1",
        role: "user",
        text: "Inspect the repository",
        metadata: {
          invocationId: "inv_user_1",
          channel: {
            adapter: "infoflow",
            externalKey: "infoflow:group:10838226",
            senderId: "xuxiaojian",
            senderName: "徐晓健",
            messageId: "1870315656716618699",
            contentType: "mixed",
            attachments: [{ kind: "file", name: "plan.pdf", reference: "fid-plan" }],
          },
        },
        parts: [{ id: "user-1:part:0", type: "text", status: "complete" }],
      },
      {
        id: "assistant-tools",
        role: "assistant",
        text: "I will inspect the repository.",
        status: "done",
        parts: [
          {
            id: "assistant-tools:part:0",
            type: "thinking",
            status: "complete",
            text: "Check the relevant files first.",
          },
          { id: "assistant-tools:part:1", type: "text", status: "complete" },
          {
            id: "assistant-tools:part:2",
            type: "tool-call",
            toolCallId: "call-success",
            toolName: "read",
            status: "complete",
          },
          {
            id: "assistant-tools:part:3",
            type: "tool-call",
            toolCallId: "call-failure",
            toolName: "exec",
            status: "failed",
          },
        ],
      },
      {
        id: "result-success",
        role: "tool",
        text: "safe-output",
        status: "done",
        parts: [
          {
            id: "result-success:part:0",
            type: "tool-result",
            toolCallId: "call-success",
            status: "complete",
            summary: "safe-output",
          },
        ],
      },
      {
        id: "result-failure",
        role: "tool",
        text: "503 command failed",
        status: "done",
        parts: [
          {
            id: "result-failure:part:0",
            type: "tool-result",
            toolCallId: "call-failure",
            status: "failed",
            summary: "503 command failed",
          },
        ],
      },
      {
        id: "assistant-pending",
        role: "assistant",
        text: "The next check is pending.",
        parts: [
          {
            id: "assistant-pending:part:0",
            type: "thinking",
            text: "",
            redacted: true,
          },
          {
            id: "assistant-pending:part:1",
            type: "tool-call",
            toolCallId: "call-pending",
            status: "pending",
          },
          { id: "assistant-pending:part:2", type: "text" },
        ],
      },
    ]);
    expect(snapshot.tools).toMatchObject([
      { id: "call-success", name: "read", status: "succeeded" },
      { id: "call-failure", name: "exec", status: "failed" },
      { id: "call-pending", name: "search", status: "pending" },
    ]);
    expect(snapshot.tools.map((tool) => tool.id)).toEqual([
      "call-success",
      "call-failure",
      "call-pending",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /secret-token|secret-details|secret-signature|secret-redacted-thinking|secret-inactive|must-not-project|unsafe-tool-error/u,
    );
  });

  it("keeps text phases without projecting commentary as assistant prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-text-phase-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "sess_text_phase",
        timestamp: "2026-07-13T02:00:00.000Z",
        cwd: "/workspace/demo",
      },
      {
        type: "message",
        id: "user-phase",
        parentId: null,
        timestamp: "2026-07-13T02:00:01.000Z",
        message: { role: "user", content: "Run the check", timestamp: 1783908001000 },
      },
      {
        type: "message",
        id: "assistant-phase",
        parentId: "user-phase",
        timestamp: "2026-07-13T02:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Checking the repository.",
              textSignature: JSON.stringify({
                v: 1,
                phase: "commentary",
                providerSecret: "commentary-signature-secret",
              }),
            },
            {
              type: "text",
              text: "The check passed.",
              textSignature: JSON.stringify({
                phase: "final_answer",
                providerSecret: "final-signature-secret",
              }),
            },
            { type: "text", text: "Legacy detail." },
            {
              type: "text",
              text: "Unknown phase stays visible.",
              textSignature: JSON.stringify({ phase: "future_phase" }),
            },
            {
              type: "text",
              text: "Malformed signature stays visible.",
              textSignature: "not-json-signature-secret",
            },
          ],
          timestamp: 1783908002000,
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_text_phase",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-07-13T02:00:00.000Z",
      updatedAt: "2026-07-13T02:00:02.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });
    const assistant = snapshot.messages.find((message) => message.id === "assistant-phase");

    expect(assistant?.text).toBe(
      "The check passed.\nLegacy detail.\nUnknown phase stays visible.\nMalformed signature stays visible.",
    );
    expect(assistant?.parts).toMatchObject([
      { type: "text", text: "Checking the repository.", phase: "commentary" },
      { type: "text", text: "The check passed.", phase: "final_answer" },
      { type: "text", text: "Legacy detail." },
      { type: "text", text: "Unknown phase stays visible." },
      { type: "text", text: "Malformed signature stays visible." },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /commentary-signature-secret|final-signature-secret|not-json-signature-secret/u,
    );
  });

  it("projects an empty-content provider failure as a bounded readable error", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-provider-error-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const gatewayPage = [
      "504 upstream request failed",
      "<!doctype html><html><head><title>504 Gateway Time-out</title>",
      `<style>${"unsafe-style".repeat(2_000)}</style></head>`,
      `<body><svg>${"unsafe-svg".repeat(2_000)}</svg><script>secret()</script></body></html>`,
    ].join("\n");
    await writeFile(
      transcriptPath,
      `${[
        {
          type: "session",
          version: 3,
          id: "sess_provider_error",
          timestamp: "2026-07-13T03:00:00.000Z",
          cwd: "/workspace/demo",
        },
        {
          type: "message",
          id: "user-error",
          parentId: null,
          timestamp: "2026-07-13T03:00:01.000Z",
          message: { role: "user", content: "Continue the task" },
        },
        {
          type: "message",
          id: "assistant-error",
          parentId: "user-error",
          timestamp: "2026-07-13T03:00:02.000Z",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: gatewayPage,
          },
        },
        {
          type: "message",
          id: "assistant-error-without-detail",
          parentId: "assistant-error",
          timestamp: "2026-07-13T03:00:03.000Z",
          message: { role: "assistant", content: [], stopReason: "error" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_provider_error",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-07-13T03:00:00.000Z",
      updatedAt: "2026-07-13T03:00:02.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });
    const failure = snapshot.messages.find((message) => message.id === "assistant-error");
    const serialized = JSON.stringify(snapshot);

    expect(failure).toMatchObject({
      id: "assistant-error",
      role: "assistant",
      status: "error",
      text: "504 upstream request failed — 504 Gateway Time-out",
      metadata: {
        stopReason: "error",
        errorMessage: "504 upstream request failed — 504 Gateway Time-out",
      },
      parts: [
        {
          type: "text",
          status: "failed",
          text: "504 upstream request failed — 504 Gateway Time-out",
        },
      ],
    });
    expect(serialized.length).toBeLessThan(5_000);
    expect(serialized).not.toMatch(/<!doctype|<html|<svg|<script|unsafe-style|unsafe-svg/iu);
    expect(snapshot.messages.at(-1)).toMatchObject({
      id: "assistant-error-without-detail",
      status: "error",
      text: "The provider request failed without additional details.",
    });
  });

  it("uses an index hit to open only 32 entries from a 10,000-entry transcript", async () => {
    const fixture = await createLinearTranscript(10_000, "sess_large_tail");
    const refreshed = await refreshSparkSessionSnapshotIndex({
      sessionPath: fixture.transcriptPath,
      sessionId: fixture.session.sessionId,
    });
    expect(refreshed.messageCount).toBe(10_000);
    const indexMode = (await stat(refreshed.indexPath)).mode & 0o777;
    expect(indexMode).toBe(0o600);
    const persistedIndex = JSON.parse(await readFile(refreshed.indexPath, "utf8")) as {
      messages: unknown[];
      totalMessages: number;
    };
    expect(persistedIndex.messages).toHaveLength(200);
    expect(persistedIndex.totalMessages).toBe(10_000);

    const startedAt = performance.now();
    const tail = await loadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
      messageLimit: 32,
      resolveGitBranch: async () => undefined,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(tail.totalMessages).toBe(10_000);
    expect(tail.snapshot.messages).toHaveLength(32);
    expect(tail.snapshot.messages[0]?.id).toBe("message-9968");
    expect(tail.snapshot.messages.at(-1)?.id).toBe("message-9999");
    expect(tail.snapshot.messages.at(-1)?.text).toBe("消息 9999");
    expect(tail.read).toMatchObject({
      indexStatus: "hit",
      indexSaved: true,
      fullTranscriptRead: false,
    });
    expect(tail.read.parsedTranscriptEntries).toBeLessThanOrEqual(32);
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      "SPARK_SESSION_LAZY_SNAPSHOT_EVIDENCE",
      JSON.stringify({
        transcriptEntries: 10_000,
        indexDescriptors: persistedIndex.messages.length,
        indexMode: indexMode.toString(8),
        totalMessages: tail.totalMessages,
        loadedMessages: tail.snapshot.messages.length,
        firstMessageId: tail.snapshot.messages[0]?.id,
        lastMessageId: tail.snapshot.messages.at(-1)?.id,
        indexStatus: tail.read.indexStatus,
        parsedTranscriptEntries: tail.read.parsedTranscriptEntries,
        fullTranscriptRead: tail.read.fullTranscriptRead,
        elapsedMs: Number(elapsedMs.toFixed(2)),
      }),
    );
  });

  it("rebuilds a missing snapshot index once and then uses the bounded hit path", async () => {
    const fixture = await createLinearTranscript(64, "sess_missing_index");
    const first = await loadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
      messageLimit: 8,
      resolveGitBranch: async () => undefined,
    });
    expect(first.read).toMatchObject({
      indexStatus: "rebuilt",
      rebuildReason: "missing",
      indexSaved: true,
      fullTranscriptRead: true,
    });
    const second = await loadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
      messageLimit: 8,
      resolveGitBranch: async () => undefined,
    });
    expect(second.read).toMatchObject({ indexStatus: "hit", fullTranscriptRead: false });
  });

  it("rebuilds a corrupt snapshot index without trusting its offsets", async () => {
    const fixture = await createLinearTranscript(64, "sess_corrupt_index");
    await refreshSparkSessionSnapshotIndex({
      sessionPath: fixture.transcriptPath,
      sessionId: fixture.session.sessionId,
    });
    const indexPath = sparkSessionSnapshotIndexPath(fixture.transcriptPath);
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      messages: Array<{ sha256: string }>;
    };
    index.messages.at(-1)!.sha256 = "0".repeat(64);
    await writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");
    const rebuilt = await loadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
      messageLimit: 8,
      resolveGitBranch: async () => undefined,
    });
    expect(rebuilt.read).toMatchObject({
      indexStatus: "rebuilt",
      rebuildReason: "corrupt",
      indexSaved: true,
      fullTranscriptRead: true,
    });
    expect(rebuilt.snapshot.messages.at(-1)?.id).toBe("message-63");
  });

  it("rebuilds a checkpoint-stale snapshot index before reading appended history", async () => {
    const fixture = await createLinearTranscript(64, "sess_stale_index");
    await refreshSparkSessionSnapshotIndex({
      sessionPath: fixture.transcriptPath,
      sessionId: fixture.session.sessionId,
    });
    await appendFile(
      fixture.transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "message-64",
        parentId: "message-63",
        timestamp: "2026-08-03T00:00:02.000Z",
        message: { role: "user", content: "message 64" },
      })}\n`,
      "utf8",
    );
    const rebuilt = await loadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
      messageLimit: 8,
      resolveGitBranch: async () => undefined,
    });
    expect(rebuilt.totalMessages).toBe(65);
    expect(rebuilt.snapshot.messages.at(-1)?.id).toBe("message-64");
    expect(rebuilt.read).toMatchObject({
      indexStatus: "rebuilt",
      rebuildReason: "stale",
      indexSaved: true,
      fullTranscriptRead: true,
    });
    const second = await loadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
      messageLimit: 8,
      resolveGitBranch: async () => undefined,
    });
    expect(second.read).toMatchObject({ indexStatus: "hit", fullTranscriptRead: false });
  });

  it("backfills a settled tool-ended branch with an interruption error but leaves a running turn open", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-missing-final-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          type: "session",
          version: 3,
          id: "sess_missing_final",
          timestamp: "2026-07-13T04:00:00.000Z",
          cwd: "/workspace/demo",
        },
        {
          type: "message",
          id: "user-missing-final",
          parentId: null,
          timestamp: "2026-07-13T04:00:01.000Z",
          message: { role: "user", content: "Run the check" },
        },
        {
          type: "message",
          id: "assistant-tool-call",
          parentId: "user-missing-final",
          timestamp: "2026-07-13T04:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-check", name: "exec", arguments: {} }],
          },
        },
        {
          type: "message",
          id: "tool-result-final-leaf",
          parentId: "assistant-tool-call",
          timestamp: "2026-07-13T04:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-check",
            toolName: "exec",
            content: [{ type: "text", text: "tests passed" }],
            isError: false,
          },
        },
        {
          type: "compaction",
          id: "compaction-after-tool-result",
          parentId: "tool-result-final-leaf",
          timestamp: "2026-07-13T04:00:04.000Z",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
    const record = (status: "ready" | "running") =>
      parseSparkSessionRegistryRecord({
        sessionId: "sess_missing_final",
        scope: { kind: "workspace", workspaceId: "ws_demo" },
        status,
        sessionPath: transcriptPath,
        bindings: [],
        createdAt: "2026-07-13T04:00:00.000Z",
        updatedAt: "2026-07-13T04:00:03.000Z",
      });

    const settled = await loadSparkSessionSnapshot({
      sessionsRoot: root,
      session: record("ready"),
    });
    const running = await loadSparkSessionSnapshot({
      sessionsRoot: root,
      session: record("running"),
    });
    await refreshSparkSessionSnapshotIndex({
      sessionPath: transcriptPath,
      sessionId: "sess_missing_final",
    });
    const settledTail = await loadSparkSessionSnapshotTail({
      sessionsRoot: root,
      session: record("ready"),
      messageLimit: 2,
    });

    expect(settled.messages.at(-1)).toMatchObject({
      id: "tool-result-final-leaf:missing-final-response",
      role: "system",
      status: "error",
      text: expect.stringContaining("before a final response"),
      metadata: { kind: "missing_final_response", errorTitle: "Session interrupted" },
    });
    expect(running.messages.at(-1)).toMatchObject({
      id: "tool-result-final-leaf",
      role: "tool",
    });
    expect(settledTail.snapshot.messages).toHaveLength(2);
    expect(settledTail.snapshot.messages.at(-1)?.id).toBe(
      "tool-result-final-leaf:missing-final-response",
    );
    expect(settledTail.totalMessages).toBe(4);
    expect(settledTail.read).toMatchObject({
      indexStatus: "hit",
      parsedTranscriptEntries: 2,
      fullTranscriptRead: false,
    });
  });
});
