import { rm } from "node:fs/promises";
import { test } from "vitest";

import {
  TAIL_MESSAGE_LIMIT,
  TRANSCRIPT_ENTRY_COUNT,
  createIndexedTranscript,
  runLoadSparkSessionSnapshotTail,
  runRefreshSparkSessionSnapshotIndex,
} from "./hot-paths-cases.ts";

test("Spark session snapshot production paths", async ({ bench }) => {
  const refreshFixture = await createIndexedTranscript("sess_session_refresh_bench");
  try {
    await bench(`refreshSparkSessionSnapshotIndex: ${TRANSCRIPT_ENTRY_COUNT} entries`, async () => {
      await runRefreshSparkSessionSnapshotIndex({
        sessionPath: refreshFixture.transcriptPath,
        sessionId: refreshFixture.session.sessionId,
      });
    }).run();
  } finally {
    await rm(refreshFixture.root, { recursive: true, force: true });
  }

  const loadFixture = await createIndexedTranscript("sess_session_load_bench");
  try {
    await bench(`loadSparkSessionSnapshotTail: ${TRANSCRIPT_ENTRY_COUNT}→${TAIL_MESSAGE_LIMIT} index-hit`, async () => {
      await runLoadSparkSessionSnapshotTail({
        sessionsRoot: loadFixture.root,
        session: loadFixture.session,
      });
    }).run();
  } finally {
    await rm(loadFixture.root, { recursive: true, force: true });
  }
});
