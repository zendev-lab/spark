import { Type } from "typebox";

import { requestSparkDaemonToolWithAutoStart } from "@zendev-lab/spark-daemon-client";
import type { SparkRegisteredToolConfig } from "./spark-tool-registration.ts";

export function createSparkLensToolConfig(): SparkRegisteredToolConfig & {
  policy: {
    effect: "read";
    executionMode: "sequential";
    domains: string[];
    approval: "none";
  };
} {
  return {
    name: "lens",
    label: "Lens",
    description:
      "Run internal, revision-safe diagnostics or verification for a GitChange worktree.",
    promptGuidelines: [
      "Treat pass as valid only for the exact workspace revision in the returned receipt.",
      "A provider error, timeout, silence, conflict, or stale revision is not clean.",
      "Use verify when a completion or Ready transition needs a durable receipt.",
    ],
    policy: {
      effect: "read",
      executionMode: "sequential",
      domains: ["workspace", "evidence"],
      approval: "none",
    },
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("diagnostics"),
        Type.Literal("verify"),
        Type.Literal("health"),
      ]),
      artifactRef: Type.Optional(Type.String({ description: "GitChange artifact ref." })),
      path: Type.Optional(Type.String({ description: "Optional finding path filter." })),
      refresh: Type.Optional(
        Type.Boolean({
          description: "Request a fresh provider run; verification is always fresh.",
        }),
      ),
      maxFindings: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.cwd) throw new Error("lens requires a workspace cwd");
      return await requestSparkDaemonToolWithAutoStart(
        "lens.execute",
        {
          cwd: ctx.cwd,
          toolCallId,
          operationId: `lens:${toolCallId}`,
          params: JSON.parse(JSON.stringify(params)) as Record<string, never>,
          hostContext: {
            ...(ctx.sessionSource === undefined ? {} : { sessionSource: ctx.sessionSource }),
            ...(ctx.sessionSurface === undefined ? {} : { sessionSurface: ctx.sessionSurface }),
            ...(ctx.hasUI === undefined ? {} : { hasUI: ctx.hasUI }),
          },
        },
        { cwd: ctx.cwd, signal },
      );
    },
  };
}
