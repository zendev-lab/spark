import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  TAIL_MESSAGE_LIMIT,
  TRANSCRIPT_ENTRY_COUNT,
  createIndexedTranscript,
  runLoadSparkSessionSnapshotTail,
} from "../benchmarks/session/hot-paths-cases.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session snapshot benchmark correctness", () => {
  it("refreshes an index covering every transcript entry", async () => {
    const fixture = await createIndexedTranscript("sess_bench_refresh");
    roots.push(fixture.root);
    expect(fixture.refreshed.messageCount).toBe(TRANSCRIPT_ENTRY_COUNT);
  });

  it("loads only the indexed tail on a 10k transcript", async () => {
    const fixture = await createIndexedTranscript("sess_bench_tail");
    roots.push(fixture.root);
    const tail = await runLoadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
    });
    expect(tail.totalMessages).toBe(TRANSCRIPT_ENTRY_COUNT);
    expect(tail.snapshot.messages).toHaveLength(TAIL_MESSAGE_LIMIT);
    expect(tail.snapshot.messages[0]?.id).toBe("message-9968");
    expect(tail.snapshot.messages.at(-1)?.id).toBe("message-9999");
    expect(tail.read).toMatchObject({
      indexStatus: "hit",
      fullTranscriptRead: false,
    });
  });
});
