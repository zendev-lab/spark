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

describe("SparkSessionStore.save", () => {
  it("does not replace the transcript when cancellation wins before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-store-abort-"));
    roots.push(root);
    const store = new SparkSessionStore({
      cwd: join(root, "workspace"),
      sparkHome: join(root, "spark-home"),
    });
    const record = store.createCanonicalSession({
      id: "sess_abort",
      timestamp: "2026-08-12T00:00:00.000Z",
    });
    store.appendMessage(record, { role: "user", content: "committed" });
    await store.save(record);
    store.appendMessage(record, { role: "assistant", content: "must not commit" });
    const controller = new AbortController();
    const abortError = new Error("cancel before rename");
    controller.abort(abortError);
    let commitStarted = false;

    await expect(
      store.save(record, {
        signal: controller.signal,
        beforeCommit: () => {
          commitStarted = true;
        },
      }),
    ).rejects.toBe(abortError);

    expect(commitStarted).toBe(false);
    const persisted = await store.load(record.path);
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({
      type: "message",
      message: { content: "committed" },
    });
  });

  it("keeps the old transcript when cancellation wins inside the pre-rename hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-store-commit-abort-"));
    roots.push(root);
    const store = new SparkSessionStore({
      cwd: join(root, "workspace"),
      sparkHome: join(root, "spark-home"),
    });
    const record = store.createCanonicalSession({
      id: "sess_commit_abort",
      timestamp: "2026-08-12T00:00:00.000Z",
    });
    store.appendMessage(record, { role: "user", content: "committed" });
    await store.save(record);
    store.appendMessage(record, { role: "assistant", content: "must not commit" });
    const controller = new AbortController();
    const abortError = new Error("cancel at commit boundary");
    let commitHooks = 0;

    await expect(
      store.save(record, {
        signal: controller.signal,
        beforeCommit: () => {
          commitHooks += 1;
          controller.abort(abortError);
        },
      }),
    ).rejects.toBe(abortError);

    expect(commitHooks).toBe(1);
    const persisted = await store.load(record.path);
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({
      type: "message",
      message: { content: "committed" },
    });
  });
});
