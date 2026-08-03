import { registerArtifactTool, registerGitLifecycleTool } from "@zendev-lab/spark-artifacts";
import type { ToolConfig } from "@zendev-lab/spark-core";
import {
  createEditToolConfig,
  createFindToolConfig,
  createGrepToolConfig,
  createReadToolConfig,
  createWriteToolConfig,
} from "@zendev-lab/spark-files";
import { executeDaemonLensTool } from "../../lens/tool.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type ToolExecutionRequest = Extract<
  LocalRpcServiceRequest,
  { method: "file.execute" | "artifact.execute" | "git.execute" | "lens.execute" }
>;

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
    result: Promise<LocalRpcServiceOutput<ToolExecutionRequest>>;
  }
>();
const MAX_OPERATION_RESULTS = 1_000;

export async function handleToolExecutionRequest(
  context: LocalRpcDispatchContext,
  request: ToolExecutionRequest,
): Promise<LocalRpcServiceOutput<ToolExecutionRequest>> {
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
      throw new Error(
        `operationId ${request.params.operationId} was already used with different input`,
      );
    }
    return await existing.result;
  }

  const result = executeToolRequest(context, request);
  operationResults.set(request.params.operationId, { signature, result });
  trimOperationResults();
  return await result;
}

async function executeToolRequest(
  context: LocalRpcDispatchContext,
  request: ToolExecutionRequest,
): Promise<LocalRpcServiceOutput<ToolExecutionRequest>> {
  if (request.method === "lens.execute") {
    return await executeDaemonLensTool(request, context.db);
  }
  const config =
    request.method === "file.execute"
      ? fileTools.get(request.params.tool)
      : request.method === "artifact.execute"
        ? artifactTool
        : gitTool;
  if (!config) {
    throw new Error(`No daemon tool implementation is registered for ${request.method}`);
  }

  const result = await config.execute(
    request.params.toolCallId,
    request.params.params,
    new AbortController().signal,
    () => {},
    {
      cwd: request.params.cwd,
      hasUI: request.params.hostContext?.hasUI ?? false,
      sessionSurface: request.params.hostContext?.sessionSurface ?? "local",
      sessionSource: request.params.hostContext?.sessionSource ?? "daemon",
    },
  );
  return JSON.parse(JSON.stringify(result)) as LocalRpcServiceOutput<ToolExecutionRequest>;
}

function trimOperationResults(): void {
  while (operationResults.size > MAX_OPERATION_RESULTS) {
    const oldest = operationResults.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    operationResults.delete(oldest);
  }
}
