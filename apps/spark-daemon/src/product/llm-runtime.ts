/** Invocation-scoped provider routes installed on the daemon's shared DSH root. */
import type { Context } from "@deepseek-ai/cordis";
import {
  LlmAdapter,
  type AdapterRegistrationHandle,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { SparkTurnLlm } from "./host/agent-runtime/agent-loop.ts";

export interface SparkLlmAdapterRegistration {
  providers: string[];
  adapter: LlmAdapter;
}

export interface CreateSparkLlmCompositionOptions {
  ctx: Context;
  routeNamespace: string;
  adapters?: readonly SparkLlmAdapterRegistration[];
}

export interface SparkLlmComposition {
  llm: SparkTurnLlm;
  dispose(): Promise<void>;
}

export async function createSparkLlmComposition(
  options: CreateSparkLlmCompositionOptions,
): Promise<SparkLlmComposition> {
  const namespace = normalizeRouteNamespace(options.routeNamespace);
  const routes = new Map<string, string>();
  const registrations: AdapterRegistrationHandle[] = [];
  try {
    for (const entry of options.adapters ?? []) {
      for (const provider of entry.providers) {
        const route = `${namespace}/${encodeURIComponent(provider)}`;
        if (routes.has(provider)) {
          throw new Error(`Spark LLM provider ${provider} is registered more than once`);
        }
        routes.set(provider, route);
        registrations.push(
          options.ctx.llm.registerAdapter(
            [route],
            new InvocationProviderRouteAdapter(route, provider, entry.adapter),
          ),
        );
      }
    }
  } catch (error) {
    for (const dispose of registrations.reverse()) dispose();
    throw error;
  }

  return {
    llm: {
      stream(generate) {
        const route = routes.get(generate.provider);
        if (!route) {
          throw new Error(`No Spark LLM adapter is registered for provider ${generate.provider}`);
        }
        return options.ctx.llm.stream({ ...generate, provider: route });
      },
    },
    async dispose() {
      for (const dispose of registrations.reverse()) dispose();
    },
  };
}

class InvocationProviderRouteAdapter extends LlmAdapter {
  private readonly route: string;
  private readonly provider: string;
  private readonly delegate: LlmAdapter;

  constructor(route: string, provider: string, delegate: LlmAdapter) {
    super();
    this.route = route;
    this.provider = provider;
    this.delegate = delegate;
  }

  override providerInfo(route: string) {
    const info = this.delegate.providerInfo(this.provider);
    return { ...info, id: route };
  }

  override providerRetryPolicy(_route: string) {
    return this.delegate.providerRetryPolicy(this.provider);
  }

  override async listModels(_route: string) {
    return (await this.delegate.listModels(this.provider)).map((model) => ({
      ...model,
      provider: this.route,
    }));
  }

  override async resolveModel(
    _route: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await this.delegate.resolveModel(this.provider, model, signal);
    return { ...resolved, provider: this.route };
  }

  override async prepareCall(
    _route: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const prepared = await this.delegate.prepareCall(this.provider, model, signal);
    return {
      model: { ...prepared.model, provider: this.route },
      stream: (options) => prepared.stream({ ...options, provider: this.provider }),
    };
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.delegate.stream({ ...options, provider: this.provider });
  }
}

function normalizeRouteNamespace(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Spark LLM route namespace is required");
  return `spark-invocation/${encodeURIComponent(normalized)}`;
}
