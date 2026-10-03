import { invokeSparkWebRpc } from "$lib/server/rpc";
import { isUnregisteredWorkspaceError } from "$lib/daemon-surface";
import { loadSparkWebDashboard } from "$lib/server/dashboard";
import { sparkWebLaunchDirectory } from "$lib/server/launch-directory";
import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url }) => {
  const dashboard = await loadSparkWebDashboard();
  const requestedWorkspaceId = url.searchParams.get("workspace");
  if (
    requestedWorkspaceId &&
    !dashboard.workspaces.some((workspace) => workspace.id === requestedWorkspaceId)
  )
    error(404, "Workspace not found");
  const launchCwd = sparkWebLaunchDirectory();
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
    requestedWorkspaceId,
    setupWorkspace: url.searchParams.get("setup") === "workspace",
    launchCwd,
  };
};
