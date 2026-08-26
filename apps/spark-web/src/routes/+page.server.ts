import { invokeSparkWebRpc } from "$lib/server/rpc";
import { isUnregisteredWorkspaceError } from "$lib/daemon-surface";
import { loadSparkWebDashboard } from "$lib/server/dashboard";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const dashboard = await loadSparkWebDashboard();
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
    ...dashboard,
    cwdWorkspaceId,
    launchCwd,
  };
};
