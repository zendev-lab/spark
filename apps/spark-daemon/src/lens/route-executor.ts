import type {
  CapabilityRoute,
  ProviderId,
  ProviderRequest,
  ProviderResult,
} from "@zendev-lab/spark-lens";

import type { DaemonLensRuntime } from "./runtime.ts";

export interface LensRouteExecution {
  route: CapabilityRoute;
  results: readonly ProviderResult[];
  selectedProviderId?: ProviderId;
}

export class DaemonLensRouteExecutor {
  readonly #runtime: DaemonLensRuntime;

  constructor(runtime: DaemonLensRuntime) {
    this.#runtime = runtime;
  }

  async execute(input: {
    requestId: string;
    route: CapabilityRoute;
    request: ProviderRequest;
    timeoutMs: number;
  }): Promise<LensRouteExecution> {
    if (input.route.capability !== input.request.capability) {
      throw new Error(
        `Lens route capability ${input.route.capability} does not match request ${input.request.capability}`,
      );
    }
    switch (input.route.kind) {
      case "exclusive": {
        const result = await this.#run(input, input.route.owner, 0);
        return {
          route: input.route,
          results: [result],
          ...(result.status === "ok" ? { selectedProviderId: input.route.owner } : {}),
        };
      }
      case "fallback": {
        const providers = [input.route.owner, ...input.route.fallbacks];
        const results: ProviderResult[] = [];
        for (const [index, providerId] of providers.entries()) {
          const result = await this.#run(input, providerId, index);
          results.push(result);
          if (result.status === "ok") {
            return { route: input.route, results, selectedProviderId: providerId };
          }
        }
        return { route: input.route, results };
      }
      case "merge": {
        const results = await Promise.all(
          input.route.contributors.map(
            async (providerId, index) => await this.#run(input, providerId, index),
          ),
        );
        return { route: input.route, results };
      }
      case "verify": {
        const providers = [input.route.owner, ...input.route.verifiers];
        const results = await Promise.all(
          providers.map(async (providerId, index) => await this.#run(input, providerId, index)),
        );
        return {
          route: input.route,
          results,
          ...(results[0]?.status === "ok" ? { selectedProviderId: input.route.owner } : {}),
        };
      }
    }
  }

  async #run(
    input: {
      requestId: string;
      request: ProviderRequest;
      timeoutMs: number;
    },
    providerId: ProviderId,
    index: number,
  ): Promise<ProviderResult> {
    return await this.#runtime.run({
      requestId: `${input.requestId}:${index}:${providerId}`,
      providerId,
      request: input.request,
      timeoutMs: input.timeoutMs,
    });
  }
}
