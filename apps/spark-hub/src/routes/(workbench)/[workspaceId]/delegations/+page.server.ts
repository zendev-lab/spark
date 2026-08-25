import { error } from "@sveltejs/kit";
import {
  listHubWorkspaceDelegations,
  listHubWorkspaceDelegationsForWorkspaceMember,
  listHubWorkspaceDelegationMessages,
  listHubWorkspaces,
  loadWorkspaceByRouteId,
} from "@zendev-lab/spark-hub-coordination";
import { getDatabase } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, params }) => {
  const db = getDatabase();
  const workspace = loadWorkspaceByRouteId(db, params.workspaceId);
  if (!workspace) throw error(404, "Workspace not found");
  const memberWorkspaceIds = locals.authorizedWorkspaceIds;
  if (memberWorkspaceIds && !memberWorkspaceIds.includes(workspace.id)) {
    throw error(404, "Workspace not found");
  }
  const delegations = memberWorkspaceIds
    ? listHubWorkspaceDelegationsForWorkspaceMember(db, workspace.id)
    : listHubWorkspaceDelegations(db, { workspaceId: workspace.id });
  const visibleWorkspaceIds = new Set(
    delegations.flatMap((delegation) => [
      delegation.request.sourceWorkspaceId,
      delegation.request.targetWorkspaceId,
    ]),
  );
  return {
    authorizedWorkspaceId: memberWorkspaceIds ? workspace.id : null,
    workspaces: memberWorkspaceIds
      ? listHubWorkspaces(db).filter((entry) => visibleWorkspaceIds.has(entry.id))
      : listHubWorkspaces(db),
    delegations,
    audits: memberWorkspaceIds
      ? {}
      : Object.fromEntries(
          delegations.map((delegation) => [
            delegation.request.delegationId,
            listHubWorkspaceDelegationMessages(db, delegation.request.delegationId),
          ]),
        ),
  };
};
