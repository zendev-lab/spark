import { Type } from "typebox";

import {
  createSparkDaemonToolOperationId,
  requestSparkDaemonToolWithAutoStart,
} from "@zendev-lab/spark-daemon-client";
import type { SparkRegisteredToolConfig } from "./spark-tool-registration.ts";

export function createSparkLensToolConfig(): SparkRegisteredToolConfig & {
  policy: {
    effect: "write";
    executionMode: "sequential";
    domains: string[];
    approval: "none";
  };
} {
  return {
    name: "lens",
    label: "Lens",
    description:
      "Run internal revision-safe diagnostics, verification, code discovery, or impact analysis for a GitChange worktree.",
    promptGuidelines: [
      "Treat pass as valid only for the exact workspace revision in the returned receipt.",
      "A provider error, timeout, silence, conflict, or stale revision is not clean.",
      "Use verify when a completion or Ready transition needs a durable receipt.",
      "Search and outline return versioned read parameters; use read rather than expecting Lens to duplicate source.",
      "Provider fixes are Patch Proposals. Apply only the selected proposal; create/delete, unsafe, multiple-candidate, and cross-file rename proposals require explicit selection.",
      "Suppressing a finding requires an applied Patch Proposal for the suppression annotation.",
    ],
    policy: {
      effect: "write",
      executionMode: "sequential",
      domains: ["workspace", "evidence"],
      approval: "none",
    },
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("diagnostics"),
        Type.Literal("verify"),
        Type.Literal("health"),
        Type.Literal("search"),
        Type.Literal("outline"),
        Type.Literal("navigate"),
        Type.Literal("structural_search"),
        Type.Literal("impact"),
        Type.Literal("propose_patch"),
        Type.Literal("apply_patch"),
        Type.Literal("triage"),
      ]),
      artifactRef: Type.Optional(Type.String({ description: "GitChange artifact ref." })),
      path: Type.Optional(Type.String({ description: "Optional finding path filter." })),
      query: Type.Optional(Type.String({ description: "Symbol query for search or navigate." })),
      pattern: Type.Optional(
        Type.String({ description: "ast-grep pattern for structural_search." }),
      ),
      provider: Type.Optional(
        Type.String({ description: "Provider id producing a Patch Proposal." }),
      ),
      proposalRef: Type.Optional(Type.String({ description: "Patch Proposal reference." })),
      edits: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String(),
            startOffset: Type.Integer({ minimum: 0 }),
            endOffset: Type.Integer({ minimum: 0 }),
            newText: Type.String(),
          }),
          { minItems: 1 },
        ),
      ),
      expectedResolution: Type.Optional(
        Type.Array(Type.String({ description: "Observation ref expected to disappear." })),
      ),
      safetyReasons: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("unsafe"),
            Type.Literal("create_delete"),
            Type.Literal("multiple_candidates"),
            Type.Literal("cross_file_rename"),
          ]),
        ),
      ),
      explicitSelection: Type.Optional(
        Type.Boolean({ description: "Required for non-safe Patch Proposals." }),
      ),
      observationRef: Type.Optional(Type.String({ description: "Observation to triage." })),
      disposition: Type.Optional(
        Type.Union([
          Type.Literal("false_positive"),
          Type.Literal("deferred"),
          Type.Literal("flagged"),
          Type.Literal("suppressed"),
        ]),
      ),
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
          operationId: createSparkDaemonToolOperationId({
            method: "lens.execute",
            tool: "lens",
            toolCallId,
            cwd: ctx.cwd,
            ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
            ...(ctx.sessionSource === undefined ? {} : { sessionSource: ctx.sessionSource }),
            ...(ctx.sessionSurface === undefined ? {} : { sessionSurface: ctx.sessionSurface }),
          }),
          params: JSON.parse(JSON.stringify(params)) as Record<string, never>,
          hostContext: {
            ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
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
