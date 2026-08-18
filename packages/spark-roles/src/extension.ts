import { ToolCallText } from "@zendev-lab/spark-text";
import type { ToolPolicy } from "@zendev-lab/spark-core";
import { Type } from "typebox";
import {
  createDefaultRoleRegistry,
  createRoleSpec,
  defaultProjectRoleModelSettingsStore,
  defaultProjectRoleStore,
  defaultUserRoleModelSettingsStore,
  defaultUserRoleStore,
  hydrateDefaultRoleRegistry,
  resolveRoleModelSetting,
  validateRoleModel,
  modelCatalogPortFromHostRegistry,
  ROLE_CAPABILITY_VOCAB,
  type RoleCapability,
  type ResolvedRoleModelSetting,
  type RoleModelSettingsEntry,
  type RoleModelSettingsSource,
  type RoleSource,
  type RoleSpec,
  type RoleSpecProposal,
  type WritableRoleSource,
} from "./role-runtime.ts";

export interface SparkRolesHostApi {
  registerTool(config: SparkRolesToolConfig): void;
}

interface SparkRolesToolConfig {
  name: string;
  label?: string;
  description: string;
  promptGuidelines?: string[];
  policy?: ToolPolicy;
  resolvePolicy?: (args: Readonly<Record<string, unknown>>) => ToolPolicy;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: {
      cwd?: string;
    },
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolCallComponent {
  render(width: number): string[];
}

export function registerSparkRolesTools(pi: SparkRolesHostApi): void {
  const roleActionTools = new Map<string, SparkRolesToolConfig>();
  const registerRoleActionTool = (config: SparkRolesToolConfig): void => {
    roleActionTools.set(config.name, config);
  };
  const registerPublicRoleTool = (config: SparkRolesToolConfig): void => {
    roleActionTools.set(config.name, config);
    pi.registerTool(config);
  };

  registerRoleActionTool({
    name: "list_roles",
    label: "List Roles",
    description: "List builtin, extension, project, and optionally user Pi role specs.",
    parameters: Type.Object({
      source: Type.Optional(
        Type.String({
          description: "builtin | extension | project | user. Omit to list all loaded roles.",
        }),
      ),
      includeUser: Type.Optional(
        Type.Boolean({
          description: "Also load user roles from ~/.agents/roles. Defaults to false.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum roles to show. Default: 50." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "list_roles",
        [
          formatStringArg(args.source, { fallback: "all" }),
          args.includeUser === true ? "include-user" : undefined,
          formatNumberArg(args.limit, { prefix: "limit=" }),
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredSparkRolesCwd(ctx, "list_roles");
      const includeUser = normalizeOptionalBoolean(
        params.includeUser,
        false,
        "list_roles includeUser",
      );
      const source = normalizeRoleSource(params.source, "list_roles source");
      const limit = normalizeLimit(params.limit, 50, "list_roles limit");
      const registry = createDefaultRoleRegistry();
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser });
      const roles = registry.list(source ? { source } : {}).slice(0, limit);
      const allCount = registry.list(source ? { source } : {}).length;
      const lines = roles.map(
        (role) => `- [${role.source}] ${role.id} (${role.ref}) — ${role.description}`,
      );
      if (allCount > roles.length) lines.push(`- … ${allCount - roles.length} more role(s)`);
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "No matching roles." }],
        details: {
          count: allCount,
          shown: roles.length,
          roles: roles.map(compactRole),
        },
      };
    },
  });

  registerRoleActionTool({
    name: "get_role",
    label: "Get Role",
    description: "Inspect one builtin, extension, project, or user Pi role spec.",
    parameters: Type.Object({
      role: Type.String({
        description: "Role id or full role ref, e.g. executor or role:builtin-executor.",
      }),
      includeUser: Type.Optional(
        Type.Boolean({
          description: "Also load user roles from ~/.agents/roles. Defaults to false.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "get_role",
        [formatStringArg(args.role), args.includeUser === true ? "include-user" : undefined],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredSparkRolesCwd(ctx, "get_role");
      const registry = createDefaultRoleRegistry();
      const includeUser = normalizeOptionalBoolean(
        params.includeUser,
        false,
        "get_role includeUser",
      );
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser });
      const role = registry.select(normalizeRequiredString(params.role, "get_role role"));
      const promptPreview = truncateInline(role.systemPrompt, 240);
      const effectiveModel = await resolveRoleModelForRole(cwd, role);
      const effectiveModelText = effectiveModel
        ? `${effectiveModel.model} (${effectiveModel.source}${effectiveModel.modelType ? ` modelType=${effectiveModel.modelType}` : ""})`
        : `not set; save one with role({ action: "model_set" }) before non-interactive runs`;
      const lines = [
        `${role.id} (${role.ref})`,
        `source: ${role.source}`,
        `description: ${role.description}`,
        `effectiveModel: ${effectiveModelText}`,
        `systemPrompt: ${role.systemPrompt.length} chars; preview=${JSON.stringify(promptPreview)}`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          role: { ...compactRole(role), effectiveModel },
        },
      };
    },
  });

  registerRoleActionTool({
    name: "create_role",
    label: "Create Role",
    description: "Create and persist a project or explicitly requested user Pi role spec.",
    parameters: Type.Object({
      id: Type.String({ description: "Stable role spec id." }),
      description: Type.String({ description: "What this role spec is for." }),
      systemPrompt: Type.String({ description: "Fixed system prompt for the role spec." }),
      rationale: Type.String({ description: "Why this role spec should exist." }),
      expectedUses: Type.Array(Type.String()),
      capabilities: Type.Array(
        Type.String({ description: "read | write | exec | net | interact | spawn" }),
      ),
      skills: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 8,
          description: "Ordered Skill names preloaded into each Role Session.",
        }),
      ),
      modelType: Type.String({ description: "Semantic model routing key." }),
      source: Type.Optional(Type.String({ description: "project | user. Defaults to project." })),
      allowedTools: Type.Optional(Type.Array(Type.String())),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "create_role",
        [
          formatStringArg(args.id, { prefix: "id=" }),
          formatStringArg(args.source, { fallback: "project" }),
          formatStringArg(args.description, { maxLength: 80 }),
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredSparkRolesCwd(ctx, "create_role");
      rejectRoleSpecModelFields(params, "create_role");
      const source = normalizeWritableRoleSource(params.source);
      const proposal: RoleSpecProposal = {
        id: normalizeRequiredString(params.id, "create_role id"),
        source,
        description: normalizeRequiredString(params.description, "create_role description"),
        systemPrompt: normalizeRequiredString(params.systemPrompt, "create_role systemPrompt"),
        rationale: normalizeRequiredString(params.rationale, "create_role rationale"),
        expectedUses: normalizeRequiredStringArray(params.expectedUses, "create_role expectedUses"),
        capabilities: normalizeRoleCapabilities(params.capabilities, "create_role capabilities"),
        skills: normalizeOptionalStringArray(params.skills, "create_role skills"),
        allowedTools: normalizeOptionalStringArray(params.allowedTools, "create_role allowedTools"),
        modelType: normalizeRequiredString(params.modelType, "create_role modelType"),
        origin: { kind: "manual" },
      };
      const role = createRoleSpec(proposal);
      const store = source === "user" ? defaultUserRoleStore() : defaultProjectRoleStore(cwd);
      await store.save(role);
      return {
        content: [
          { type: "text", text: `Role created: ${role.id} (${role.ref}) source=${role.source}` },
        ],
        details: { role: compactRole(role) },
      };
    },
  });

  registerRoleActionTool({
    name: "model_list_roles",
    label: "List Role Models",
    description: "List persisted project/user role model settings.",
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "project | user. Omit to list both." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "role_model_list",
        [formatStringArg(args.source, { prefix: "source=" })],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredSparkRolesCwd(ctx, "role model_list");
      const source = normalizeOptionalRoleModelSettingsSource(
        params.source,
        "role model_list source",
      );
      const entries = await loadRoleModelSettingEntries(cwd, source);
      const lines = entries.map(
        (entry) => `- [${entry.source}] ${entry.modelType} -> ${entry.model}`,
      );
      return {
        content: [
          { type: "text", text: lines.length ? lines.join("\n") : "No role model settings." },
        ],
        details: { count: entries.length, entries },
      };
    },
  });

