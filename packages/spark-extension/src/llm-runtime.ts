/**
 * Process-local Cordis island that mounts `dsh-llm`.
 *
 * Spark product entities (workspace, session, task, daemon) stay outside this
 * container. Callers receive `LlmRuntime`, never `Context`.
 */
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  type AdapterRegistrationHandle,
  type LlmAdapter,
  type LlmRuntime as SparkLlmRuntime,
} from "@deepseek-ai/dsh-llm";

export interface SparkLlmAdapterRegistration {
  providers: string[];
  adapter: LlmAdapter;
}

export interface CreateSparkLlmCompositionOptions {
  adapters?: readonly SparkLlmAdapterRegistration[];
}

export interface SparkLlmComposition {
  llm: SparkLlmRuntime;
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle;
  dispose(): Promise<void>;
}

export async function createSparkLlmComposition(
  options: CreateSparkLlmCompositionOptions = {},
): Promise<SparkLlmComposition> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  for (const entry of options.adapters ?? []) {
    ctx.llm.registerAdapter(entry.providers, entry.adapter);
  }
  return {
    llm: ctx.llm,
    registerAdapter(providers, adapter) {
      return ctx.llm.registerAdapter(providers, adapter);
    },
    dispose: () => ctx.fiber.dispose(),
  };
}
