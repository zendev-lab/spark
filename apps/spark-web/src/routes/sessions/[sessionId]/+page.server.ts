import { invokeSparkWebRpc } from "$lib/server/rpc";
import { listSparkWebSessions } from "$lib/server/session-list";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const sessionId = params.sessionId;
  const [window, catalog, sessions] = await Promise.all([
    invokeSparkWebRpc("session.snapshot-page", { sessionId, messageLimit: 32 }),
    invokeSparkWebRpc("model.catalog", {}),
    listSparkWebSessions({ includeArchived: true }),
  ]);
  return { window, catalog, sessions };
};