  registerRoleActionTool({
    name: "model_get_role",
    label: "Get Role Model",
    description: "Resolve the effective model setting for one role.",
    parameters: Type.Object({
      role: Type.String({ description: "Role id or full role ref." }),
      includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
    }),
    renderCall(args, theme) {
      return renderToolCall("role_model_get", [formatStringArg(args.role)], theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredSparkRolesCwd(ctx, "role model_get");
      const role = await selectRoleForModelAction(cwd, params, "role model_get");
      const resolved = await resolveRoleModelForRole(cwd, role);
      const text = resolved
        ? `Role model for ${role.id} (${role.ref}) modelType=${role.modelType}: ${resolved.model} source=${resolved.source}`
        : `No model setting for type ${role.modelType} used by ${role.id} (${role.ref}).`;
      return {
        content: [{ type: "text", text }],
        details: { role: compactRole(role), model: resolved },
      };
    },
  });

  registerRoleActionTool({
    name: "model_set_role",
    label: "Set Role Model",
    description: "Validate and save a project/user role model setting.",
    parameters: Type.Object({
      role: Type.String({ description: "Role id or full role ref." }),
      model: Type.String({ description: "Concrete Pi model to validate and save." }),
      source: Type.Optional(Type.String({ description: "project | user. Defaults to project." })),
      includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "role_model_set",
        [formatStringArg(args.role), formatStringArg(args.source, { fallback: "project" })],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredSparkRolesCwd(ctx, "role model_set");
      const role = await selectRoleForModelAction(cwd, params, "role model_set");
      const model = normalizeRequiredString(params.model, "role model_set model");
      const catalog = modelCatalogPortFromHostRegistry(
        (ctx as { modelRegistry?: unknown }).modelRegistry,
      );
      if (!catalog) throw new Error("role model_set requires the host model catalog");
      await validateRoleModel({
        catalog,
        model,
      });
      const source = normalizeRoleModelSettingsSource(params.source, "role model_set source");
      const store = roleModelSettingsStoreForSource(cwd, source);
      const entry = await store.save(role.modelType, model);
      const text = `Saved ${source} model setting for type ${role.modelType}, used by ${role.id} (${role.ref}): ${entry.model}`;
      return {
        content: [{ type: "text", text }],
        details: { role: compactRole(role), setting: entry },
      };
    },
  });

  registerRoleActionTool({
    name: "model_delete_role",
    label: "Delete Role Model",
    description: "Delete project/user role model setting(s) for one role.",
    parameters: Type.Object({
      role: Type.String({ description: "Role id or full role ref." }),
      source: Type.Optional(Type.String({ description: "project | user. Defaults to project." })),
      includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "role_model_delete",
        [formatStringArg(args.role), formatStringArg(args.source, { fallback: "project" })],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredSparkRolesCwd(ctx, "role model_delete");
      const role = await selectRoleForModelAction(cwd, params, "role model_delete");
      const source = normalizeRoleModelSettingsSource(params.source, "role model_delete source");
      const store = roleModelSettingsStoreForSource(cwd, source);
      const deleted = (await store.delete(role.modelType)) ? [role.modelType] : [];
      const text = deleted.length
        ? `Deleted ${source} model setting for type ${role.modelType}`
        : `No ${source} model setting matched type ${role.modelType}.`;
      return {
        content: [{ type: "text", text }],
        details: { role: compactRole(role), source, deleted },
      };
    },
  });

  registerPublicRoleTool({
    name: "role",
    label: "Role",
    description:
      "Canonical static Role capability. Manage Role definitions and model settings; execution starts only after a Role-bound Session receives a request.",
    promptGuidelines: [
      "Create or select a static Role first, then use session spawn or fork with its exact RoleRef.",
      "Use session send with kind=request to trigger execution in the Role-bound Session.",
      "Use assign when work belongs to a Spark task and needs claims, run records, or evidence attribution.",
    ],
    policy: roleToolPolicy("read", ["plan", "execute", "fleet"]),
    resolvePolicy(args) {
      const action = typeof args.action === "string" ? args.action : "";
      return action === "list" ||
        action === "get" ||
        action === "model_list" ||
        action === "model_get"
        ? roleToolPolicy("read", ["plan", "execute", "fleet"])
        : roleToolPolicy("external_write", ["plan", "execute"]);
    },
    parameters: Type.Union([
      Type.Object(
        {
          action: Type.Literal("list"),
          source: Type.Optional(
            Type.String({
              description: "builtin | extension | project | user. Omit to list all loaded roles.",
            }),
          ),
          includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
          limit: Type.Optional(Type.Number({ description: "Maximum role rows for list." })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("get"),
          role: Type.String({ description: "Role id or full role ref." }),
          includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("create"),
          id: Type.String({ description: "Stable role id." }),
          description: Type.String({ description: "Role description." }),
          systemPrompt: Type.String({ description: "Fixed Role system prompt." }),
          rationale: Type.String({ description: "Why this Role should exist." }),
          expectedUses: Type.Array(Type.String()),
          capabilities: Type.Array(Type.String()),
          skills: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
          modelType: Type.String({
            description: "Semantic model routing key required by the persisted Role spec.",
          }),
          source: Type.Optional(
            Type.String({ description: "project | user. Defaults to project." }),
          ),
          allowedTools: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("model_list"),
          source: Type.Optional(Type.String({ description: "project | user. Omit to list both." })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("model_get"),
          role: Type.String({ description: "Role id or full role ref." }),
          includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("model_set"),
          role: Type.String({ description: "Role id or full role ref." }),
          model: Type.String({ description: "Concrete Pi model to validate and save." }),
          source: Type.Optional(
            Type.String({ description: "project | user. Defaults to project." }),
          ),
          includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("model_delete"),
          role: Type.String({ description: "Role id or full role ref." }),
          source: Type.Optional(
            Type.String({ description: "project | user. Defaults to project." }),
          ),
          includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
        },
        { additionalProperties: false },
      ),
    ]),
    renderCall(args, theme) {
      return renderToolCall(
        "role",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "?" }),
          formatStringArg(args.role),
          formatStringArg(args.id, { prefix: "id=" }),
        ],
        theme,
      );
    },
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeRoleAction(params.action);
      const target = roleToolNameForAction(action);
      const tool = roleActionTools.get(target);
      if (!tool) throw new Error(`role action adapter could not find ${target}`);
      return tool.execute(toolCallId, stripRoleAction(params), signal, onUpdate, ctx);
    },
  });
}

function roleToolPolicy(effect: "read" | "external_write", modes: readonly string[]): ToolPolicy {
  return {
    effect,
    executionMode: effect === "read" ? "parallel" : "sequential",
    domains: ["roles"],
    modes,
    approval: "none",
  };
}

type RoleAction =
  | "list"
  | "get"
  | "create"
  | "model_list"
  | "model_get"
  | "model_set"
  | "model_delete";

function normalizeRoleAction(value: unknown): RoleAction {
  if (
    value === "list" ||
    value === "get" ||
    value === "create" ||
    value === "model_list" ||
    value === "model_get" ||
    value === "model_set" ||
    value === "model_delete"
  )
    return value;
  throw new Error(
    "role.action must be list, get, create, model_list, model_get, model_set, or model_delete",
  );
}

function roleToolNameForAction(
  action: RoleAction,
):
  | "list_roles"
  | "get_role"
  | "create_role"
  | "model_list_roles"
  | "model_get_role"
  | "model_set_role"
  | "model_delete_role" {
  if (action === "list") return "list_roles";
  if (action === "get") return "get_role";
  if (action === "create") return "create_role";
  if (action === "model_list") return "model_list_roles";
  if (action === "model_get") return "model_get_role";
  if (action === "model_set") return "model_set_role";
  return "model_delete_role";
}

function stripRoleAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}

