import { json } from "@sveltejs/kit";

import { getDatabase } from "$lib/server/db";
import { loadProjectedReproWorkbench } from "$lib/server/repro-workbench";
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

export const POST: RequestHandler = () =>
  json(
    { error: "workbench_read_only", message: "Repro v10 Workbench is a read-only projection." },
    { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
  );
