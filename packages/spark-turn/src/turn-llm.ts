import type { Context as CordisContext } from "@deepseek-ai/cordis";
import type { GenerateOptions, LlmRuntime, StreamChunk } from "@deepseek-ai/dsh-llm";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
} from "@zendev-lab/spark-llm-providers";
import {
  generateOptionsToPiContext,
  generateOptionsToPiModel,
  generateOptionsToPiStreamOptions,
  llmChunksToPiAiStream,
  piEventsToLlmChunks,
  sparkContextToGenerateOptions,
} from "@zendev-lab/spark-llm-providers/pi-ai-stream";

export type SparkAgentStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: StreamOptions,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface SparkDshTurnRuntime {
  ctx: CordisContext;
  dispose(): Promise<void>;
}

/** Structural LlmRuntime stream surface. Tests may request an isolated test root. */
export interface SparkTurnLlm extends Pick<LlmRuntime, "stream"> {
  createDshTestRuntime?(maxParallelToolCalls: number): Promise<SparkDshTurnRuntime>;
}

export function asSparkTurnLlm(streamFunction: SparkAgentStreamFunction): SparkTurnLlm {
  return {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const model = generateOptionsToPiModel(options);
      const context = generateOptionsToPiContext(options);
      const streamOptions = generateOptionsToPiStreamOptions(options);
      return piEventsToLlmChunks(streamFunction(model, context, streamOptions));
    },
    async createDshTestRuntime(maxParallelToolCalls) {
      const { createSparkDshTurnTestRuntime } = await import("./testing/dsh-runtime.ts");
      return await createSparkDshTurnTestRuntime(maxParallelToolCalls);
    },
  };
}

export function sparkTurnLlmStream(
  llm: SparkTurnLlm,
  model: Model<string>,
  context: Context,
  options?: StreamOptions & { maxTokens?: number },
) {
  return llmChunksToPiAiStream(
    llm.stream(sparkContextToGenerateOptions(model, context, options ?? {})),
    model,
  );
}