async function selectRoleForModelAction(
  cwd: string,
  params: Record<string, unknown>,
  fieldPrefix: string,
): Promise<RoleSpec> {
  const registry = createDefaultRoleRegistry();
  const includeUser = normalizeOptionalBoolean(
    params.includeUser,
    false,
    `${fieldPrefix} includeUser`,
  );
  await hydrateDefaultRoleRegistry(registry, cwd, { includeUser });
  return registry.select(normalizeRequiredString(params.role, `${fieldPrefix} role`));
}

async function loadRoleModelSettingEntries(
  cwd: string,
  source: RoleModelSettingsSource | undefined,
): Promise<RoleModelSettingsEntry[]> {
  const stores = source
    ? [roleModelSettingsStoreForSource(cwd, source)]
    : [defaultProjectRoleModelSettingsStore(cwd), defaultUserRoleModelSettingsStore()];
  const entries = await Promise.all(stores.map((store) => store.loadAll()));
  return entries.flat();
}

function roleModelSettingsStoreForSource(cwd: string, source: RoleModelSettingsSource) {
  return source === "project"
    ? defaultProjectRoleModelSettingsStore(cwd)
    : defaultUserRoleModelSettingsStore();
}

async function resolveRoleModelForRole(
  cwd: string,
  role: RoleSpec,
): Promise<ResolvedRoleModelSetting | undefined> {
  return resolveRoleModelSetting({
    roleRef: role.ref,
    modelType: role.modelType,
    roleId: role.id,
    roleName: role.id,
    projectStore: defaultProjectRoleModelSettingsStore(cwd),
    userStore: defaultUserRoleModelSettingsStore(),
  });
}

