import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const sessionId = params.sessionId;
  const [snapshot, catalog] = await Promise.all([
    invokeSparkWebRpc("session.snapshot", { sessionId }),
    invokeSparkWebRpc("model.catalog", {}),
  ]);
  return { snapshot, catalog };
};
