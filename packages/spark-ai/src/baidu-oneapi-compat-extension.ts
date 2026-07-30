import { anthropicMessagesApi, lazyApi } from "@earendil-works/pi-ai/compat";

import { createBaiduOneApiProviderAdapter, silenceOpenAiSdkTransportLogs } from "./baidu-oneapi.ts";

const piBaiduOneApiProvider = createBaiduOneApiProviderAdapter({
  anthropicMessages: anthropicMessagesApi(),
  openAIResponses: lazyApi(async () =>
    silenceOpenAiSdkTransportLogs(await import("@earendil-works/pi-ai/api/openai-responses")),
  ),
});

export default function registerBaiduOneApiCompatibilityExtension(
  ...args: Parameters<typeof piBaiduOneApiProvider.register>
): void {
  piBaiduOneApiProvider.register(...args);
}
