/** Native DSH transcript codec behavior owned by spark-session. */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Session,
  SessionId,
  TOOL_OUTCOME_UNKNOWN,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";

import {
  decodeSparkDshSessionJsonl,
  dshDocumentToSparkRecord,
  type SparkDshSessionEvent,
} from "./dsh-format.ts";
import { SparkSessionStore } from "./store.ts";
import type { SparkSessionMessage, SparkSessionMessageEntry, SparkSessionRecord } from "./types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native DSH transcript v4", () => {
  it("writes model-visible messages to the DSH surface and round-trips the Spark projection", async () => {
    const { store, record } = await fixture("surface");
    record.entries = [
      message("u1", null, { role: "user", content: "question" }),
      message("a1", "u1", {
        role: "assistant",
        provider: "openai",
        model: "gpt-test",
        content: [{ type: "text", text: "answer", textSignature: "sig" }],
      }),
    ];

    await store.save(record);
    const content = await readFile(record.path, "utf8");
    expect(content).not.toContain("spark/entry");
    const document = decodeSparkDshSessionJsonl(content);
    expect(document).toBeDefined();
    if (!document) return;
    expect(document.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn/start",
        "user/message",
        "step/start",
        "assistant/message",
        "step/end",
        "turn/end",
      ]),
    );
    expect(document.events.filter((event) => event.type === "spark/record")).toHaveLength(0);
    expect(document.events.filter((event) => event.type === "spark/message-meta")).toHaveLength(2);
    const session = Session.fromRestore(
      SessionId(record.header.id),
      structuredClone(document.events) as SessionEvent[],
      structuredClone(document.header),
    );
    expect(session.deriveMessages().map((value) => value.content)).toEqual([
      [{ type: "text", text: "question" }],
      [{ type: "text", text: "answer" }],
    ]);
    expect(dshDocumentToSparkRecord(record.path, document).entries).toEqual(record.entries);
  });

  it("keeps a tool call, its result, and the follow-up model step in one DSH turn", async () => {
    const { store, record } = await fixture("tool-step");
    record.entries = [
      message("u1", null, { role: "user", content: "inspect" }),
      message("a1", "u1", {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
        ],
      }),
      message("t1", "a1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
      }),
      message("a2", "t1", { role: "assistant", content: "done" }),
    ];

    await store.save(record);
    const document = decodeSparkDshSessionJsonl(await readFile(record.path, "utf8"));
    expect(document).toBeDefined();
    if (!document) return;
    expect(document.events.filter((event) => event.type === "turn/start")).toHaveLength(1);
    expect(
      document.events.filter((event) => event.type === "step/start").map((event) => event.data),
    ).toEqual([
      { turn: 1, step: 1 },
      { turn: 1, step: 2 },
    ]);
    const call = document.events.find((event) => event.type === "tool/call");
    const result = document.events.find((event) => event.type === "tool/result");
    expect(result).toMatchObject({
      data: { turn: 1, step: 1 },
      sourceEventSeqs: [call?.seq],
    });
    expect(document.events.at(-1)).toMatchObject({
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });
    expect(dshDocumentToSparkRecord(record.path, document).entries).toEqual(record.entries);
  });

  it("projects an unfinished tool-call repair once without a spark/record copy", async () => {
    const { store, record } = await fixture("unfinished-tool");
    record.entries = [
      message("u1", null, { role: "user", content: "inspect" }),
      message("a1", "u1", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-unfinished", name: "write", arguments: { value: 1 } },
        ],
      }),
    ];

    await store.save(record);
    const document = decodeSparkDshSessionJsonl(await readFile(record.path, "utf8"));
    expect(document).toBeDefined();
    if (!document) return;
    const repair = document.events.find(
      (event) =>
        event.type === "tool/result" &&
        (event.data as { error?: { code?: string } }).error?.code === TOOL_OUTCOME_UNKNOWN,
    );
    expect(repair).toMatchObject({
      data: { turn: 1, step: 1 },
      surfaceOp: "append",
    });
    expect(document.events.at(-1)).toMatchObject({
      type: "turn/end",
      data: { reason: { kind: "interrupted" } },
    });
    expect(document.events.filter((event) => event.type === "spark/record")).toHaveLength(0);
    const projected = dshDocumentToSparkRecord(record.path, document).entries;
    expect(projected.slice(0, 2)).toEqual(record.entries);
    expect(projected[2]).toMatchObject({
      type: "message",
      parentId: "a1",
      message: {
        role: "toolResult",
        toolCallId: "call-unfinished",
        toolName: "write",
        isError: true,
      },
    });
    expect(() =>
      Session.fromRestore(
        SessionId(record.header.id),
        structuredClone(document.events) as SessionEvent[],
        structuredClone(document.header),
      ),
    ).not.toThrow();
  });

  it("uses a DSH surface replacement for Spark compaction", async () => {
    const { store, record } = await fixture("compaction");
    record.entries = [
      message("u1", null, { role: "user", content: "old question" }),
      message("a1", "u1", { role: "assistant", content: "old answer" }),
      message("u2", "a1", { role: "user", content: "protected question" }),
      {
        type: "compaction",
        id: "c1",
        parentId: "u2",
        timestamp: "2026-08-20T00:00:04.000Z",
        summary: "old exchange summary",
        firstKeptEntryId: "u2",
        tokensBefore: 100,
      },
      message("a2", "c1", { role: "assistant", content: "new answer" }),
    ];

    await store.save(record);
    const document = decodeSparkDshSessionJsonl(await readFile(record.path, "utf8"));
    expect(document).toBeDefined();
    if (!document) return;
    const replacement = document.events.find(
      (event) => typeof event.surfaceOp === "object" && event.surfaceOp.op === "replace",
    );
    expect(replacement).toMatchObject({ type: "user/message" });
    expect(replacement?.sourceEventSeqs?.length).toBeGreaterThan(0);
    const session = Session.fromRestore(
      SessionId(record.header.id),
      structuredClone(document.events) as SessionEvent[],
      structuredClone(document.header),
    );
    const texts = session
      .deriveMessages()
      .map((value) =>
        value.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      );
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("old exchange summary");
    expect(texts[1]).toBe("protected question");
    expect(texts[2]).toBe("new answer");
  });

  it("moves inline image bytes into the official local attachment store", async () => {
    const { store, record } = await fixture("image");
    const imageData = (
      await readFile(
        new URL(
          "../../../spark-ui/catalog/__screenshots__/Catalog.browser.test.ts/catalog-attachments-light-desktop-chromium.png",
          import.meta.url,
        ),
      )
    ).toString("base64");
    record.entries = [
      message("u1", null, {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image",
            mimeType: "image/png",
            data: imageData,
          },
        ],
      }),
    ];

    await store.save(record);
    const document = decodeSparkDshSessionJsonl(await readFile(record.path, "utf8"));
    expect(document).toBeDefined();
    if (!document) return;
    const user = document.events.find((event) => event.type === "user/message");
    const image = (
      user?.data as { content?: Array<Record<string, unknown>> } | undefined
    )?.content?.find((block) => block.type === "image");
    const id = (image?.attachment as { attachmentId?: string } | undefined)?.attachmentId;
    expect(id).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const digest = id?.slice("sha256:".length) ?? "";
    await expect(
      access(join(store.attachmentRoot, "objects", digest.slice(0, 2), digest)),
    ).resolves.toBeUndefined();
    await expect(store.load(record.path)).resolves.toMatchObject({ entries: record.entries });
  });

  it("refuses an unknown required event and torn JSONL", async () => {
    const { store, record } = await fixture("invalid");
    record.entries = [message("u1", null, { role: "user", content: "hello" })];
    await store.save(record);
    const content = await readFile(record.path, "utf8");
    const document = decodeSparkDshSessionJsonl(content);
    expect(document).toBeDefined();
    if (!document) return;
    const unknown: SparkDshSessionEvent = {
      type: "future/required",
      seq: document.events.length,
      time: Date.now(),
      data: {},
    };
    expect(() =>
      dshDocumentToSparkRecord(record.path, { ...document, events: [...document.events, unknown] }),
    ).toThrow(/unknown required event/u);
    expect(decodeSparkDshSessionJsonl(`${content}{broken`)).toBeUndefined();
  });
});

async function fixture(
  label: string,
): Promise<{ store: SparkSessionStore; record: SparkSessionRecord }> {
  const root = await mkdtemp(join(tmpdir(), `spark-dsh-v4-${label}-`));
  roots.push(root);
  const store = new SparkSessionStore({
    cwd: join(root, "workspace"),
    sparkHome: join(root, "home"),
  });
  return {
    store,
    record: store.createCanonicalSession({
      id: `sess_${label}`,
      timestamp: "2026-08-20T00:00:00.000Z",
    }),
  };
}

function message(
  id: string,
  parentId: string | null,
  value: SparkSessionMessage,
): SparkSessionMessageEntry {
  return {
    type: "message" as const,
    id,
    parentId,
    timestamp: `2026-08-20T00:00:0${id.endsWith("2") ? "5" : "1"}.000Z`,
    message: value,
  };
}
