import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";

import { createBaiduOneApiProviderAdapter, silenceOpenAiSdkTransportLogs } from "./baidu-oneapi.ts";

const piBaiduOneApiProvider = createBaiduOneApiProviderAdapter({
  anthropicMessages: anthropicMessagesApi(),
  openAIResponses: silenceOpenAiSdkTransportLogs(openAIResponsesApi()),
});

export default function registerBaiduOneApiCompatibilityExtension(
  ...args: Parameters<typeof piBaiduOneApiProvider.register>
): void {
  piBaiduOneApiProvider.register(...args);
}
