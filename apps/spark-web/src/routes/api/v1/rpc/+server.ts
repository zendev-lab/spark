import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { invokeSparkWebRpc, SparkWebRpcForbiddenError } from "$lib/server/rpc";

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch (caught) {
    // A client disconnect while uploading a body is a failed request, not a
    // daemon error. Keep this catch scoped to reading, before any RPC effects.
    if (
      request.signal.aborted ||
      (caught instanceof Error &&
        (caught.name === "AbortError" || ("code" in caught && caught.code === "ECONNRESET")))
    ) {
      return new Response(null, { status: 499 });
    }
    if (caught instanceof SyntaxError) error(400, "RPC body must be valid JSON");
    throw caught;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    error(400, "RPC body must be an object");
  }
  const input = body as { method?: unknown; input?: unknown };
  if (typeof input.method !== "string") {
    error(400, "RPC method is required");
  }
  try {
    const output = await invokeSparkWebRpc(input.method, input.input ?? {});
    return json({ output });
  } catch (caught) {
    if (caught instanceof SparkWebRpcForbiddenError) {
      error(403, caught.message);
    }
    throw caught;
  }
};
