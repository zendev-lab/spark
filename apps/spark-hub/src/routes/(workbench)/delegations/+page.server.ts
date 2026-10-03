import {
  listHubWorkspaceDelegations,
  listHubWorkspaceDelegationMessages,
  listHubWorkspaces,
} from "@zendev-lab/spark-hub-coordination";
import { getDatabase } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

// The global delegations ledger is a control-plane surface: remote member
// sessions are rejected by the request hook before this load runs.
export const load: PageServerLoad = () => {
  const db = getDatabase();
  const delegations = listHubWorkspaceDelegations(db);
  return {
    authorizedWorkspaceId: null,
    workspaces: listHubWorkspaces(db),
    delegations,
    audits: Object.fromEntries(
      delegations.map((delegation) => [
        delegation.request.delegationId,
        listHubWorkspaceDelegationMessages(db, delegation.request.delegationId),
      ]),
    ),
  };
};
