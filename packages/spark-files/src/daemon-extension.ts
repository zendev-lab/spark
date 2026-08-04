import {
  createSparkDaemonToolOperationId,
  requestSparkDaemonToolWithAutoStart,
} from "@zendev-lab/spark-daemon-client";
import type { ToolConfig } from "@zendev-lab/spark-core";
import {
  createEditToolConfig,
  createLsToolConfig,
  createReadToolConfig,
  createWriteToolConfig,
} from "./file-tools.ts";
import { createFindToolConfig, createGrepToolConfig } from "./search-tools.ts";
import type { SparkFilesHostApi, SparkFilesOptions } from "./extension.ts";

const DEFAULT_TOOLS = ["read", "write", "edit", "grep", "find"] as const;

/**
 * Explicit migration/testing adapter only. The published Pi compatibility
 * surface no longer registers Spark replacements for Pi-native file tools.
 */
export function registerDaemonSparkFilesTools(
  pi: SparkFilesHostApi,
  options: SparkFilesOptions = {},
): void {
  const factories = {
    read: createReadToolConfig,
    write: createWriteToolConfig,
    edit: createEditToolConfig,
    ls: createLsToolConfig,
    grep: createGrepToolConfig,
    find: createFindToolConfig,
  } as const;
  for (const name of options.tools ?? DEFAULT_TOOLS) {
    if (name === "ls") {
      pi.registerTool(createLsToolConfig());
      continue;
    }
    pi.registerTool(proxyFileTool(factories[name]()));
  }
}

export default function daemonSparkFilesExtension(pi: SparkFilesHostApi): void {
  registerDaemonSparkFilesTools(pi);
}

function proxyFileTool(config: ToolConfig): ToolConfig {
  return {
    ...config,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      if (!cwd) throw new Error(`${config.name} requires a workspace cwd`);
      return await requestSparkDaemonToolWithAutoStart(
        "file.execute",
        {
          cwd,
          toolCallId,
          operationId: createSparkDaemonToolOperationId({
            method: "file.execute",
            tool: config.name,
            toolCallId,
            cwd,
            ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
            ...(ctx.sessionSource === undefined ? {} : { sessionSource: ctx.sessionSource }),
            ...(ctx.sessionSurface === undefined ? {} : { sessionSurface: ctx.sessionSurface }),
          }),
          tool: config.name as "read" | "write" | "edit" | "grep" | "find",
          params: toJsonObject(params),
          hostContext: {
            ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
            ...(ctx.sessionSource === undefined ? {} : { sessionSource: ctx.sessionSource }),
            ...(ctx.sessionSurface === undefined ? {} : { sessionSurface: ctx.sessionSurface }),
            ...(ctx.hasUI === undefined ? {} : { hasUI: ctx.hasUI }),
          },
        },
        { cwd, signal },
      );
    },
  };
}

function toJsonObject(value: Record<string, unknown>): Record<string, never> {
  return JSON.parse(JSON.stringify(value)) as Record<string, never>;
}
