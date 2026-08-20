import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SPARK_DSH_ENTRY_EVENT_TYPE,
  SPARK_DSH_SESSION_FORMAT_VERSION,
  decodeSparkDshSessionJsonl,
  dshDocumentToSparkRecord,
} from "./dsh-format.ts";
import { migrateSparkSessionJsonlToDsh } from "./pi-v3-migration.ts";
import { SparkSessionStore } from "./store.ts";
import { CURRENT_SPARK_SESSION_VERSION } from "./types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi JSONL v3 to DSH session migration", () => {
  it("rewrites a Pi v3 file once and is a no-op on the DSH result", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-migrate-"));
    roots.push(root);
    const path = join(root, "legacy.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session",
          version: CURRENT_SPARK_SESSION_VERSION,
          id: "sess_legacy",
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-08-01T00:00:01.000Z",
          message: { role: "user", content: "legacy hello" },
        }),
        JSON.stringify({
          type: "compaction",
          id: "c1",
          parentId: "m1",
          timestamp: "2026-08-01T00:00:02.000Z",
          summary: "kept",
          firstKeptEntryId: "m1",
          tokensBefore: 12,
        }),
      ].join("\n") + "\n",
    );

    expect(await migrateSparkSessionJsonlToDsh(path)).toBe("migrated");
    expect(await migrateSparkSessionJsonlToDsh(path)).toBe("already-dsh");

    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      version: SPARK_DSH_SESSION_FORMAT_VERSION,
      id: "sess_legacy",
      cwd: "/workspace",
    });
    expect(lines[0]?.type).toBeUndefined();
    expect(lines.some((line) => line.type === SPARK_DSH_ENTRY_EVENT_TYPE)).toBe(true);

    const decoded = decodeSparkDshSessionJsonl(await readFile(path, "utf8"));
    expect(decoded).toBeDefined();
    if (!decoded) return;
    expect(dshDocumentToSparkRecord(path, decoded).entries).toEqual([
      expect.objectContaining({ type: "message", id: "m1" }),
      expect.objectContaining({ type: "compaction", id: "c1", summary: "kept" }),
    ]);

    const store = new SparkSessionStore({ cwd: "/workspace", sparkHome: join(root, "home") });
    const loaded = await store.load(path);
    expect(loaded.header.id).toBe("sess_legacy");
    expect(loaded.header.version).toBe(CURRENT_SPARK_SESSION_VERSION);
    expect(loaded.entries).toEqual([
      expect.objectContaining({ type: "message", id: "m1" }),
      expect.objectContaining({ type: "compaction", id: "c1", summary: "kept" }),
    ]);
  });

  it("round-trips a new transcript through DSH JSONL without a Pi header", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-dsh-save-"));
    roots.push(root);
    const store = new SparkSessionStore({
      cwd: join(root, "workspace"),
      sparkHome: join(root, "spark-home"),
    });
    const record = store.createCanonicalSession({
      id: "sess_new",
      timestamp: "2026-08-20T00:00:00.000Z",
    });
    store.appendMessage(record, { role: "user", content: "new hello" });
    await store.save(record);

    const first = JSON.parse((await readFile(record.path, "utf8")).split("\n")[0] ?? "{}") as {
      type?: string;
      version?: number;
    };
    expect(first.type).toBeUndefined();
    expect(first.version).toBe(SPARK_DSH_SESSION_FORMAT_VERSION);

    const loaded = await store.load(record.path);
    expect(loaded.header).toEqual(record.header);
    expect(loaded.entries).toEqual(record.entries);
  });
});
