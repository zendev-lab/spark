import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const sessionId = params.sessionId;
  const [window, catalog] = await Promise.all([
    invokeSparkWebRpc("session.snapshot-page", { sessionId, messageLimit: 32 }),
    invokeSparkWebRpc("model.catalog", {}),
  ]);
  return { window, catalog };
};
