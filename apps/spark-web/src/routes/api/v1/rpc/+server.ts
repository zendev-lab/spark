import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import {
  invokeSparkWebRpc,
  projectSparkWebRpcRemoteError,
  SparkWebRpcForbiddenError,
} from "$lib/server/rpc";

const invalidRequest = (message: string) =>
  json({ code: "invalid_request", message }, { status: 400 });

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch (caught) {
    if (caught instanceof SyntaxError) return invalidRequest("Request body must be valid JSON");
    throw caught;
  }

  if (body === null || typeof body !== "object" || !("method" in body)) {
    return invalidRequest("RPC method is required");
  }
  const { method, input } = body as { method?: unknown; input?: unknown };
  if (typeof method !== "string") {
    return invalidRequest("RPC method is required");
  }

  try {
    const output = await invokeSparkWebRpc(method, input ?? {});
    return json({ output });
  } catch (caught) {
    if (caught instanceof SparkWebRpcForbiddenError) {
      return json({ code: "forbidden", message: caught.message }, { status: 403 });
    }
    const projected = projectSparkWebRpcRemoteError(method, caught);
    if (projected) {
      return json(
        { code: projected.code, message: projected.message },
        { status: projected.status },
      );
    }
    throw caught;
  }
};
