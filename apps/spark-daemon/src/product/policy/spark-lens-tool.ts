import { Type } from "typebox";

import {
  createSparkDaemonToolOperationId,
  requestSparkDaemonToolWithAutoStart,
} from "@zendev-lab/spark-daemon-client";
import type { SparkRegisteredToolConfig } from "./spark-tool-registration.ts";

const sourcePositionSchema = Type.Object(
  {
    line: Type.Integer({ minimum: 0 }),
    character: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const lensScopeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("file"), path: Type.String() }),
  Type.Object({ kind: Type.Literal("changed") }),
  Type.Object({ kind: Type.Literal("workspace") }),
  Type.Object({ kind: Type.Literal("git_change"), artifactRef: Type.String() }),
]);

const verificationTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("workspace") }),
  Type.Object({ kind: Type.Literal("git_change"), artifactRef: Type.String() }),
  Type.Object({ kind: Type.Literal("task"), taskRef: Type.String() }),
  Type.Object({ kind: Type.Literal("goal"), goalRef: Type.String() }),
]);

export function createSparkLensToolConfig(): SparkRegisteredToolConfig {
  return {
    name: "lens",
    label: "Lens",
    description:
      "Run the internal revision-safe code loop: status, inspect, check, fix, triage, or verify.",
    promptGuidelines: [
      "Treat pass as valid only for the exact workspace revision in the returned receipt.",
      "A provider error, timeout, silence, conflict, or stale revision is not clean.",
      "Use verify when a completion or Ready transition needs a durable receipt.",
      "Inspect returns versioned read locators; use read rather than expecting Lens to duplicate source.",
      "Use check to create Observations and verify only for durable completion receipts.",
      "Only providers create Patch Proposals. Apply a selected proposal through fix; ordinary authored changes use read/write/edit.",
      "Suppressing a finding requires an applied Patch Proposal for the suppression annotation.",
    ],
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      domains: ["workspace", "evidence"],
      approval: "none",
    },
    resolvePolicy(args) {
      const read = args.action === "status" || args.action === "inspect";
      return {
        effect: read ? "read" : "local_write",
        executionMode: read ? "parallel" : "sequential",
        domains: ["workspace", "evidence"],
        approval: "none",
      };
    },
    parameters: Type.Union([
      Type.Object(
        {
          action: Type.Literal("status"),
          view: Type.Optional(
            Type.Union([
              Type.Literal("summary"),
              Type.Literal("providers"),
              Type.Literal("queue"),
              Type.Literal("receipts"),
            ]),
          ),
          artifactRef: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("inspect"),
          operation: Type.Union(
            [
              "search",
              "outline",
              "enclosing",
              "definition",
              "declaration",
              "type_definition",
              "implementation",
              "references",
              "hover",
              "signature",
              "document_symbols",
              "workspace_symbols",
              "call_hierarchy",
              "structural_search",
              "ast",
              "impact",
            ].map((value) => Type.Literal(value)),
          ),
          scope: Type.Optional(lensScopeSchema),
          path: Type.Optional(Type.String()),
          position: Type.Optional(sourcePositionSchema),
          query: Type.Optional(Type.String()),
          pattern: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("check"),
          kind: Type.Union(
            ["preflight", "diagnostics", "lint", "test", "project", "pr"].map((value) =>
              Type.Literal(value),
            ),
          ),
          scope: lensScopeSchema,
          refresh: Type.Optional(Type.Boolean()),
          maxFindings: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("fix"),
          operation: Type.Literal("propose"),
          kind: Type.Union(
            ["quickfix", "format", "organize_imports", "rename", "structural_replace"].map(
              (value) => Type.Literal(value),
            ),
          ),
          observationRef: Type.Optional(Type.String()),
          candidateRef: Type.Optional(Type.String()),
          path: Type.Optional(Type.String()),
          position: Type.Optional(sourcePositionSchema),
          newName: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("fix"),
          operation: Type.Literal("apply"),
          proposalRef: Type.String(),
          selectionRef: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("fix"),
          operation: Type.Literal("reject"),
          proposalRef: Type.String(),
          reason: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("triage"),
          observationRef: Type.String(),
          disposition: Type.Union(
            ["false_positive", "defer", "flagged", "suppress"].map((value) => Type.Literal(value)),
          ),
          reason: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("verify"),
          target: verificationTargetSchema,
          refresh: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ]),
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
