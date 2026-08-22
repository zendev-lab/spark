import assert from "node:assert/strict";
import { test } from "vitest";

import { readSparkWebSessionMedia } from "./media.ts";

test("session media is reassembled only from contiguous owner chunks", async () => {
  const body = Buffer.from("native image bytes");
  const calls: number[] = [];
  const media = await readSparkWebSessionMedia(
    { sessionId: "sess_1", messageId: "msg_1", contentIndex: 2 },
    async (request) => {
      calls.push(request.offset);
      const end = Math.min(body.length, request.offset + 7);
      return {
        sessionId: request.sessionId,
        messageId: request.messageId,
        contentIndex: request.contentIndex,
        mediaType: "image/png",
        name: "result.png",
        offset: request.offset,
        sizeBytes: body.length,
        data: body.subarray(request.offset, end).toString("base64"),
        ...(end < body.length ? { nextOffset: end } : {}),
        complete: end === body.length,
      };
    },
  );
  assert.deepEqual(calls, [0, 7, 14]);
  assert.equal(Buffer.from(media.body).toString(), body.toString());
  assert.equal(media.mediaType, "image/png");
  assert.equal(media.name, "result.png");
});

test("session media rejects a cursor gap", async () => {
  await assert.rejects(
    () =>
      readSparkWebSessionMedia(
        { sessionId: "sess_1", messageId: "msg_1", contentIndex: 0 },
        async (request) => ({
          sessionId: request.sessionId,
          messageId: request.messageId,
          contentIndex: request.contentIndex,
          mediaType: "image/png",
          offset: request.offset,
          sizeBytes: 2,
          data: Buffer.from("a").toString("base64"),
          nextOffset: 2,
          complete: false,
        }),
      ),
    /cursor did not advance contiguously/u,
  );
});
