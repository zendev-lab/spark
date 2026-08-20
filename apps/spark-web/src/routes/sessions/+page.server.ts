import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { SparkWebSession } from "$lib/daemon-surface";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const listed = await invokeSparkWebRpc("workspace.list", {});
  const sessions = (await invokeSparkWebRpc("session.list", {})) as SparkWebSession[];
  return { workspaces: listed.workspaces, sessions };
};
