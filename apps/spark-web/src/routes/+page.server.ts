import { invokeSparkWebRpc } from "$lib/server/rpc";
import { isUnregisteredWorkspaceError, type SparkWebSession } from "$lib/daemon-surface";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const listed = await invokeSparkWebRpc("workspace.list", {});
  const sessions = (await invokeSparkWebRpc("session.list", {})) as SparkWebSession[];
  let cwdWorkspaceId: string | null = null;
  try {
    const cwd = await invokeSparkWebRpc("workspace.ensure-local", {
      localPath: process.cwd(),
    });
    cwdWorkspaceId = cwd.id;
  } catch (error) {
    if (!isUnregisteredWorkspaceError(error)) throw error;
  }
  return {
    workspaces: listed.workspaces,
    sessions,
    cwdWorkspaceId,
  };
};
