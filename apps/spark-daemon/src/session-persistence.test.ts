import { Context } from "@deepseek-ai/cordis";
import SessionStore, {
  SessionId,
  SessionSeq,
  SESSION_FORMAT_VERSION,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import {
  SessionAlreadyOwnedError,
  SessionReadOnlyError,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SparkJsonlSessionFiles,
  SparkSessionStore,
  decodeSparkDshSessionJsonl,
  dshDocumentToSparkRecord,
} from "@zendev-lab/spark-session/transcript";
import { mkdtemp, rm, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createSparkDaemonSessionPersistencePlugin } from "./session-persistence.ts";

async function openBackend(root: string) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(createSparkDaemonSessionPersistencePlugin(root));
  return ctx;
}

test("write ownership excludes another backend, readers see commits, and close drains live events", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-handles-"));
  const ctx = await openBackend(root);
  const other = await openBackend(root);
  const id = SessionId("handles");
  const header: SessionHeader = {
    id,
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    createdAt: 1,
    cwd: root,
  };
  try {
    const writer = await ctx.sessionPersistence.create(header);
    const session = ctx.sessions.create(id, { meta: { cwd: root } });
    session.append("spark/meta", { sparkVersion: 5, timestamp: new Date(1).toISOString() });
    await writer.flush();
    expect(await other.sessionPersistence.stat(id)).toMatchObject({ header });
    expect(await other.sessionPersistence.list()).toEqual([
      await other.sessionPersistence.stat(id),
    ]);
    await expect(other.sessionPersistence.open(id, "write")).rejects.toBeInstanceOf(
      SessionAlreadyOwnedError,
    );
    const reader = await other.sessionPersistence.open(id, "read");
    await expect(reader.append([])).rejects.toBeInstanceOf(SessionReadOnlyError);
    expect((await reader.read()).events).toHaveLength(1);
    session.append("turn/start", { turn: 1 });
    const closing = writer.close();
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await ctx.sessionPersistence.flush();
    await closing;
    expect((await reader.read()).events.map((event) => event.type)).toEqual([
      "spark/meta",
      "turn/start",
      "turn/end",
    ]);
    await reader.close();
    const successor = await other.sessionPersistence.open(id, "write");
    await successor.close();
  } finally {
    await ctx.fiber.dispose();
    await other.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("write-open repairs a UTF-8 torn tail before appending and keeps complete records", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-torn-"));
  const ctx = await openBackend(root);
  const files = new SparkJsonlSessionFiles(root);
  const id = SessionId("torn");
  const header: SessionHeader = {
    id,
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    createdAt: 1,
    cwd: root,
  };
  try {
    const writer = await ctx.sessionPersistence.create(header);
    await writer.append([
      {
        type: "spark/meta",
        seq: SessionSeq(0),
        time: 1,
        data: { sparkVersion: 5, timestamp: "中文" },
      },
    ]);
    await writer.close();
    const path = files.canonicalPath(header);
    await appendFile(path, '{"type":"turn/start","seq":1');
    const repair = await ctx.sessionPersistence.open(id, "write");
    expect((await repair.read()).events).toHaveLength(1);
    await repair.append([{ type: "turn/start", seq: SessionSeq(1), time: 2, data: { turn: 1 } }]);
    await repair.flush();
    await repair.close();
    const content = await readFile(path, "utf8");
    expect(
      content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map((value) => value.type),
    ).toEqual([undefined, "spark/meta", "turn/start"]);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "fork identity survives persistence and refuses projection rewrites (nonempty: %s)",
  async (nonempty) => {
    const root = await mkdtemp(join(tmpdir(), "spark-fork-identity-"));
    const ctx = await openBackend(root);
    const files = new SparkJsonlSessionFiles(root);
    const meta = { sparkVersion: 5, timestamp: new Date(1).toISOString() };
    try {
      const parent = ctx.sessions.create(SessionId("parent"), { meta: { cwd: root } });
      if (nonempty) parent.append("spark/meta", meta);
      const child = ctx.sessions.fork(parent, undefined, SessionId("child"));
      if (!nonempty) child.append("spark/meta", meta);
      const inheritedEventCount = child.inheritedEventCount;
      expect(inheritedEventCount).toBe(nonempty ? 1 : 0);
      const writer = await ctx.sessionPersistence.create(child.header, { inheritedEventCount });
      await writer.append(child.snapshotEvents());
      await writer.close();
      const reader = await ctx.sessionPersistence.open(child.id, "read");
      expect(reader.header.isSeeded).toBe(true);
      expect(reader.inheritedEventCount).toBe(inheritedEventCount);
      await reader.close();

      const path = files.canonicalPath(child.header);
      const content = await readFile(path, "utf8");
      const document = decodeSparkDshSessionJsonl(content)!;
      const record = dshDocumentToSparkRecord(path, document);
      expect(record.header.seedLength).toBe(inheritedEventCount);
      const store = new SparkSessionStore({ cwd: root, sparkHome: root });
      await expect(store.save(record)).rejects.toThrow(/fork-inherited event prefix/);
      expect(await readFile(path, "utf8")).toBe(content);
    } finally {
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
