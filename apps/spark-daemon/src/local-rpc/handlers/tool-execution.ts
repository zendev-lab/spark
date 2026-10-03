import { join } from "node:path";
import { registerArtifactTool, registerGitLifecycleTool } from "@zendev-lab/spark-artifacts";
import type { ToolConfig } from "@zendev-lab/spark-invocation";
import {
  createEditToolConfig,
  createFindToolConfig,
  createGrepToolConfig,
  createReadToolConfig,
  createWriteToolConfig,
  resolveArtifactFileRoot,
} from "@zendev-lab/spark-files";
import type {
  LensReadAnalysisMode,
  LensReadAnnotation,
  LensReadRepairMode,
  LensWorkspaceChange,
} from "@zendev-lab/spark-lens";
import { SparkDaemonControlError } from "../../control-error.ts";
import { executeDaemonLensTool, lensReadIntegrationFor } from "../../lens/tool.ts";
import { resolveSessionCwdForWorkspaceId, SessionCwdResolutionError } from "../../session-cwd.ts";
import { resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type ToolExecutionRequest = Extract<
  LocalRpcServiceRequest,
  { method: "file.execute" | "artifact.execute" | "git.execute" | "lens.execute" }
>;

type ToolExecutionOutput = LocalRpcServiceOutput<ToolExecutionRequest>;

const fileTools = new Map(
  [
    createReadToolConfig(),
    createWriteToolConfig(),
    createEditToolConfig(),
    createGrepToolConfig(),
    createFindToolConfig(),
  ].map((config) => [config.name, config] as const),
);

let artifactTool: ToolConfig | undefined;
registerArtifactTool({
  registerTool(config) {
    artifactTool = config;
  },
});

let gitTool: ToolConfig | undefined;
registerGitLifecycleTool({
  registerTool(config) {
    gitTool = config;
  },
});

const operationResults = new Map<
  string,
  {
    signature: string;
    result: Promise<ToolExecutionOutput>;
  }
>();
const MAX_OPERATION_RESULTS = 1_000;

export async function handleToolExecutionRequest(
  context: LocalRpcDispatchContext,
  request: ToolExecutionRequest,
): Promise<ToolExecutionOutput> {
  const signature = JSON.stringify({
    method: request.method,
    cwd: request.params.cwd,
    toolCallId: request.params.toolCallId,
    params: request.params.params,
    hostContext: request.params.hostContext,
    ...("tool" in request.params ? { tool: request.params.tool } : {}),
  });
  const existing = operationResults.get(request.params.operationId);
  if (existing) {
    if (existing.signature !== signature) {
      return toolErrorResult(
        request,
        "TOOL_OPERATION_ID_CONFLICT",
        `${toolDisplayName(request)} operation id was reused with different input. No operation was executed; start a new tool call.`,
        "new_tool_call",
      );
    }
    return await existing.result;
  }

  const result = executeToolRequest(context, request).catch((error: unknown) => {
    const failure = classifyToolExecutionFailure(error);
    console.error(
      `[spark-daemon] ${request.method} ${request.params.operationId} failed: ${failure.message}`,
      error,
    );
    return toolErrorResult(request, failure.code, failure.message, failure.retry);
  });
  operationResults.set(request.params.operationId, { signature, result });
  trimOperationResults();
  return await result;
}

async function executeToolRequest(
  context: LocalRpcDispatchContext,
  request: ToolExecutionRequest,
): Promise<ToolExecutionOutput> {
  const workspaceId = request.params.hostContext?.workspaceId;
  let cwd = request.params.cwd;
  let sparkStateRoot: string | undefined;
  let stateCwd = cwd;
  if (workspaceId) {
    try {
      const resolved = await resolveSessionCwdForWorkspaceId(context.db, {
        workspaceId,
        cwd,
      });
      cwd = resolved.cwd;
      const workspaceRoot = resolveWorkspaceLocalPath(context.db, workspaceId);
      if (!workspaceRoot) {
        throw new SessionCwdResolutionError(`Workspace ${workspaceId} is unavailable.`);
      }
      sparkStateRoot = join(workspaceRoot, ".spark");
      stateCwd = workspaceRoot;
    } catch (error) {
      if (error instanceof SessionCwdResolutionError) {
        throw new SparkDaemonControlError("workspace_cwd_invalid", error.message);
      }
      throw error;
    }
  }
  if (request.method === "lens.execute") {
    return await executeDaemonLensTool(request, context.db, cwd, stateCwd);
  }
  const config =
    request.method === "file.execute"
      ? fileTools.get(request.params.tool)
      : request.method === "artifact.execute"
        ? artifactTool
        : gitTool;
  if (!config) {
    return toolErrorResult(
      request,
      "TOOL_IMPLEMENTATION_UNAVAILABLE",
      `No daemon implementation is registered for ${toolDisplayName(request)}. Restart or update Spark so the client and daemon expose the same tool surface.`,
      "restart_or_update_daemon",
    );
  }

  const result = await config.execute(
    request.params.toolCallId,
    request.params.params,
    new AbortController().signal,
    () => {},
    {
      cwd,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(sparkStateRoot === undefined ? {} : { sparkStateRoot }),
      hasUI: request.params.hostContext?.hasUI ?? false,
      sessionSurface: request.params.hostContext?.sessionSurface ?? "local",
      sessionSource: request.params.hostContext?.sessionSource ?? "daemon",
    },
  );
  if (request.method !== "file.execute" || result.isError) {
    return cloneResult(result);
  }
  if (request.params.tool === "read") {
    return await integrateLensRead(
      context,
      request,
      config,
      result,
      cwd,
      stateCwd,
      workspaceId,
      sparkStateRoot,
    );
  }
  if (request.params.tool === "write" || request.params.tool === "edit") {
    const workspaceChange = await recordWorkspaceChange(context, request, result, cwd, stateCwd);
    return cloneResult({
      ...result,
      details: { ...objectDetails(result.details), workspaceChange },
    });
  }
  return cloneResult(result);
}

async function integrateLensRead(
  context: LocalRpcDispatchContext,
  request: Extract<ToolExecutionRequest, { method: "file.execute" }>,
  config: ToolConfig,
  initialResult: Awaited<ReturnType<ToolConfig["execute"]>>,
  cwd: string,
  stateCwd: string,
  workspaceId: string | undefined,
  sparkStateRoot: string | undefined,
): Promise<ToolExecutionOutput> {
  const params = request.params.params;
  const analysis = readAnalysisMode(params.analysis);
  const repair = readRepairMode(params.repair);
  if (analysis === "off" && repair === "none") {
    return cloneResult(initialResult);
  }
  const initialDetails = objectDetails(initialResult.details);
  const initialVersion = fileVersion(initialDetails.version);
  const path = stringValue(initialDetails.path, "read result path");
  const artifactRef = optionalStringValue(initialDetails.artifactRef);
  const root = await resolveArtifactFileRoot(cwd, artifactRef, stateCwd);
  const integration = lensReadIntegrationFor(context.db);
  let result = initialResult;
  let details = initialDetails;
  let repairResult: Awaited<ReturnType<typeof integration.repair>> | undefined;
  if (repair !== "none") {
    try {
      repairResult = await integration.repair({
        workspaceRoot: root.cwd,
        path,
        expectedVersion: initialVersion,
        mode: repair,
      });
    } catch (error) {
      return cloneResult({
        content: [
          {
            type: "text",
            text: `Read repair failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
        details: {
          code: "LENS_READ_REPAIR_FAILED",
          path,
          previousVersion: initialVersion,
          repair,
        },
      });
    }
    if (!repairResult.unchanged) {
      const finalVersion = repairResult.receipt?.version;
      if (!finalVersion) throw new Error("Lens read repair did not return a final file version");
      result = await config.execute(
        request.params.toolCallId,
        { ...params, expectedVersion: finalVersion, repair: "none", analysis: "off" },
        new AbortController().signal,
        () => {},
        {
          cwd,
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(sparkStateRoot === undefined ? {} : { sparkStateRoot }),
          hasUI: request.params.hostContext?.hasUI ?? false,
          sessionSurface: request.params.hostContext?.sessionSurface ?? "local",
          sessionSource: request.params.hostContext?.sessionSource ?? "daemon",
        },
      );
      if (result.isError) return cloneResult(result);
      details = objectDetails(result.details);
    }
  }
  const version = fileVersion(details.version);
  const window = objectDetails(details.window);
  const startLine = positiveNumber(window.startLine) ?? 1;
  const endLine = positiveNumber(window.endLine) ?? startLine;
  const annotation = await integration.annotate({
    workspaceRoot: root.cwd,
    path,
    fileVersion: version,
    startLine,
    endLine,
    mode: analysis,
    ...(root.artifactRef ? { artifactRef: root.artifactRef } : {}),
  });
  const content = [...result.content];
  if (repairResult?.receipt) {
    content.push({
      type: "text",
      text: [
        `[Read repair applied: ${repairResult.receipt.providers.join(" + ")}]`,
        `[Previous version: ${repairResult.receipt.previousVersion}]`,
        `[File version: ${repairResult.receipt.version}]`,
        `[Verification: ${repairResult.receipt.verificationVerdict}]`,
      ].join("\n"),
    });
  } else if (repair !== "none") {
    content.push({ type: "text", text: `[Read repair: no provider changes for ${version}]` });
  }
  if (annotation) content.push({ type: "text", text: renderReadAnnotation(annotation) });
  return cloneResult({
    ...result,
    content,
    details: {
      ...details,
      ...(annotation ? { lens: annotation } : {}),
      ...(repairResult?.proposal ? { patchProposal: repairResult.proposal } : {}),
      ...(repairResult?.receipt ? { repairReceipt: repairResult.receipt } : {}),
      ...(repairResult?.change ? { workspaceChange: repairResult.change } : {}),
    },
  });
}

async function recordWorkspaceChange(
  context: LocalRpcDispatchContext,
  request: Extract<ToolExecutionRequest, { method: "file.execute" }>,
  result: Awaited<ReturnType<ToolConfig["execute"]>>,
  cwd: string,
  stateCwd: string,
): Promise<LensWorkspaceChange> {
  const details = objectDetails(result.details);
  const path = stringValue(details.path, "file change path");
  const version = fileVersion(details.version);
  const previousVersion = previousFileVersion(details.previousVersion);
  const artifactRef = optionalStringValue(details.artifactRef);
  const root = await resolveArtifactFileRoot(cwd, artifactRef, stateCwd);
  const firstChangedLine = positiveNumber(details.firstChangedLine);
  const change: LensWorkspaceChange = {
    path,
    previousVersion,
    version,
    changedRanges: firstChangedLine
      ? [
          {
            start: { line: firstChangedLine - 1, character: 0 },
            end: { line: firstChangedLine - 1, character: 1 },
          },
        ]
      : [],
    source: request.params.tool === "write" ? "write" : "edit",
  };
  const integration = lensReadIntegrationFor(context.db);
  integration.invalidate(change);
  void integration
    .annotate({
      workspaceRoot: root.cwd,
      path,
      fileVersion: version,
      startLine: firstChangedLine ?? 1,
      endLine: firstChangedLine ?? 1,
      mode: "auto",
      ...(root.artifactRef ? { artifactRef: root.artifactRef } : {}),
    })
    .catch(() => undefined);
  return change;
}

function renderReadAnnotation(annotation: LensReadAnnotation): string {
  const lines = [
    `[Lens: ${annotation.status} revision=${annotation.revisionDigest.slice(0, 12)} file=${annotation.fileVersion}]`,
  ];
  if (annotation.enclosing?.symbol) {
    lines.push(
      `[Enclosing: ${annotation.enclosing.symbol.kind} ${annotation.enclosing.symbol.name}]`,
    );
  }
  for (const finding of annotation.diagnostics.inRange) {
    const line = finding.range ? finding.range.start.line + 1 : "?";
    lines.push(
      `[${finding.severity.toUpperCase()} ${finding.path}:${line}${finding.code ? ` ${finding.code}` : ""}] ${finding.message}`,
    );
  }
  const elsewhere = annotation.diagnostics.elsewhere;
  if (elsewhere.errors > 0 || elsewhere.warnings > 0) {
    lines.push(`[Elsewhere: ${elsewhere.errors} error(s), ${elsewhere.warnings} warning(s)]`);
  }
  if (annotation.format.candidateRef) {
    lines.push(`[Format available: candidateRef=${annotation.format.candidateRef}]`);
  }
  if (annotation.checkTicketRef) lines.push(`[Check pending: ${annotation.checkTicketRef}]`);
  return lines.join("\n");
}

function readAnalysisMode(value: unknown): LensReadAnalysisMode {
  return value === "fresh" || value === "off" ? value : "auto";
}

function readRepairMode(value: unknown): LensReadRepairMode {
  return value === "format" || value === "safe_fixes" || value === "format_and_safe_fixes"
    ? value
    : "none";
}

function objectDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is unavailable`);
  return value;
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function fileVersion(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("file version is unavailable");
  }
  return value as `sha256:${string}`;
}

function previousFileVersion(value: unknown): "missing" | `sha256:${string}` {
  if (value === "missing") return value;
  return fileVersion(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function cloneResult(value: unknown): ToolExecutionOutput {
  return JSON.parse(JSON.stringify(value)) as ToolExecutionOutput;
}

function toolErrorResult(
  request: ToolExecutionRequest,
  code: string,
  message: string,
  retry: string,
): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    details: {
      code,
      method: request.method,
      operationId: request.params.operationId,
      cwd: request.params.cwd,
      ...(request.params.hostContext?.workspaceId === undefined
        ? {}
        : { workspaceId: request.params.hostContext.workspaceId }),
      ...("tool" in request.params ? { tool: request.params.tool } : {}),
      retry,
    },
    isError: true,
  } as ToolExecutionOutput;
}

function classifyToolExecutionFailure(error: unknown): {
  code: string;
  message: string;
  retry: string;
} {
  if (error instanceof SparkDaemonControlError && error.code === "workspace_cwd_invalid") {
    return {
      code: "WORKSPACE_CWD_INVALID",
      message: `${error.message} Reopen or rebind the session to an existing workspace directory or attached GitChange worktree, then retry.`,
      retry: "rebind_workspace_cwd",
    };
  }
  const detail = boundedErrorDetail(error);
  return {
    code: "TOOL_EXECUTION_FAILED",
    message: `The daemon could not execute the tool: ${detail}. Inspect the daemon logs and verify that the client and daemon versions match.`,
    retry: "inspect_daemon_and_version",
  };
}

function boundedErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.length <= 2_000 ? detail : `${detail.slice(0, 2_000)}…`;
}

function toolDisplayName(request: ToolExecutionRequest): string {
  return "tool" in request.params ? request.params.tool : request.method.replace(".execute", "");
}

function trimOperationResults(): void {
  while (operationResults.size > MAX_OPERATION_RESULTS) {
    const oldest = operationResults.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    operationResults.delete(oldest);
  }
}
