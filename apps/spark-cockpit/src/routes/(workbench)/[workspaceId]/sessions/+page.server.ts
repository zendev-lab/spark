import { loadCanonicalWorkspaceRoute } from "$lib/server/canonical-workspace-route";
import { actions as sessionActions, loadSessionsPage } from "$lib/server/session-page-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) =>
  await loadCanonicalWorkspaceRoute(event, loadSessionsPage);

export const actions: Actions = sessionActions;
