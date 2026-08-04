import {
  listWorkflowDefinitions,
  resolveWorkflowDefinition,
  type WorkflowDefinitionDescriptor,
  type WorkflowDefinitionOptions,
  type WorkflowDefinitionRegistryError,
  type WorkflowDefinitionRegistryListing,
} from "./definition.ts";

export { userWorkflowDir, workspaceWorkflowDir } from "./registry-paths.ts";
export {
  normalizeWorkflowId,
  parseWorkflowMarkdown,
  parseWorkflowSelector,
  resolveWorkflowDefinition,
  workflowDefinitionDigest,
  workflowSelector,
} from "./definition.ts";
export type {
  RawWorkflowDefinition,
  WorkflowDefinition,
  WorkflowDefinitionDescriptor,
  WorkflowDefinitionOptions,
  WorkflowDefinitionPhase,
  WorkflowDefinitionRegistryError,
  WorkflowDefinitionRegistryListing,
  WorkflowSelector,
  WorkflowSource,
  WorkflowStageDefinition,
  WorkflowWorkbenchPolicy,
} from "./definition.ts";

/** Saved Workflow registry names retained while the storage format hard-cuts to WORKFLOW.md v2. */
export type WorkflowDescriptor = WorkflowDefinitionDescriptor;
export type WorkflowRegistryError = WorkflowDefinitionRegistryError;
export type WorkflowRegistryListing = WorkflowDefinitionRegistryListing;
export type WorkflowRegistryOptions = WorkflowDefinitionOptions;

export async function listSavedWorkflows(
  cwd: string,
  options: WorkflowRegistryOptions = {},
): Promise<WorkflowRegistryListing> {
  return await listWorkflowDefinitions(cwd, options);
}

export async function readSavedWorkflow(input: {
  cwd: string;
  selector: string;
  includeUser?: boolean;
  workspaceWorkflowDir?: string;
  userWorkflowDir?: string;
}): Promise<{
  descriptor: WorkflowDescriptor;
  script: string;
  definition: Awaited<ReturnType<typeof resolveWorkflowDefinition>>;
}> {
  const definition = await resolveWorkflowDefinition(input);
  return {
    descriptor: {
      selector: definition.selector,
      id: definition.id,
      source: definition.source,
      title: definition.title,
      description: definition.description,
      path: definition.path,
      stages: definition.stages.map((stage) => stage.id),
      phase: definition.phase,
      extends: definition.extends,
      skills: definition.skills,
      roles: definition.roles,
      workbench: definition.workbench,
      definitionDigest: definition.digest,
    },
    script: definition.script,
    definition,
  };
}

export * from "./types.ts";
export * from "./metadata.ts";
export * from "./runtime.ts";
export * from "./events.ts";
export * from "./task-resource-inventory.ts";
export * from "./builtins.ts";
export * from "./repro-builtins.ts";
export * from "./dynamic-workflow-run-store.ts";
export * from "./dynamic-workflow-event-store.ts";
export * from "./dynamic-workflow-manager.ts";
export * from "./orchestrator/index.ts";
