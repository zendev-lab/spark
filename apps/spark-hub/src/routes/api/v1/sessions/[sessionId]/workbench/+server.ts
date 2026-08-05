import { json } from "@sveltejs/kit";
import { RuntimeControlCommandError } from "@zendev-lab/spark-hub-coordination/runtime-control";

import { getDatabase } from "$lib/server/db";
import {
  controlReproWorkbenchForHub,
  loadProjectedReproWorkbench,
  ReproWorkbenchControlError,
} from "$lib/server/repro-workbench";
import { HubRuntimeSessionUnavailableError } from "$lib/server/hub-runtime-session-client";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const projection = loadProjectedReproWorkbench(getDatabase(), params.sessionId);
  if (projection.status === "absent") {
    return json({ error: "workbench_not_found" }, { status: 404 });
  }
  return json(projection, {
    status: projection.status === "pending" ? 202 : 200,
    headers: { "cache-control": "no-store" },
  });
};

export const POST: RequestHandler = async ({ params, request }) => {
  const action: unknown = await request.json().catch(() => null);
  try {
    const result = await controlReproWorkbenchForHub({
      db: getDatabase(),
      sessionId: params.sessionId,
      action,
    });
    return json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ReproWorkbenchControlError) {
      return json(
        { error: error.code, message: error.message },
        { status: error.code === "workbench_not_found" ? 404 : 409 },
      );
    }
    if (error instanceof HubRuntimeSessionUnavailableError) {
      return json(
        { error: "workbench_control_unavailable", message: error.message },
        { status: 503 },
      );
    }
    if (error instanceof RuntimeControlCommandError) {
      const stale =
        error.reasonCode === "workbench_action_stale" ||
        error.reasonCode === "workbench_action_conflict";
      const untrusted =
        error.reasonCode === "workbench_action_untrusted" ||
        error.reasonCode === "workbench_binding_not_found";
      return json(
        { error: error.reasonCode, message: error.message },
        { status: stale ? 409 : untrusted ? 403 : 500 },
      );
    }
    return json({ error: "invalid_workbench_action" }, { status: 400 });
  }
};
