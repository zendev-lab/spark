import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Session,
  SessionId,
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { afterEach, expect, it } from "vitest";
import {
  decodeSparkDshSessionJsonl,
  type SparkDshSessionDocument,
  type SparkDshSessionEvent,
} from "./dsh-format.ts";
import { SparkSessionStore } from "./store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(runtimeContext = false) {
  const root = await mkdtemp(join(tmpdir(), "spark-native-commit-"));
  roots.push(root);
  const store = new SparkSessionStore({ cwd: root, sparkHome: join(root, "home") });
  const record = store.createCanonicalSession({ id: "native-commit" });
  await store.save(record);
  const document = structuredClone(record.nativeDocument!);
  const emit = (type: string, data: unknown, extra: Partial<SparkDshSessionEvent> = {}) => {
    const seq = document.events.length;
    document.events.push({ type, seq, time: Date.now(), data, ...extra });
    return seq;
  };
  emit("subagent/model-selection-policy", {
    allowedModels: [{ provider: "test", model: "test" }],
  });
  emit("turn/start", { turn: 1 });
  emit(
    "user/message",
    {
      id: "native-user",
      role: "user",
      content: [{ type: "text", text: "inspect" }],
      source: { kind: "user" },
    },
    { surfaceOp: "append" },
  );
  emit("step/start", { turn: 1, step: 1 });
  emit(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      stream: [],
      message: {
        id: "native-assistant",
        role: "assistant",
        content: [{ type: "tool-call", id: "call-1", name: "read", arguments: "{}" }],
        source: { kind: "model", provider: "test", model: "test" },
      },
    },
    { surfaceOp: "append" },
  );
  const call = emit("tool/call", {
    turn: 1,
    step: 1,
    callId: "call-1",
    name: "read",
    arguments: "{}",
  });
  emit(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: {
        id: "native-tool",
        role: "tool",
        toolCallId: "call-1",
        isError: false,
        content: [{ type: "text", text: "large original result" }],
        source: { kind: "tool", callId: "call-1" },
      },
    },
    { surfaceOp: "append", sourceEventSeqs: [call] },
  );
  emit("step/end", { turn: 1, step: 1 });
  emit("turn/end", { turn: 1, reason: { kind: "completed" } });
  emit("plugin:fixture/opaque", null, { ignorable: true });
  await writeFile(record.path, jsonl(document));
  if (runtimeContext) {
    store.appendCustomMessage(record, "runtime-context", "current execution policy", false);
  }
  store.appendMessage(record, { role: "user", content: "inspect" });
  store.appendMessage(record, {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
  });
  store.appendMessage(record, {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: "large original result",
  });
  return { store, record, document };
}

it("commits a native tool turn and micro-compaction atomically without duplicating its input", async () => {
  const { store, record, document } = await fixture();
  const tool = record.entries.at(-1)!;
  if (tool.type !== "message") throw new Error("missing tool entry");
  tool.message.content = "compact tool result";
  const before = await readFile(record.path, "utf8");
  const baseline = structuredClone(record.nativeDocument);
  const originalEntries = structuredClone(record.entries);
  await expect(
    store.commitNativeTurn(record, document.events.length, {
      beforeCommit: () => {
        throw new Error("simulated commit interruption");
      },
    }),
  ).rejects.toThrow("simulated commit interruption");
  expect(await readFile(record.path, "utf8")).toBe(before);
  expect(record.nativeDocument).toEqual(baseline);
  expect(record.entries).toEqual(originalEntries);

  await store.commitNativeTurn(record, document.events.length);
  const committed = record.nativeDocument!;
  expect(committed.events.slice(0, document.events.length)).toEqual(document.events);
  expect(committed.events.filter((event) => event.type === "user/message")).toHaveLength(1);
  expect(restore(committed).deriveMessages().at(-1)?.content).toEqual([
    { type: "text", text: "compact tool result" },
  ]);
  expect((await store.load(record.path)).entries).toEqual(record.entries);
  expect(record.entries.at(-1)).toMatchObject({
    type: "subagent_model_selection",
    allowedModels: [{ provider: "test", model: "test" }],
  });
  const saved = await readFile(record.path, "utf8");
  await store.save(record);
  expect(await readFile(record.path, "utf8")).toBe(saved);
});

it("refuses stale native receipts and ordinary saves without overwriting a newer tail", async () => {
  const { store, record, document } = await fixture();
  const before = await readFile(record.path, "utf8");
  await expect(store.commitNativeTurn(record, document.events.length - 1)).rejects.toThrow(
    "durable transcript receipt",
  );
  await expect(store.save(record)).rejects.toThrow("changed since it was loaded");
  expect(await readFile(record.path, "utf8")).toBe(before);
  await store.commitNativeTurn(record, document.events.length);
  const loaded = await store.load(record.path);
  loaded.entries.pop();
  await expect(store.save(loaded)).rejects.toThrow("cannot be removed or reordered");
});

