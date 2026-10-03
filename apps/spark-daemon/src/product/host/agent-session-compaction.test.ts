import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SparkSessionStore, type SparkSessionRecord } from "@zendev-lab/spark-session/transcript";
import { SparkAgentSession } from "./agent-session.ts";
import { sparkPromptItemFromProviderMessage } from "./agent-runtime/prompt-items.ts";
import { DEFAULT_SPARK_COMPACTION_SETTINGS } from "./compaction.ts";
import type { SparkCliHostServices } from "./contracts.ts";
import { SparkAgentLoop } from "./agent-runtime/agent-loop.ts";
import { createSparkDshTurnTestRuntime } from "./agent-runtime/testing/dsh-runtime.ts";
import { SparkHostRuntime } from "./runtime.ts";
import { createSparkDaemonSessionPersistencePlugin } from "../../session-persistence.ts";
import type { Model } from "@zendev-lab/spark-llm-providers";

test("real DSH turns commit into the same transcript and resume without rewriting their raw history", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-session-native-roundtrip-"));
  const runtime = await createSparkDshTurnTestRuntime(1);
  try {
    const store = new SparkSessionStore({ cwd: root, sparkHome: join(root, "home") });
    await runtime.ctx.plugin(createSparkDaemonSessionPersistencePlugin(store.sessionsRoot));
    const host = new SparkHostRuntime({ cwd: root });
    const model: Model<string> = {
      id: "scripted",
      name: "Scripted",
      provider: "scripted",
      api: "openai-completions",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 1000,
    };
    const loop = new SparkAgentLoop({
      host,
      dshContext: runtime.ctx,
      getModel: () => model,
      llm: {
        async *stream() {
          yield { type: "text-delta", index: 0, text: "durable answer" };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
    });
    const session = new SparkAgentSession({
      cwd: root,
      sessionStore: store,
      runtime: host,
      agentLoop: loop,
      config: { compact: { ...DEFAULT_SPARK_COMPACTION_SETTINGS, enabled: false } },
    } as unknown as SparkCliHostServices);
    const first = await session.run({ sessionId: "native-roundtrip", prompt: "first question" });
    expect(first.outcome?.status).toBe("completed");
    const saved = await store.load(first.sessionPath);
    expect(saved.entries.filter((entry) => entry.type === "message")).toHaveLength(2);
    const prefix = structuredClone(saved.nativeDocument!.events);
    const second = await session.run({
      sessionId: "native-roundtrip",
      sessionPath: first.sessionPath,
      prompt: "second question",
    });
    expect(second.outcome?.status).toBe("completed");
    const continued = await store.load(first.sessionPath);
    expect(continued.entries.filter((entry) => entry.type === "message")).toHaveLength(4);
    expect(continued.nativeDocument!.events.slice(0, prefix.length)).toEqual(prefix);
    expect(
      continued.nativeDocument!.events.filter((event) => event.type === "user/message"),
    ).toHaveLength(2);
    expect(loop.getNativeCommitEventCount()).toBeUndefined();
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed full pass retains only the preceding durable micro-compaction checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-overflow-checkpoint-"));
  try {
    const store = new SparkSessionStore({ cwd: root, sparkHome: join(root, "home") });
    const record = store.createCanonicalSession({ id: "overflow-checkpoint" });
    await store.save(record);
    const items = [
      sparkPromptItemFromProviderMessage({ role: "user", content: "run checks" }),
      sparkPromptItemFromProviderMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "check", name: "cue_exec", arguments: {} }],
      }),
      sparkPromptItemFromProviderMessage({
        role: "toolResult",
        toolName: "cue_exec",
        toolCallId: "check",
        content: [{ type: "text", text: "identical status line\n".repeat(2000) }],
      }),
    ];
    const session = new SparkAgentSession({
      sessionStore: store,
      config: {
        compact: {
          ...DEFAULT_SPARK_COMPACTION_SETTINGS,
          microThreshold: 0.01,
          fullThreshold: 0.01,
        },
      },
      providerRegistry: { buildActiveModel: () => ({ contextWindow: 100 }) },
      agentLoop: { getPromptItems: () => items, getNativeCommitEventCount: () => undefined },
    } as unknown as SparkCliHostServices);
    const recovery = session as unknown as {
      tryCompactAfterOverflow(
        record: SparkSessionRecord,
        beforeCount: number,
        persisted: boolean,
      ): Promise<unknown>;
      tryCompact(record: SparkSessionRecord): Promise<boolean>;
    };
    let fullAttempted = false;
    // The summary/commit boundary fails after preparing entries. The micro pass
    // and all transcript persistence use their real implementations.
    recovery.tryCompact = async (checkpoint) => {
      fullAttempted = true;
      store.appendCustomEntry(checkpoint, "uncommitted-full-pass", {});
      return false;
    };
    expect(await recovery.tryCompactAfterOverflow(record, 0, false)).toBe("stop-after-checkpoint");
    expect(fullAttempted).toBe(true);
    expect(
      record.entries.some(
        (entry) => entry.type === "custom" && entry.customType === "spark-compaction-micro",
      ),
    ).toBe(true);
    expect(
      record.entries.some(
        (entry) => entry.type === "custom" && entry.customType === "uncommitted-full-pass",
      ),
    ).toBe(false);
    const loaded = await store.load(record.path);
    expect(record.entries).toEqual(loaded.entries);
    expect(record.nativeDocument).toEqual(loaded.nativeDocument);
    const before = await readFile(record.path, "utf8");
    await store.save(record);
    expect(await readFile(record.path, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
