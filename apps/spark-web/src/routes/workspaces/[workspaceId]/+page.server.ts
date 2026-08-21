import { error } from "@sveltejs/kit";

import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { SparkWebSession } from "$lib/daemon-surface";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const workspaceId = params.workspaceId;
  const listed = await invokeSparkWebRpc("workspace.list", {});
  const workspace = listed.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    error(404, "Workspace is not bound to this daemon");
  }
  const [sessions, artifactCatalog, roleCatalog, roleModelSettings, skillCatalog, modelCatalog] =
    await Promise.all([
      invokeSparkWebRpc("session.list", {
        scope: { kind: "workspace", workspaceId },
      }) as Promise<SparkWebSession[]>,
      invokeSparkWebRpc("artifact.list", { workspaceId, limit: 100 }),
      invokeSparkWebRpc("role.list", { workspaceId }),
      invokeSparkWebRpc("role.model.list", { workspaceId }),
      invokeSparkWebRpc("skill.list", { workspaceId }),
      invokeSparkWebRpc("model.catalog", {}),
    ]);
  return {
    workspace,
    sessions,
    artifactCatalog,
    roleCatalog,
    roleModelSettings,
    skillCatalog,
    modelCatalog,
  };
};