it("updates the native context when a committed turn receives a full compaction", async () => {
  const { store, record, document } = await fixture(true);
  const runtimeId = record.entries[0]!.id;
  record.entries.push({
    type: "compaction",
    id: "compact-1",
    parentId: record.entries.at(-1)!.id,
    timestamp: new Date().toISOString(),
    summary: "retained facts",
    firstKeptEntryId: "none",
    tokensBefore: 100,
  });
  await store.commitNativeTurn(record, document.events.length);
  const saved = decodeSparkDshSessionJsonl(await readFile(record.path, "utf8"))!;
  expect(saved.events.slice(0, document.events.length)).toEqual(document.events);
  const messages = restore(saved).deriveMessages();
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages[0]?.content)).toContain("retained facts");
  expect(
    saved.events.filter(
      (event) => event.type === "user/message" && (event.data as { id?: string }).id === runtimeId,
    ),
  ).toHaveLength(1);
  expect(
    saved.events.filter((event) => event.type === "subagent/model-selection-policy"),
  ).toHaveLength(1);
  expect((await store.load(record.path)).entries).toEqual(record.entries);
  const serialized = await readFile(record.path, "utf8");
  await store.save(record);
  expect(await readFile(record.path, "utf8")).toBe(serialized);
});

it("keeps retained tool results bound to their native copies after full compaction", async () => {
  const { store, record, document } = await fixture();
  await store.commitNativeTurn(record, document.events.length);
  record.entries.push({
    type: "compaction",
    id: "compact-keep",
    parentId: record.entries.at(-1)!.id,
    timestamp: new Date().toISOString(),
    summary: "older context",
    firstKeptEntryId: record.entries[0]!.id,
    tokensBefore: 100,
  });
  await store.save(record);
  const tool = record.entries[2]!;
  if (tool.type !== "message") throw new Error("missing tool entry");
  tool.message.content = "retained result shortened";
  await store.save(record);
  const messages = restore(record.nativeDocument!).deriveMessages();
  expect(messages.at(-1)?.role).toBe("tool");
  expect(messages.at(-1)?.content).toEqual([{ type: "text", text: "retained result shortened" }]);
  expect((await store.load(record.path)).entries).toEqual(record.entries);
});

it("bridges an uncommitted native history using the latest replacement before retrying a save", async () => {
  const { store, record, document } = await fixture();
  const native = restore(document);
  const tool = native.snapshotEvents().find((event) => event.type === "tool/result")!;
  if (tool.type !== "tool/result") throw new Error("missing tool event");
  native.append("turn/start", { turn: 2 });
  native.append(
    "tool/result",
    {
      ...tool.data,
      message: {
        ...tool.data.message,
        content: [{ type: "text", text: "earlier compact result" }],
      },
    },
    {
      surfaceOp: { op: "replace", startSeq: tool.seq, endSeq: tool.seq },
      sourceEventSeqs: [tool.seq],
    },
  );
  native.append("turn/end", { turn: 2, reason: { kind: "completed" } });
  document.events = [...structuredClone(native.snapshotEvents())];
  await writeFile(record.path, jsonl(document));
  const resumed = await store.load(record.path);
  const receipt: SparkDshSessionEvent = {
    type: "plugin:fixture/opaque",
    seq: document.events.length,
    time: Date.now(),
    data: null,
    ignorable: true,
  };
  document.events.push(receipt);
  await writeFile(record.path, jsonl(document));
  const message = resumed.entries.find(
    (entry) => entry.type === "message" && entry.message.role === "toolResult",
  );
  if (message?.type !== "message") throw new Error("missing projected tool result");
  message.message.content = "latest compact result";
  await store.commitNativeTurn(resumed, document.events.length);
  expect(restore(resumed.nativeDocument!).deriveMessages().at(-1)?.content).toEqual([
    { type: "text", text: "latest compact result" },
  ]);
  expect(resumed.nativeDocument!.events.slice(0, document.events.length)).toEqual(document.events);
  expect(
    resumed.nativeDocument!.events.filter(
      (event) => event.type === "subagent/model-selection-policy",
    ),
  ).toHaveLength(1);
  expect((await store.load(record.path)).entries).toEqual(resumed.entries);
  const before = await readFile(record.path, "utf8");
  await store.save(resumed);
  expect(await readFile(record.path, "utf8")).toBe(before);
});

function jsonl(document: SparkDshSessionDocument): string {
  return `${[document.header, ...document.events].map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function restore(document: SparkDshSessionDocument): Session {
  return Session.fromRestore(
    SessionId(String(document.header.id)),
    structuredClone(document.events) as SessionEvent[],
    structuredClone(document.header) as SessionHeader,
    SessionLogOffset(document.header.inheritedEventCount ?? 0),
    "detached",
  );
}
