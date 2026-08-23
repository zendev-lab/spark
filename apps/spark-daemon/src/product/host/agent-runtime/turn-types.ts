import type { ResolvedToolPolicy, ToolConfig } from "@zendev-lab/spark-invocation";

export interface SparkTurnRegisteredTool {
  config: ToolConfig;
  /** Host-resolved immutable policy. Compatibility hosts may omit it. */
  policy?: ResolvedToolPolicy;
  active: boolean;
}

/** How a session satisfies an approval-required tool gate. Default: `human`. */
export type SparkToolApprovalMethod = "skip" | "human" | "auto";

/** When `auto` review rejects: escalate to human approval, or deny the call. */
export type SparkToolApprovalRejectAction = "ask" | "deny";
