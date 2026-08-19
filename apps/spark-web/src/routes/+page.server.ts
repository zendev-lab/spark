import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const workspace = await invokeSparkWebRpc("workspace.ensure-local", {
    localPath: process.cwd(),
  });
  const sessions = await invokeSparkWebRpc("session.list", {
    scope: { kind: "workspace", workspaceId: workspace.id },
  });
  return { sessions, workspaceId: workspace.id };
};
