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
  if (locals.workspaceId && locals.workspaceId !== workspace.id) {
    throw error(404, "Workspace not found");
  }
  const delegations = locals.workspaceId
    ? listHubWorkspaceDelegationsForWorkspaceMember(db, workspace.id)
    : listHubWorkspaceDelegations(db, { workspaceId: workspace.id });
  const visibleWorkspaceIds = new Set(
    delegations.flatMap((delegation) => [
      delegation.request.sourceWorkspaceId,
      delegation.request.targetWorkspaceId,
    ]),
  );
  return {
    authorizedWorkspaceId: locals.workspaceId ?? null,
    workspaces: listHubWorkspaces(db).filter(
      (entry) => !locals.workspaceId || visibleWorkspaceIds.has(entry.id),
    ),
    delegations,
    audits: locals.workspaceId
      ? {}
      : Object.fromEntries(
          delegations.map((delegation) => [
            delegation.request.delegationId,
            listHubWorkspaceDelegationMessages(db, delegation.request.delegationId),
          ]),
        ),
  };
};
