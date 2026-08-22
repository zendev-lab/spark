import { error } from "@sveltejs/kit";

import { readSparkWebLocalShare } from "$lib/server/local-share";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const share = readSparkWebLocalShare(params.token);
  if (!share) error(404, "Local Share is unavailable in this Spark Web process.");
  return new Response(share.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
};
