import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { WebFetchProvider, WebSearchProvider } from "@deepseek-ai/dsh-web";
import z from "@deepseek-ai/schemastery";

import {
  createBraveWebSearchProvider,
  createLocalWebFetchProvider,
  type DshWebContentExtractor,
} from "./content.ts";

export const name = "dsh-web-provider";
export const inject = ["web"];

export interface Config {
  extractor?: DshWebContentExtractor;
  jinaBaseUrl?: string;
  allowPrivateHosts?: boolean;
  braveApiKey?: string;
  registerBraveSearch?: boolean;
  registerLocalFetch?: boolean;
  /** Programmatic `ctx.web` provider injection for hosts and tests. */
  searchProviders?: WebSearchProvider[];
  /** Programmatic `ctx.web` provider injection for hosts and tests. */
  fetchProviders?: WebFetchProvider[];
  fetcher?: typeof fetch;
}

export const Config = z.object({
  extractor: z.string(),
  jinaBaseUrl: z.string(),
  allowPrivateHosts: z.boolean().default(false),
  braveApiKey: z.string(),
  registerBraveSearch: z.boolean().default(true),
  registerLocalFetch: z.boolean().default(true),
}) as unknown as NonNullable<Plugin.Object<Config>["Config"]>;

export function apply(ctx: Context, config: Config = {}): void {
  if (config.registerBraveSearch !== false) {
    ctx.web.registerSearchProvider(
      createBraveWebSearchProvider({
        apiKey: config.braveApiKey,
        fetcher: config.fetcher,
      }),
    );
  }
  for (const provider of config.searchProviders ?? []) {
    ctx.web.registerSearchProvider(provider);
  }
  if (config.registerLocalFetch !== false) {
    ctx.web.registerFetchProvider(
      createLocalWebFetchProvider({
        fetcher: config.fetcher,
        extractor: config.extractor,
        jinaBaseUrl: config.jinaBaseUrl,
        allowPrivateHosts: config.allowPrivateHosts,
      }),
    );
  }
  for (const provider of config.fetchProviders ?? []) {
    ctx.web.registerFetchProvider(provider);
  }
}

export const plugin: Plugin.Object<Config> = { name, inject, Config, apply };

export default plugin;
