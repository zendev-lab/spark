import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SparkSessionStore } from "./store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SparkSessionStore.findAllById", () => {
  it("matches normalized ids and ignores internal transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-store-find-"));
    roots.push(root);
    const store = new SparkSessionStore({
      cwd: join(root, "workspace"),
      sparkHome: join(root, "spark-home"),
    });

    const canonical = store.createCanonicalSession({
      id: "sess_lookup",
      timestamp: "2026-07-20T00:00:00.000Z",
    });
    store.appendMessage(canonical, { role: "user", content: "canonical" });
    await store.save(canonical);

    const fragment = store.createSession({
      id: "sess_lookup",
      timestamp: "2026-07-21T00:00:00.000Z",
    });
    store.appendMessage(fragment, { role: "assistant", content: "fragment" });
    await store.save(fragment);

    const internal = store.createSession({
      id: "sess_lookup",
      timestamp: "2026-07-22T00:00:00.000Z",
      visibility: "internal",
    });
    await store.save(internal);

    await writeFile(join(store.sessionDir, "not-a-session.jsonl"), `${"x".repeat(1_000_000)}\n`);

    const records = await store.findAllById("session:sess_lookup");

    expect(records.map((record) => record.path).sort()).toEqual(
      [canonical.path, fragment.path].sort(),
    );
    expect(records.flatMap((record) => record.entries)).toEqual([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ content: "fragment" }),
      }),
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ content: "canonical" }),
      }),
    ]);
  });
});
