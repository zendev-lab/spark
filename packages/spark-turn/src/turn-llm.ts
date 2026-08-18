import type { GenerateOptions, LlmRuntime, StreamChunk } from "@deepseek-ai/dsh-llm";
import {
  generateOptionsToPiContext,
  generateOptionsToPiModel,
  generateOptionsToPiStreamOptions,
  llmChunksToPiAiStream,
  piEventsToLlmChunks,
  sparkContextToGenerateOptions,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type StreamOptions,
} from "@zendev-lab/spark-llm";

export type SparkAgentStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: StreamOptions,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

/** Structural LlmRuntime stream surface. Tests may implement this without Cordis. */
export type SparkTurnLlm = Pick<LlmRuntime, "stream">;

export function asSparkTurnLlm(streamFunction: SparkAgentStreamFunction): SparkTurnLlm {
  return {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const model = generateOptionsToPiModel(options);
      const context = generateOptionsToPiContext(options);
      const streamOptions = generateOptionsToPiStreamOptions(options);
      return piEventsToLlmChunks(streamFunction(model, context, streamOptions));
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
