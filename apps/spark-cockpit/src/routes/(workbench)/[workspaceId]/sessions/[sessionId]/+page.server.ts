import { loadCanonicalWorkspaceRoute } from "$lib/server/canonical-workspace-route";
import { loadSessionPage } from "$lib/server/session-detail-route";
import { actions as sessionActions } from "$lib/server/session-page-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) =>
  await loadCanonicalWorkspaceRoute(event, loadSessionPage);

export const actions: Actions = sessionActions;
