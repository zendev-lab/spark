import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { readSparkWebSessionMedia } from "$lib/server/media";

export const GET: RequestHandler = async ({ params }) => {
  if (!/^\d+$/u.test(params.contentIndex)) error(400, "Invalid media content index");
  const media = await readSparkWebSessionMedia({
    sessionId: params.sessionId,
    messageId: params.messageId,
    contentIndex: Number(params.contentIndex),
  });
  return new Response(media.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(media.body.byteLength),
      "content-type": media.mediaType,
      "x-content-type-options": "nosniff",
    },
  });
};
