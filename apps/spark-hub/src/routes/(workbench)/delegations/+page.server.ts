import {
  listHubWorkspaceDelegations,
  listHubWorkspaceDelegationsForWorkspaceMember,
  listHubWorkspaceDelegationMessages,
  listHubWorkspaces,
} from "@zendev-lab/spark-hub-coordination";
import { getDatabase } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
  const db = getDatabase();
  const authorizedWorkspaceId = locals.workspaceId ?? null;
  const delegations = authorizedWorkspaceId
    ? listHubWorkspaceDelegationsForWorkspaceMember(db, authorizedWorkspaceId)
    : listHubWorkspaceDelegations(db);
  const visibleWorkspaceIds = new Set(
    delegations.flatMap((delegation) => [
      delegation.request.sourceWorkspaceId,
      delegation.request.targetWorkspaceId,
    ]),
  );
  return {
    authorizedWorkspaceId,
    workspaces: listHubWorkspaces(db).filter(
      (workspace) => !authorizedWorkspaceId || visibleWorkspaceIds.has(workspace.id),
    ),
    delegations,
    audits: authorizedWorkspaceId
      ? {}
      : Object.fromEntries(
          delegations.map((delegation) => [
            delegation.request.delegationId,
            listHubWorkspaceDelegationMessages(db, delegation.request.delegationId),
          ]),
        ),
  };
};
