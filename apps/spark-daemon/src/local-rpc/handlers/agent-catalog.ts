import {
  createDefaultRoleRegistry,
  createRoleSpec,
  defaultProjectRoleModelSettingsStore,
  defaultProjectRoleStore,
  defaultUserRoleModelSettingsStore,
  hydrateDefaultRoleRegistry,
  resolveRoleModelSetting,
  type RoleModelSettingsSource,
  type RoleSpec,
} from "@zendev-lab/spark-roles";
import { SparkSkillResolver, type SparkSkill } from "@zendev-lab/spark-roles/skill-resolver";
import type { SparkRoleCatalogEntry, SparkSkillCatalogEntry } from "@zendev-lab/spark-protocol";

import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
import { requireModelControl } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type AgentCatalogRequest = Extract<
  LocalRpcServiceRequest,
  {
    method:
      | "role.list"
      | "role.create"
      | "role.model.list"
      | "role.model.get"
      | "role.model.set"
      | "role.model.delete"
      | "skill.list";
  }
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
  if (request.method === "role.model.list") {
    const stores = roleModelStores(workspaceRoot, request.params.source);
    const entries = (await Promise.all(stores.map((store) => store.loadAll()))).flat();
    return { workspaceId: request.params.workspaceId, entries };
  }

  if (
    request.method === "role.model.get" ||
    request.method === "role.model.set" ||
    request.method === "role.model.delete"
  ) {
    const role = registry.has(request.params.roleRef)
      ? registry.get(request.params.roleRef)
      : undefined;
    if (!role) {
      if (request.method === "role.model.get") {
        return { workspaceId: request.params.workspaceId, role: null, setting: null };
      }
      throw new SparkDaemonControlError(
        "role_not_found",
        `Role ${request.params.roleRef} is not available in workspace ${request.params.workspaceId}.`,
      );
    }
    if (request.method === "role.model.get") {
      const setting = await resolveRoleModelSetting({
        roleRef: role.ref,
        roleId: role.id,
        modelType: role.modelType,
        projectStore: defaultProjectRoleModelSettingsStore(workspaceRoot),
        userStore: defaultUserRoleModelSettingsStore(),
      });
      return {
        workspaceId: request.params.workspaceId,
        role: roleEntry(role),
        setting:
          setting?.modelType && (setting.source === "project" || setting.source === "user")
            ? { modelType: setting.modelType, model: setting.model, source: setting.source }
            : null,
      };
    }
    const store = roleModelStore(workspaceRoot, request.params.source);
    if (request.method === "role.model.delete") {
      return {
        workspaceId: request.params.workspaceId,
        role: roleEntry(role),
        source: request.params.source,
        deleted: await store.delete(role.modelType),
      };
    }
    await validateAvailableRoleModel(context, request.params.model);
    return {
      workspaceId: request.params.workspaceId,
      role: roleEntry(role),
      setting: await store.save(role.modelType, request.params.model),
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

function roleModelStore(workspaceRoot: string, source: RoleModelSettingsSource) {
  return source === "project"
    ? defaultProjectRoleModelSettingsStore(workspaceRoot)
    : defaultUserRoleModelSettingsStore();
}

function roleModelStores(workspaceRoot: string, source?: RoleModelSettingsSource) {
  return source
    ? [roleModelStore(workspaceRoot, source)]
    : [defaultProjectRoleModelSettingsStore(workspaceRoot), defaultUserRoleModelSettingsStore()];
}

async function validateAvailableRoleModel(
  context: LocalRpcDispatchContext,
  model: string,
): Promise<void> {
  const snapshot = await requireModelControl(context.options).snapshot();
  const entry = snapshot.providers
    .flatMap((provider) => provider.models)
    .find((candidate) => `${candidate.model.providerName}/${candidate.model.modelId}` === model);
  if (!entry) {
    throw new SparkDaemonControlError("model_not_found", `Unknown role model ${model}.`);
  }
  if (!entry.available) {
    throw new SparkDaemonControlError(
      "model_unavailable",
      `Role model ${model} is unavailable: ${entry.unavailableReason ?? "authentication required"}.`,
    );
  }
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