function normalizeRoleModelSettingsSource(value: unknown, field: string): RoleModelSettingsSource {
  const source = normalizeOptionalRoleModelSettingsSource(value, field) ?? "project";
  return source;
}

function normalizeOptionalRoleModelSettingsSource(
  value: unknown,
  field: string,
): RoleModelSettingsSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "project" || value === "user") return value;
  throw new Error(`${field} must be project or user`);
}

function rejectRoleSpecModelFields(params: Record<string, unknown>, toolName: string): void {
  for (const field of ["defaultModel", "model"]) {
    if (Object.hasOwn(params, field))
      throw new Error(`${toolName} ${field} is not supported; use role model settings`);
  }
}

function requiredSparkRolesCwd(ctx: { cwd?: string }, toolName: string): string {
  if (typeof ctx.cwd === "string" && ctx.cwd.trim()) return ctx.cwd;
  throw new Error(`${toolName} requires ctx.cwd or an explicit cwd parameter.`);
}

function normalizeRoleSource(value: unknown, field: string): RoleSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "builtin" || value === "extension" || value === "project" || value === "user")
    return value;
  throw new Error(`${field} must be builtin, extension, project, or user`);
}

function normalizeWritableRoleSource(value: unknown): WritableRoleSource {
  if (value === undefined || value === null) return "project";
  if (value === "user") return "user";
  if (value === "project") return "project";
  throw new Error("create_role source must be project or user");
}

