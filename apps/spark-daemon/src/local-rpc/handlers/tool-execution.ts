import { join } from "node:path";
import { registerArtifactTool, registerGitLifecycleTool } from "@zendev-lab/spark-artifacts";
import type { ToolConfig } from "@zendev-lab/spark-core";
import {
  createEditToolConfig,
  createFindToolConfig,
  createGrepToolConfig,
  createReadToolConfig,
  createWriteToolConfig,
} from "@zendev-lab/spark-files";
import { SparkDaemonControlError } from "../../control-error.ts";
import { executeDaemonLensTool } from "../../lens/tool.ts";
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
        `${toolDisplayName(request)} operation ${request.params.operationId} was reused with different input. No operation was executed; start a new tool call.`,
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
  return JSON.parse(JSON.stringify(result)) as ToolExecutionOutput;
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
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "TOOL_EXECUTION_FAILED",
    message: `The daemon could not execute the tool: ${detail}. Inspect the daemon logs and verify that the client and daemon versions match.`,
    retry: "inspect_daemon_and_version",
  };
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
