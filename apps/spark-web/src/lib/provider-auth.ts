import type {
  SparkAuthFlow,
  SparkAuthFlowStatus,
  SparkModelCatalogProvider,
} from "@zendev-lab/spark-protocol";

export function isTerminalAuthFlow(status: SparkAuthFlowStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function oauthHref(providerName: string): string {
  return `/settings/oauth/${encodeURIComponent(providerName)}`;
}

export function providerAuthKindLabel(kind: SparkModelCatalogProvider["auth"]["kind"]): string {
  if (kind === "api_key") return "API key";
  if (kind === "oauth") return "OAuth";
  return "None";
}

export function providerAuthStatusLabel(provider: SparkModelCatalogProvider): string {
  if (provider.auth.kind === "none") return "No login needed";
  return provider.auth.configured ? "Connected" : "Not connected";
}

export function authFlowStatusLabel(status: SparkAuthFlowStatus): string {
  if (status === "waiting_for_user") return "Waiting for you";
  if (status === "succeeded") return "Signed in";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Starting";
}

export function latestAuthProgress(flow: SparkAuthFlow): string | undefined {
  return flow.progress.at(-1);
}

export type OAuthSettingsProviderLookup =
  | { ok: true; provider: SparkModelCatalogProvider }
  | { ok: false; status: 400 | 404; message: string };

export function lookupOAuthSettingsProvider(
  providers: readonly SparkModelCatalogProvider[],
  providerName: string,
): OAuthSettingsProviderLookup {
  const provider = providers.find((entry) => entry.providerName === providerName);
  if (!provider) {
    return {
      ok: false,
      status: 404,
      message: `Unknown Spark provider ${providerName}`,
    };
  }
  if (provider.auth.kind !== "oauth") {
    return {
      ok: false,
      status: 400,
      message: `${provider.label} does not use OAuth. Configure it from Settings.`,
    };
  }
  return { ok: true, provider };
}
