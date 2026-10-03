import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const [catalog, daemon] = await Promise.all([
    invokeSparkWebRpc("model.catalog", {}),
    invokeSparkWebRpc("daemon.status", {}),
  ]);
  return { catalog, daemon };
};
