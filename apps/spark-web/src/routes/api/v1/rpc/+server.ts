import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { invokeSparkWebRpc, SparkWebRpcForbiddenError } from "$lib/server/rpc";

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as { method?: unknown; input?: unknown };
  if (typeof body.method !== "string") {
    error(400, "RPC method is required");
  }
  try {
    const output = await invokeSparkWebRpc(body.method, body.input ?? {});
    return json({ output });
  } catch (caught) {
    if (caught instanceof SparkWebRpcForbiddenError) {
      error(403, caught.message);
    }
    throw caught;
  }
};
