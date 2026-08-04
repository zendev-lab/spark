import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import * as openAIResponses from "@earendil-works/pi-ai/api/openai-responses";

import { createBaiduOneApiProviderAdapter, silenceOpenAiSdkTransportLogs } from "./baidu-oneapi.ts";

const nativeBaiduOneApiProvider = createBaiduOneApiProviderAdapter({
  anthropicMessages: anthropicMessagesApi(),
  openAIResponses: silenceOpenAiSdkTransportLogs(openAIResponses),
});

export const streamBaiduOneApi: typeof nativeBaiduOneApiProvider.stream = (...args) =>
  nativeBaiduOneApiProvider.stream(...args);
export const streamBaiduOneApiAnthropic: typeof nativeBaiduOneApiProvider.streamAnthropic = (
  ...args
) => nativeBaiduOneApiProvider.streamAnthropic(...args);
export const streamBaiduOneApiOpenAIResponses: typeof nativeBaiduOneApiProvider.streamOpenAIResponses =
  (...args) => nativeBaiduOneApiProvider.streamOpenAIResponses(...args);

export {
  isNormalizedBaiduContextOverflow,
  normalizeBaiduOneApiEvent,
  normalizeBaiduOneApiMessage,
  normalizeBaiduOneApiStream,
  remapBaiduOneApiPayload,
  repairBaiduOneApiResponsesFetch,
  repairBaiduOneApiSseLine,
  resolveBaiduOneApiKey,
} from "./baidu-oneapi.ts";
export type { BaiduOneApiStream } from "./baidu-oneapi.ts";

export default function registerNativeBaiduOneApiProvider(
  ...args: Parameters<typeof nativeBaiduOneApiProvider.register>
): void {
  nativeBaiduOneApiProvider.register(...args);
}
