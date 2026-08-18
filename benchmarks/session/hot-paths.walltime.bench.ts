import { rm } from "node:fs/promises";
import { bench, describe } from "vitest";

import {
  TAIL_MESSAGE_LIMIT,
  TRANSCRIPT_ENTRY_COUNT,
  createIndexedTranscript,
  runLoadSparkSessionSnapshotTail,
  runRefreshSparkSessionSnapshotIndex,
} from "./hot-paths-cases.ts";

describe("Spark session snapshot production paths", () => {
  let refreshFixture: Awaited<ReturnType<typeof createIndexedTranscript>> | undefined;
  let loadFixture: Awaited<ReturnType<typeof createIndexedTranscript>> | undefined;

  bench(
    `refreshSparkSessionSnapshotIndex: ${TRANSCRIPT_ENTRY_COUNT} entries`,
    async () => {
      await runRefreshSparkSessionSnapshotIndex({
        sessionPath: refreshFixture!.transcriptPath,
        sessionId: refreshFixture!.session.sessionId,
      });
    },
    {
      setup: async () => {
        refreshFixture = await createIndexedTranscript("sess_session_refresh_bench");
      },
      teardown: async () => {
        if (refreshFixture) await rm(refreshFixture.root, { recursive: true, force: true });
        refreshFixture = undefined;
      },
    },
  );

  bench(
    `loadSparkSessionSnapshotTail: ${TRANSCRIPT_ENTRY_COUNT}→${TAIL_MESSAGE_LIMIT} index-hit`,
    async () => {
      await runLoadSparkSessionSnapshotTail({
        sessionsRoot: loadFixture!.root,
        session: loadFixture!.session,
      });
    },
    {
      setup: async () => {
        loadFixture = await createIndexedTranscript("sess_session_load_bench");
      },
      teardown: async () => {
        if (loadFixture) await rm(loadFixture.root, { recursive: true, force: true });
        loadFixture = undefined;
      },
    },
  );
});
