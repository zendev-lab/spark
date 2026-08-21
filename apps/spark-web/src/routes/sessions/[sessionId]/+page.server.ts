import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const sessionId = params.sessionId;
  const [window, catalog, sessions] = await Promise.all([
    invokeSparkWebRpc("session.snapshot-page", { sessionId, messageLimit: 32 }),
    invokeSparkWebRpc("model.catalog", {}),
    invokeSparkWebRpc("session.list", { includeArchived: true, limit: 100 }),
  ]);
  return { window, catalog, sessions };
};
