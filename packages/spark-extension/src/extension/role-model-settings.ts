import {
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  resolveRoleModelSetting,
  validateRoleModel,
  modelCatalogPortFromHostRegistry,
  type ModelCatalogPort,
  type ResolvedRoleModelSetting,
  type RoleRegistry,
  type RoleSpec,
} from "@zendev-lab/spark-roles";
import type { RoleRef, ProjectRef } from "@zendev-lab/spark-core";
import { sparkTaskExecutorRoleRef } from "@zendev-lab/spark-runtime";
import type { TaskGraph } from "@zendev-lab/spark-tasks";

export interface RoleModelSettingsPreflightResult {
  ready: boolean;
  message: string;
  checkedRoleRefs: RoleRef[];
  boundRoleRefs: RoleRef[];
  missingRoleRefs: RoleRef[];
  inheritedRoleRefs?: RoleRef[];
  error?: string;
}

interface RoleModelSettingsContext {
  model?: { provider?: unknown; id?: unknown };
  modelRegistry?: unknown;
  ui?: {
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
  };
}

export async function ensureRoleModelSettingsForProject(input: {
  graph: TaskGraph;
  projectRef: ProjectRef;
  registry: RoleRegistry;
  cwd: string;
  ctx: RoleModelSettingsContext;
  modelCatalog?: ModelCatalogPort;
}): Promise<RoleModelSettingsPreflightResult> {
  const modelCatalog =
    input.modelCatalog ?? modelCatalogPortFromHostRegistry(input.ctx.modelRegistry);
  const roleRefs = uniqueRoleRefs(
    input.graph.readyTasks(input.projectRef).map((task) => sparkTaskExecutorRoleRef(task)),
  );
  const projectStore = defaultProjectRoleModelSettingsStore(input.cwd);
  const userStore = defaultUserRoleModelSettingsStore();
  const boundRoleRefs: RoleRef[] = [];
  const missingRoleRefs: RoleRef[] = [];
  const inheritedRoleRefs: RoleRef[] = [];
  const resolvedModels: Array<{ roleRef: RoleRef; model: ResolvedRoleModelSetting }> = [];
  for (const roleRef of roleRefs) {
    const role = input.registry.get(roleRef) as RoleSpec;
    const existing = await resolveRoleModelSetting({
      roleRef,
      modelType: role.modelType,
      roleId: role.id,
      roleName: role.id,
      projectStore,
      userStore,
    });
    if (existing) {
      boundRoleRefs.push(roleRef);
      resolvedModels.push({ roleRef, model: existing });
      continue;
    }

    // Fail closed without model_set / ask / UI picker. Host session model may
    // cover admission only when it is already a concrete provider/model string.
    const hostModel =
      typeof input.ctx.model?.provider === "string" && typeof input.ctx.model?.id === "string"
        ? `${input.ctx.model.provider.trim()}/${input.ctx.model.id.trim()}`
        : undefined;
    if (hostModel && hostModel.includes("/")) {
      try {
        if (modelCatalog) await validateRoleModel({ catalog: modelCatalog, model: hostModel });
        boundRoleRefs.push(roleRef);
        inheritedRoleRefs.push(roleRef);
        resolvedModels.push({
          roleRef,
          model: {
            model: hostModel,
            source: "explicit",
            modelType: role.modelType,
          },
        });
        continue;
      } catch {
        // fall through to missing
      }
    }
    missingRoleRefs.push(roleRef);
  }
  if (missingRoleRefs.length > 0) {
    const visibleMissingRoleRefs = missingRoleRefs.slice(0, 8);
    const hiddenMissingRoleRefs = missingRoleRefs.length - visibleMissingRoleRefs.length;
    return {
      ready: false,
      message: `MODEL_RESOLUTION_UNAVAILABLE: Spark Role Model Type is unconfigured before dispatch: ${visibleMissingRoleRefs.join(", ")}${hiddenMissingRoleRefs > 0 ? `, … ${hiddenMissingRoleRefs} more` : ""}. Configure project/role/host model settings before assign; dispatch never prompts for model_set, ask, or picker.`,
      checkedRoleRefs: roleRefs,
      boundRoleRefs,
      missingRoleRefs,
      inheritedRoleRefs,
      error: "MODEL_RESOLUTION_UNAVAILABLE",
    };
  }
  return {
    ready: true,
    message: renderRoleModelSettingsReadyMessage(boundRoleRefs, inheritedRoleRefs, resolvedModels),
    checkedRoleRefs: roleRefs,
    boundRoleRefs,
    missingRoleRefs: [],
    inheritedRoleRefs,
  };
}

function renderRoleModelSettingsReadyMessage(
  boundRoleRefs: RoleRef[],
  inheritedRoleRefs: RoleRef[],
  resolvedModels: Array<{ roleRef: RoleRef; model: ResolvedRoleModelSetting }>,
): string {
  const saved = resolvedModels.map(
    ({ roleRef, model }) => `${roleRef}=${model.model} (${model.source})`,
  );
  const total = boundRoleRefs.length + inheritedRoleRefs.length;
  const labels = [...saved];
  const visibleLabels = labels.slice(0, 8);
  const hiddenLabels = labels.length - visibleLabels.length;
  return `Spark role models ready for ${total} role(s): ${visibleLabels.join(", ")}${hiddenLabels > 0 ? `, … ${hiddenLabels} more` : ""}.`;
}

function uniqueRoleRefs(roleRefs: RoleRef[]): RoleRef[] {
  return [...new Set(roleRefs)].sort((a, b) => a.localeCompare(b));
}
