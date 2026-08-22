import { invokeSparkWebRpc } from "$lib/server/rpc";
import { isUnregisteredWorkspaceError } from "$lib/daemon-surface";
import { listSparkWebSessions } from "$lib/server/session-list";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const listed = await invokeSparkWebRpc("workspace.list", {});
  const sessions = await listSparkWebSessions();
  const launchCwd = process.cwd();
  let cwdWorkspaceId: string | null = null;
  try {
    const cwd = await invokeSparkWebRpc("workspace.ensure-local", {
      localPath: launchCwd,
    });
    cwdWorkspaceId = cwd.id;
  } catch (error) {
    if (!isUnregisteredWorkspaceError(error)) throw error;
  }
  return {
    workspaces: listed.workspaces,
    sessions,
    cwdWorkspaceId,
    launchCwd,
  };
};
