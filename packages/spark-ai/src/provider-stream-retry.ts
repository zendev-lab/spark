import type { AssistantMessage, AssistantMessageEvent, StreamOptions } from "@earendil-works/pi-ai";
import { cappedExponentialCeiling, equalJitter } from "@zendev-lab/spark-retry";

const PROVIDER_STREAM_RETRY_BASE_DELAY_MS = 1_000;
const PROVIDER_STREAM_RETRY_MAX_DELAY_MS = 60_000;

type ProviderStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface RetryProviderStreamOptions {
  providerName: string;
  maxRetries: number;
  maxRetryDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry(message: AssistantMessage): boolean;
}

export function retryProviderStreamBeforeOutput(
  initialStream: ProviderStream,
  createStream: () => ProviderStream,
  options: RetryProviderStreamOptions,
): ProviderStream {
  let consumed = false;
  let final: AssistantMessage | undefined;
  const maxRetries = normalizeRetryCount(options.maxRetries);
  const retryingStream: ProviderStream = {
    async *[Symbol.asyncIterator]() {
      if (consumed) {
        if (final) return;
        throw new Error(`Provider "${options.providerName}" stream is already being consumed`);
      }
      consumed = true;
      let retries = 0;
      let exposedOutput = false;
      let started = false;
      let stream = initialStream;

      while (true) {
        let retry = false;

        for await (const event of stream) {
          if (event.type === "start") {
            if (!started) {
              started = true;
              yield event;
            }
            continue;
          }
          if (event.type === "error") {
            const retriable =
              !exposedOutput &&
              retries < maxRetries &&
              options.signal?.aborted !== true &&
              options.shouldRetry(event.error);
            if (retriable) {
              retry = true;
              break;
            }
            final = event.error;
            yield event;
            return;
          }
          if (event.type === "done") {
            final = event.message;
            yield event;
            return;
          }
          exposedOutput = true;
          yield event;
        }

        if (!retry) {
          throw new Error(
            `Provider "${options.providerName}" stream ended without a terminal event`,
          );
        }
        retries += 1;
        await sleepProviderStreamRetry(
          providerStreamRetryDelayMs(retries, options),
          options.signal,
        );
        stream = createStream();
      }
    },
    async result() {
      if (final) return final;
      for await (const event of retryingStream) {
        if (event.type === "done") final = event.message;
        if (event.type === "error") final = event.error;
      }
      if (final) return final;
      throw new Error(
        `Provider "${options.providerName}" stream ended without a final assistant message`,
      );
    },
  };
  return retryingStream;
}

export function isConcatenatedProviderJsonFailure(message: AssistantMessage): boolean {
  return (
    message.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    isConcatenatedProviderJsonErrorText(message.errorMessage)
  );
}

export function isConcatenatedProviderJsonErrorText(text: string): boolean {
  return /unexpected non-whitespace character after json at position \d+ \(line \d+ column \d+\)/iu.test(
    text,
  );
}

function normalizeRetryCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function providerStreamRetryDelayMs(
  attempt: number,
  options: Pick<StreamOptions, "maxRetryDelayMs">,
): number {
  const configuredMax = options.maxRetryDelayMs;
  const maxDelay =
    typeof configuredMax === "number" && Number.isFinite(configuredMax) && configuredMax > 0
      ? Math.floor(configuredMax)
      : PROVIDER_STREAM_RETRY_MAX_DELAY_MS;
  return equalJitter(
    cappedExponentialCeiling(
      attempt,
      Math.min(PROVIDER_STREAM_RETRY_BASE_DELAY_MS, maxDelay),
      maxDelay,
    ),
  );
}

function sleepProviderStreamRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Provider stream retry aborted"),
      );
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Provider stream retry aborted"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
