import { loadSparkWebInvocationView } from "$lib/server/invocation-view";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => ({
  view: await loadSparkWebInvocationView(params.invocationId),
});