function normalizeLimit(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function normalizeOptionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${field} must be a boolean`);
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (value === undefined || value === null) throw new Error(`${field} is required`);
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  return text;
}

function normalizeRequiredStringArray(value: unknown, field: string): string[] {
  const items = normalizeOptionalStringArray(value, field) ?? [];
  if (items.length === 0) throw new Error(`${field} must be a non-empty array of strings`);
  return items;
}

function normalizeOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  const items = value.map((item) => {
    if (typeof item !== "string") throw new Error(`${field} must be an array of strings`);
    return item.trim();
  });
  if (items.some((item) => !item))
    throw new Error(`${field} must be an array of non-empty strings`);
  return items.length > 0 ? items : undefined;
}

function compactRole(role: RoleSpec) {
  return {
    ref: role.ref,
    id: role.id,
    source: role.source,
    revision: role.revision,
    description: role.description,
    capabilities: role.capabilities,
    skills: role.skills,
    modelType: role.modelType,
    systemPromptChars: role.systemPrompt.length,
    allowedTools: role.allowedTools,
  };
}

function normalizeRoleCapabilities(value: unknown, field: string): RoleCapability[] {
  const values = normalizeRequiredStringArray(value, field);
  const vocabulary = new Set<string>(ROLE_CAPABILITY_VOCAB);
  for (const capability of values) {
    if (!vocabulary.has(capability)) throw new Error(`${field} contains unknown ${capability}`);
  }
  return values as RoleCapability[];
}

const TOOL_CALL_DEFAULT_ARG_MAX_LENGTH = 80;

function renderToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: ToolCallRenderTheme,
): ToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const args = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new ToolCallText(`${title}${args}`.trimEnd());
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = /\s|["'`]/.test(text) ? JSON.stringify(text) : text;
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? TOOL_CALL_DEFAULT_ARG_MAX_LENGTH)}`;
}

function formatNumberArg(value: unknown, options: { prefix?: string } = {}): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${options.prefix ?? ""}${value}`;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export default function piRolesExtension(pi: SparkRolesHostApi): void {
  registerSparkRolesTools(pi);
}
