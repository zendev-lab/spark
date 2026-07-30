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
  shouldRetryThrown?: (error: unknown) => boolean;
}

export function retryProviderStreamBeforeOutput(
  initialStream: ProviderStream,
  createStream: () => ProviderStream,
  options: RetryProviderStreamOptions,
): ProviderStream {
  let consumed = false;
  let final: AssistantMessage | undefined;
  let activeStream = initialStream;
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

      while (true) {
        let retry = false;

        try {
          for await (const event of activeStream) {
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
        } catch (error) {
          const retriable =
            !exposedOutput &&
            retries < maxRetries &&
            options.signal?.aborted !== true &&
            options.shouldRetryThrown?.(error) === true;
          if (!retriable) throw error;
          retry = true;
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
        activeStream = createStream();
      }
    },
    async result() {
      if (final) return final;
      if (consumed) {
        throw new Error(
          `Provider "${options.providerName}" stream ended without a final assistant message`,
        );
      }
      consumed = true;
      let retries = 0;
      while (true) {
        try {
          const message = await activeStream.result();
          const retriable =
            !assistantMessageHasOutput(message) &&
            retries < maxRetries &&
            options.signal?.aborted !== true &&
            options.shouldRetry(message);
          if (!retriable) {
            final = message;
            return message;
          }
        } catch (error) {
          const retriable =
            retries < maxRetries &&
            options.signal?.aborted !== true &&
            options.shouldRetryThrown?.(error) === true;
          if (!retriable) throw error;
        }
        retries += 1;
        await sleepProviderStreamRetry(
          providerStreamRetryDelayMs(retries, options),
          options.signal,
        );
        activeStream = createStream();
      }
    },
  };
  return retryingStream;
}

export function isMalformedProviderJsonFailure(message: AssistantMessage): boolean {
  return (
    message.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    isMalformedProviderJsonErrorText(message.errorMessage)
  );
}

export function isMalformedProviderJsonErrorText(text: string): boolean {
  return (
    /unexpected non-whitespace character after json at position \d+(?: \(line \d+ column \d+\))?/iu.test(
      text,
    ) ||
    /unexpected end of json input/iu.test(text) ||
    /unterminated string in json(?: at position \d+)?/iu.test(text) ||
    /expected .+ in json at position \d+(?: \(line \d+ column \d+\))?/iu.test(text)
  );
}

function assistantMessageHasOutput(message: AssistantMessage): boolean {
  return Array.isArray(message.content) && message.content.length > 0;
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
