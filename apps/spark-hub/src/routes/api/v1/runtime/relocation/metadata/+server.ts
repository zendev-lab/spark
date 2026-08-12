import {
  hubRuntimeRelocationMetadataSchema,
  runtimeProtocolVersion,
} from "@zendev-lab/spark-protocol/runtime";
import { json, type RequestHandler } from "@sveltejs/kit";
import { errorJson } from "$lib/server/json";
import { hubRuntimeRelocationInstanceId } from "$lib/server/runtime-relocation";

export const GET: RequestHandler = ({ locals }) => {
  const instanceId = hubRuntimeRelocationInstanceId();
  if (!instanceId) {
    return errorJson(
      "hub_instance_unavailable",
      "Hub instance identity is unavailable.",
      503,
      undefined,
      locals.requestId,
    );
  }
  return json(
    hubRuntimeRelocationMetadataSchema.parse({
      instanceId,
      protocolVersion: runtimeProtocolVersion,
    }),
  );
};
