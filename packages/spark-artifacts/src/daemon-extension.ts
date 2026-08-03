import {
  requestSparkDaemonToolWithAutoStart,
  type SparkDaemonToolMethod,
} from "@zendev-lab/spark-daemon-client";
import type { ToolConfig } from "@zendev-lab/spark-core";
import { registerArtifactTool } from "./artifact/extension.ts";
import { registerEvidenceTool, type SparkArtifactsHostApi } from "./extension.ts";
import { registerGitLifecycleTool } from "./git/extension.ts";

export default function daemonSparkArtifactsExtension(pi: SparkArtifactsHostApi): void {
  registerEvidenceTool(pi);
  registerArtifactTool({
    registerTool(config) {
      pi.registerTool(proxyDaemonTool(config, "artifact.execute"));
    },
  });
  registerGitLifecycleTool({
    registerTool(config) {
      pi.registerTool(proxyDaemonTool(config, "git.execute"));
    },
  });
}

function proxyDaemonTool(config: ToolConfig, method: SparkDaemonToolMethod): ToolConfig {
  return {
    ...config,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      if (!cwd) throw new Error(`${config.name} requires a workspace cwd`);
      return await requestSparkDaemonToolWithAutoStart(
        method,
        {
          cwd,
          toolCallId,
          operationId: `${config.name}:${toolCallId}`,
          params: toJsonObject(params),
          hostContext: {
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
