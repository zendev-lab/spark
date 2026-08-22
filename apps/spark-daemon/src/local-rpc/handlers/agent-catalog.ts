import {
  createDefaultRoleRegistry,
  createRoleSpec,
  defaultProjectRoleStore,
  hydrateDefaultRoleRegistry,
  type RoleSpec,
} from "@zendev-lab/spark-roles";
import { SparkSkillResolver, type SparkSkill } from "@zendev-lab/spark-roles/skill-resolver";
import type { SparkRoleCatalogEntry, SparkSkillCatalogEntry } from "@zendev-lab/spark-protocol";

import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type AgentCatalogRequest = Extract<
  LocalRpcServiceRequest,
  { method: "role.list" | "role.create" | "skill.list" }
>;

export async function handleAgentCatalogRequest(
  context: LocalRpcDispatchContext,
  request: AgentCatalogRequest,
): Promise<LocalRpcServiceOutput<AgentCatalogRequest>> {
  const workspaceRoot = resolveWorkspaceLocalPath(context.db, request.params.workspaceId);
  if (!workspaceRoot) {
    throw new SparkDaemonControlError(
      "workspace_not_found",
      `Workspace ${request.params.workspaceId} is not registered on this daemon.`,
    );
  }

  if (request.method === "skill.list") {
    const result = await new SparkSkillResolver({ cwd: workspaceRoot }).resolve({
      includeRepository: true,
    });
    return {
      workspaceId: request.params.workspaceId,
      skills: result.skills.map(skillEntry),
    };
  }

  const registry = createDefaultRoleRegistry();
  await hydrateDefaultRoleRegistry(registry, workspaceRoot, { includeUser: true });
  if (request.method === "role.list") {
    return {
      workspaceId: request.params.workspaceId,
      roles: registry.list().map(roleEntry),
    };
  }
  const existing = registry.list().find((role) => role.id === request.params.id);
  if (existing) {
    return { workspaceId: request.params.workspaceId, created: false, role: roleEntry(existing) };
  }
  const role = createRoleSpec({
    id: request.params.id,
    source: "project",
    description: request.params.description,
    systemPrompt: request.params.systemPrompt,
    capabilities: request.params.capabilities,
    ...(request.params.skills ? { skills: request.params.skills } : {}),
    ...(request.params.allowedTools ? { allowedTools: request.params.allowedTools } : {}),
    ...(request.params.allowedToolEffects
      ? { allowedToolEffects: request.params.allowedToolEffects }
      : {}),
    modelType: request.params.modelType,
    origin: { kind: "manual", note: "Created through Spark daemon Role control" },
    rationale: "Explicit user request through a trusted local control surface.",
    expectedUses: [],
  });
  const store = defaultProjectRoleStore(workspaceRoot);
  if (!(await store.saveIfAbsent(role))) {
    const winner = (await store.loadAll()).find((candidate) => candidate.id === role.id);
    if (!winner) {
      throw new Error(`Role ${role.id} already exists but is not a valid Spark project Role.`);
    }
    return { workspaceId: request.params.workspaceId, created: false, role: roleEntry(winner) };
  }
  return { workspaceId: request.params.workspaceId, created: true, role: roleEntry(role) };
}

function roleEntry(role: RoleSpec): SparkRoleCatalogEntry {
  const { systemPrompt: _systemPrompt, origin, ...entry } = role;
  return {
    ...entry,
    ...(origin
      ? { origin: { kind: origin.kind, ...(origin.note ? { note: origin.note } : {}) } }
      : {}),
  };
}

function skillEntry(skill: SparkSkill): SparkSkillCatalogEntry {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.title ? { title: skill.title } : {}),
    layer: skill.layer,
    disableModelInvocation: skill.disableModelInvocation,
  };
}
