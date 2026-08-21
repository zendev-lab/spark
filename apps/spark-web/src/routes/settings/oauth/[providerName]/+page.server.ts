import { error } from "@sveltejs/kit";
import { lookupOAuthSettingsProvider } from "$lib/provider-auth";
import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params }) => {
  const catalog = await invokeSparkWebRpc("model.catalog", {});
  const looked = lookupOAuthSettingsProvider(catalog.providers, params.providerName);
  if (!looked.ok) error(looked.status, looked.message);
  return { provider: looked.provider };
};
