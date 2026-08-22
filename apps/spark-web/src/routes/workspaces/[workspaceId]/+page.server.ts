import { error } from "@sveltejs/kit";

import { invokeSparkWebRpc } from "$lib/server/rpc";
import { listSparkWebSessions } from "$lib/server/session-list";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const workspaceId = params.workspaceId;
  const listed = await invokeSparkWebRpc("workspace.list", {});
  const workspace = listed.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    error(404, "Workspace is not bound to this daemon");
  }
  const sessions = await listSparkWebSessions({
    scope: { kind: "workspace", workspaceId },
  });
  return { workspace, sessions };
};
