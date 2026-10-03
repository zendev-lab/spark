import { invokeSparkWebRpc } from "$lib/server/rpc";
import { listSparkWebSessions } from "$lib/server/session-list";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const listed = await invokeSparkWebRpc("workspace.list", {});
  const sessions = await listSparkWebSessions();
  return { workspaces: listed.workspaces, sessions };
};
