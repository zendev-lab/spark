import { error, redirect } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { getProjectedManagedSessionForCockpit } from "$lib/server/managed-sessions";
import { loadWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import { workspaceSessionPath } from "$lib/workspace-routes";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params, url }) => {
  const session = getProjectedManagedSessionForCockpit(params.sessionId);
  const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
  if (!session || !workspaceId || session.status === "archived") {
    throw error(404, "Session not found");
  }
  const workspace = loadWorkspaceByRouteId(getDatabase(), workspaceId);
  if (!workspace) throw error(404, "Session not found");
  redirect(303, `${workspaceSessionPath(workspace, session.sessionId)}${url.search}`);
};
