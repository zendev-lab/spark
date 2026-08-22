import { error, json } from "@sveltejs/kit";

import { createSparkWebLocalShare, SparkWebLocalShareLimitError } from "$lib/server/local-share";
import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params }) => {
  try {
    const share = await createSparkWebLocalShare(params.sessionId, invokeSparkWebRpc);
    return json({ ...share, href: `/share/${share.token}` }, { status: 201 });
  } catch (caught) {
    if (caught instanceof SparkWebLocalShareLimitError) error(429, caught.message);
    throw caught;
  }
};
