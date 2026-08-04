import type { SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";
import registerSparkRolesExtension from "./extension.ts";
import { registerSparkSkillDelegateTool } from "./skill-extension.ts";

export default function sparkRolesExtension(api: SparkHostAPI): void {
  if (!api.registerTool) throw new Error("spark-roles extension requires registerTool support");
  const host = {
    registerTool(config: unknown): void {
      api.registerTool!(config as ToolConfig);
    },
  };
  registerSparkRolesExtension(host);
  registerSparkSkillDelegateTool(host);
}

export * from "./extension.ts";
export * from "./skill-extension.ts";
