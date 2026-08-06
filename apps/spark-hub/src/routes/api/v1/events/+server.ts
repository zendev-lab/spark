import { createHubEventStreamResponse } from "$lib/server/events-sse";
import { createLivenessSweepScheduler } from "@zendev-lab/spark-hub-coordination/liveness";
import type { RequestHandler } from "@sveltejs/kit";

const sweepLivenessIfDue = createLivenessSweepScheduler();

export const GET: RequestHandler = ({ locals, request, url }) => {
  return createHubEventStreamResponse({
    request,
    url,
    sweepLivenessIfDue,
    workspaceId: locals.workspaceId,
  });
};
