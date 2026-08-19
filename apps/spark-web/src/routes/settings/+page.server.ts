import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const catalog = await invokeSparkWebRpc("model.catalog", {});
  return { catalog };
};
