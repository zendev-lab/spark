import { rm } from "node:fs/promises";
import { afterAll, beforeAll, bench, describe } from "vitest";

import {
  TAIL_MESSAGE_LIMIT,
  TRANSCRIPT_ENTRY_COUNT,
  createIndexedTranscript,
  runLoadSparkSessionSnapshotTail,
  runRefreshSparkSessionSnapshotIndex,
} from "./hot-paths-cases.ts";

describe("Spark session snapshot production paths", () => {
  let fixture: Awaited<ReturnType<typeof createIndexedTranscript>>;

  beforeAll(async () => {
    fixture = await createIndexedTranscript("sess_session_bench");
  });

  afterAll(async () => {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
  });

  bench(`refreshSparkSessionSnapshotIndex: ${TRANSCRIPT_ENTRY_COUNT} entries`, async () => {
    await runRefreshSparkSessionSnapshotIndex({
      sessionPath: fixture.transcriptPath,
      sessionId: fixture.session.sessionId,
    });
  });

  bench(`loadSparkSessionSnapshotTail: ${TRANSCRIPT_ENTRY_COUNT}→${TAIL_MESSAGE_LIMIT} index-hit`, async () => {
    await runLoadSparkSessionSnapshotTail({
      sessionsRoot: fixture.root,
      session: fixture.session,
    });
  });
});
