import type { SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";

import { registerSparkAskActionTool, type SparkAskDaemonRequest } from "./action-tool.ts";
import { registerSparkAskFlowTool } from "./flow.ts";
import { registerSparkAskTools } from "./index.ts";

export type { SparkAskDaemonRequest };

export interface SparkAskExtensionOptions {
  request?: SparkAskDaemonRequest;
}

export default function piAskExtension(
  pi: SparkHostAPI,
  options: SparkAskExtensionOptions = {},
): void {
  if (!pi.registerTool) throw new Error("spark-ask extension requires registerTool support");

  const askImplementationTools = new Map<string, ToolConfig>();
  const internalApi = {
    registerTool: (config: unknown): void => {
      const toolConfig = config as ToolConfig;
      askImplementationTools.set(toolConfig.name, toolConfig);
    },
  };
  const publicApi = {
    registerTool: (config: unknown): void => {
      pi.registerTool?.(config as ToolConfig);
    },
  };

  registerSparkAskTools(internalApi);
  registerSparkAskFlowTool(internalApi);
  registerSparkAskActionTool(publicApi, {
    resolveTool: (name) => askImplementationTools.get(name),
    ...(options.request ? { request: options.request } : {}),
  });
}
