import type { ChildProcess } from "node:child_process";
import {
  contentHash,
  stableId,
  writeTextFileAtomic,
  type EvidenceRef,
  type ExtensionRoleRunInputController,
  type ExtensionRoleRunner,
  type RoleRunCompletionOutcome,
  type ToolEffect,
} from "@zendev-lab/spark-core";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolveRoleNativeExecutor } from "./native-executor.ts";
import { dirname, extname, join, relative, sep } from "node:path";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import {
  sparkRoleModelTypeSchema,
  sparkRoleOriginSchema,
  type SparkRoleCapability,
  type SparkRoleModelType,
  type SparkRoleSource,
} from "@zendev-lab/spark-protocol/role-session";

export type RoleSource = SparkRoleSource;
export type WritableRoleSource = "project" | "user";
export type RoleOriginKind = "manual" | "generated" | "builtin" | "extension";
export type RoleRef = `role:${string}`;
export type RoleRunRef = `run:${string}`;
export type RoleLaunchMode = "fresh" | "forked";
export type RoleThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const ROLE_RUN_DEPTH_ENV = "PI_ROLE_DEPTH";
export const DEFAULT_ROLE_RUN_DEPTH = 4;

export interface RoleOrigin {
  kind: RoleOriginKind;
  sourcePath?: string;
  note?: string;
}

export interface RoleSpec {
  ref: RoleRef;
  /** Content revision pinned by each Invocation at start. */
  revision: string;
  id: string;
  source: RoleSource;
  description: string;
  systemPrompt: string;
  capabilities: RoleCapability[];
  allowedTools?: string[];
  allowedToolEffects?: ToolEffect[];
  modelType: SparkRoleModelType;
  origin?: RoleOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSpecProposal {
  evidenceRef?: string;
  id: string;
  source?: WritableRoleSource;
  description: string;
  systemPrompt: string;
  rationale: string;
  expectedUses: string[];
  capabilities: RoleCapability[];
  allowedTools?: string[];
  allowedToolEffects?: ToolEffect[];
  modelType: SparkRoleModelType;
  origin?: RoleOrigin;
}

export interface RoleInstruction {
  roleRef: RoleRef;
  instruction: string;
  inputs?: string[];
}

export type RoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";
export type RoleRunInputControl = "stdin" | "native" | "none";

export interface RoleRunRecord {
  ref: RoleRunRef;
  roleRef: RoleRef;
  /** RoleSpec content revision frozen when this Invocation started. */
  roleRevision: string;
  /** Human-readable name for this concrete role run; roleRef remains the reusable definition. */
  runName?: string;
  instruction: string;
  status: RoleRunStatus;
  outcome?: RoleRunCompletionOutcome;
  outputEvidenceRef?: EvidenceRef;
  startedAt?: string;
  finishedAt?: string;
}

export interface RoleRunRequest {
  roleRef: RoleRef;
  roleRevision?: string;
  instruction: string;
  /** Human-readable name for this concrete run, used by task/workflow observability. */
  runName?: string;
  launch?: RoleLaunchMode;
  systemPrompt?: string;
  /** Concrete Spark provider/model to use for this run (usually current session model). */
  model?: string;
  /** Optional role thinking/reasoning level. */
  thinking?: RoleThinkingLevel;
  /** Optional role tool allowlist. Hosts/presets own which tools are appropriate. */
  allowedTools?: string[];
  /** Runtime-enforced effect ceiling; omitted only for user-defined Roles. */
  allowedToolEffects?: ToolEffect[];
  /** Disable extension discovery for compatibility adapters. Useful for self-contained verifier gates. */
  noExtensions?: boolean;
  sessionDir?: string;
  forkFromSession?: string;
  /** Adapter-specific guidance appended between the role prompt and instruction. */
  runGuidance?: string;
}

export interface RoleRunCommandInput extends RoleRunRequest {
  systemPrompt: string;
}

export interface ModelCatalogEntry {
  providerName: string;
  modelId: string;
  available: boolean;
  unavailableReason?: string;
}

/**
 * Host-neutral model catalog boundary used by role configuration. Native hosts
 * adapt their daemon-backed catalog to this port; role code never shells out
 * to a product executable to discover models.
 */
export interface ModelCatalogPort {
  lookup(model: string): Promise<ModelCatalogEntry | undefined>;
}

export interface RoleRunLauncherInput extends RoleRunCommandInput {
  runRef: RoleRunRef;
  cwd: string;
  phase?: "plan" | "implement";
  requireStructuredOutcome?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => string;
  env?: NodeJS.ProcessEnv;
  /**
   * Legacy process-backed role runs pass the prompt through argv and should not
   * keep a stdin pipe open, because Pi --print may wait for stdin EOF when
   * stdin is a pipe. Interactive/background adapters can keep the default pipe
   * for best-effort follow-up delivery.
   */
  stdinMode?: "pipe" | "ignore";
  roleId?: string;
  roleSource?: RoleSource;
  roleCapabilities?: RoleCapability[];
  roleModelType?: SparkRoleModelType;
  /** Preserve workflow-vs-role accounting across the native executor boundary. */
  usageExecutionKind?: "role_run" | "workflow_agent";
  /** Reviewer-only authority for typed native executor compatibility recovery. */
  nativeCompatibilityRecovery?: "reviewer";
  nativeExecutor?: ExtensionRoleRunner;
  onEvent?: (event: unknown) => void | Promise<void>;
  onTimeout?: () => void;
}

export interface RoleRunResult {
  record: RoleRunRecord & {
    model?: string;
    thinking?: RoleThinkingLevel;
    failureKind?: string;
    errorMessage?: string;
  };
  outcome?: RoleRunCompletionOutcome;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface ActiveRoleRun {
  ref: RoleRunRef;
  roleRef: RoleRef;
  runName?: string;
  launch: RoleLaunchMode;
  model?: string;
  pid?: number;
  cwd: string;
  child?: ChildProcess;
  startedAt: string;
  timedOutAt?: string;
  inputControl: RoleRunInputControl;
  cancel(reason?: string): boolean;
}

export interface RoleRunInputDeliveryResult {
  ref: RoleRunRef;
  roleRef: RoleRef;
  runName?: string;
  launch: RoleLaunchMode;
  model?: string;
  pid?: number;
  cwd: string;
  startedAt: string;
  timedOutAt?: string;
  inputControl: RoleRunInputControl;
  bytes: number;
  delivered: boolean;
  errorMessage?: string;
}

export const builtinRoleIds = ["administrator", "explorer", "executor", "reviewer"] as const;
export type BuiltinRoleId = (typeof builtinRoleIds)[number];
type CanonicalBuiltinRoleId = BuiltinRoleId;

export const ROLE_CAPABILITY_VOCAB = [
  "read",
  "write",
  "exec",
  "net",
  "interact",
  "manage",
  "spawn",
] as const;
export type RoleCapability = (typeof ROLE_CAPABILITY_VOCAB)[number];

export const BUILTIN_ROLE_CAPABILITY_PROFILES = {
  administrator: ["read", "interact", "manage", "spawn"],
  explorer: ["read", "net"],
  executor: ["read", "net", "exec", "write"],
  reviewer: ["read", "net"],
} as const satisfies Record<BuiltinRoleId, readonly RoleCapability[]>;

export interface DefaultRoleRegistryOptions {
  now?: string;
}

const ROLE_READ_TOOLS = ["read", "grep", "find", "context"] as const;
const ROLE_NET_TOOLS = [
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
] as const;
const ROLE_EXECUTION_TOOLS = [
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
  "cue_jobs",
] as const;
const ROLE_WRITE_TOOLS = ["edit", "write"] as const;

const ROLE_TOOLS_BY_CAPABILITY = {
  read: ROLE_READ_TOOLS,
  write: ROLE_WRITE_TOOLS,
  exec: ROLE_EXECUTION_TOOLS,
  net: ROLE_NET_TOOLS,
  interact: ["ask"],
  manage: ["session", "task_read", "task_write", "goal", "workflow", "repro"],
  spawn: ["role", "assign", "delegation"],
} as const satisfies Record<RoleCapability, readonly string[]>;

const FORBIDDEN_BUILTIN_ROLE_TOOLS = new Set([
  "ask",
  "ask_user",
  "ask_flow",
  "task",
  "task_read",
  "task_write",
  "goal",
  "role",
  "assign",
  "workflow",
  "graft_patch",
]);

const ROLE_FRONTMATTER_KEYS = new Set([
  "id",
  "name",
  "description",
  "source",
  "revision",
  "allowedTools",
  "allowedToolEffects",
  "tools",
  "origin",
  "capabilities",
  "modelType",
  "createdAt",
  "updatedAt",
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function roleRefId(ref: string): string {
  const index = ref.indexOf(":");
  if (index < 0) return ref;
  return ref.slice(index + 1);
}

export function roleIdFromRef(ref: string): string {
  return roleRefId(normalizeRoleRef(ref)).replace(/^(builtin-|extension-|project-|user-)/, "");
}

export function builtinRoleRef(id: BuiltinRoleId): RoleRef {
  return `role:builtin-${canonicalBuiltinRoleId(id)}`;
}

export function normalizeRoleRef(value: string): RoleRef {
  if (/^(?:role:)?builtin-(?:scout|researcher|worker)$/u.test(value)) {
    throw new Error(`retired builtin role ref is not supported after registry v6: ${value}`);
  }
  if (value.startsWith("role:")) return value as RoleRef;
  if (value.startsWith("agent:"))
    throw new Error("legacy agent refs are not supported; use role:*");
  return `role:${value}` as RoleRef;
}

export function normalizeRoleSource(value: unknown): RoleSource | undefined {
  if (value === "builtin") return "builtin";
  if (value === "extension") return "extension";
  if (value === "project") return "project";
  if (value === "user") return "user";
  return undefined;
}

export function createBuiltinRoles(now = nowIso()): RoleSpec[] {
  const roles = [
    builtin(
      "administrator",
      "Owns Workspace coordination, delegation, monitoring, acceptance, and escalation decisions.",
      "You are the Spark Workspace Administrator. You manage work; you do not execute implementation or investigation yourself. Clarify intent, decompose work, select and instantiate suitable Roles, create and supervise Tasks, Sessions, Workflows, and delegations, monitor durable state and produced Artifacts or Evidence, request user decisions with Ask when authority or intent is missing, and independently arrange review before accepting completion. Never write files, execute commands, browse the network, or claim implementation findings from your own unsupported inference. Delegate fact gathering to Explorer, approved changes to Executor, and acceptance to Reviewer. Keep ownership, blockers, decisions, and next actions explicit; escalate to the user when a required decision cannot be safely delegated.",
      now,
    ),
    builtin(
      "explorer",
      "Obtains local and external facts without mutating state.",
      "You are a Spark Explorer. Establish facts from repository source and authoritative external sources. You may read and browse, but you cannot execute commands, write files, change repository or external state, ask the user, or delegate further work. Report concrete sources, paths, symbols, and observations; distinguish facts, inferences, and unresolved gaps. Return blockers and the exact decision needed to the supervising Administrator.",
      now,
    ),
    builtin(
      "executor",
      "Executes approved implementation tasks.",
      "You are a Spark Executor. Implement only the approved instruction within the supplied owner, workspace, cwd, GitChange, and tool boundaries. Read, browse, execute, and write only as needed for that implementation; verify the result proportionally and preserve unrelated work. Do not ask the user or delegate further work. If required information, authority, or a safe execution path is missing, stop and return the blocker, evidence, and exact decision needed to the supervising Administrator.",
      now,
    ),
    builtin(
      "reviewer",
      "Independently verifies outcomes, Evidence, and Artifacts against intent and policy.",
      "You are a Spark Reviewer. Independently verify claims from fresh context using reads and authoritative network sources. You cannot execute commands, write files, mutate external state, ask the user, or delegate further work. Return prioritized actionable findings and an explicit accept or reject recommendation. When intent or evidence is ambiguous, reject with concrete blockers and the exact decision needed by the supervising Administrator.",
      now,
    ),
  ];
  validateBuiltinRoleProfiles(roles);
  return roles;
}

export function createDefaultRoleRegistry(options: DefaultRoleRegistryOptions = {}): RoleRegistry {
  const now = options.now ?? nowIso();
  return new RoleRegistry(createBuiltinRoles(now));
}

const extensionRoles = new Map<RoleRef, RoleSpec>();

export function createExtensionRoleSpec(
  input: {
    id: string;
    description: string;
    systemPrompt: string;
    capabilities: RoleCapability[];
    allowedTools?: string[];
    allowedToolEffects?: ToolEffect[];
    modelType: SparkRoleModelType;
    origin?: RoleOrigin;
  },
  now = nowIso(),
): RoleSpec {
  const role: RoleSpec = {
    ref: createRoleRef("extension", input.id),
    revision: roleRevision(input),
    id: input.id,
    source: "extension",
    description: input.description,
    systemPrompt: input.systemPrompt,
    capabilities: input.capabilities,
    allowedTools: input.allowedTools,
    allowedToolEffects: input.allowedToolEffects,
    modelType: input.modelType,
    origin: input.origin ?? { kind: "extension" },
    createdAt: now,
    updatedAt: now,
  };
  validateRoleSpec(role);
  return role;
}

export function registerExtensionRole(role: RoleSpec): void {
  validateRoleSpec(role);
  if (role.source !== "extension")
    throw new Error(`extension role registry only accepts extension roles, got ${role.source}`);
  extensionRoles.set(role.ref, role);
}

export function listExtensionRoles(): RoleSpec[] {
  return [...extensionRoles.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function hydrateExtensionRoles(registry: RoleRegistry): void {
  for (const role of listExtensionRoles()) registry.add(role);
}

export function builtinRoleAllowedTools(id: BuiltinRoleId): string[] {
  const canonicalId = canonicalBuiltinRoleId(id);
  return uniqueStrings(
    BUILTIN_ROLE_CAPABILITY_PROFILES[canonicalId].flatMap(
      (capability) => ROLE_TOOLS_BY_CAPABILITY[capability],
    ),
  );
}

export function builtinRoleAllowedToolEffects(id: BuiltinRoleId): ToolEffect[] {
  if (id === "administrator") return ["read", "local_write", "external_write"];
  if (id === "executor") return ["read", "network_read", "local_write", "external_write"];
  return ["read", "network_read"];
}

export function validateBuiltinRoleProfiles(roles: readonly RoleSpec[]): void {
  if (ROLE_CAPABILITY_VOCAB.includes("record" as RoleCapability))
    throw new Error("builtin role capability vocab must not include record");
  const vocabulary = new Set<RoleCapability>(ROLE_CAPABILITY_VOCAB);
  for (const id of builtinRoleIds) {
    const profile = BUILTIN_ROLE_CAPABILITY_PROFILES[id];
    for (const capability of profile) {
      if (!vocabulary.has(capability))
        throw new Error(`builtin role ${id} declares unknown capability ${capability}`);
    }
    const profileCapabilities: readonly RoleCapability[] = profile;
    if (
      id !== "administrator" &&
      (profileCapabilities.includes("interact") || profileCapabilities.includes("spawn"))
    )
      throw new Error(`builtin role ${id} must not include interact or spawn capability`);
  }

  const rolesById = new Map(roles.map((role) => [role.id, role]));
  for (const id of builtinRoleIds) {
    const role = rolesById.get(id);
    if (!role) throw new Error(`missing builtin role ${id}`);
    const expectedTools = builtinRoleAllowedTools(id);
    const actualTools = role.allowedTools ?? [];
    if (!sameStrings(actualTools, expectedTools))
      throw new Error(
        `builtin role ${id} allowedTools must match its capability profile: expected ${expectedTools.join(",")}, got ${actualTools.join(",")}`,
      );
    for (const tool of actualTools) {
      if (id !== "administrator" && FORBIDDEN_BUILTIN_ROLE_TOOLS.has(tool))
        throw new Error(`builtin role ${id} must not include forbidden tool ${tool}`);
    }
  }
}

function assertCapabilitySubset(left: CanonicalBuiltinRoleId, right: CanonicalBuiltinRoleId): void {
  const rightCapabilities = new Set<RoleCapability>(BUILTIN_ROLE_CAPABILITY_PROFILES[right]);
  for (const capability of BUILTIN_ROLE_CAPABILITY_PROFILES[left]) {
    if (!rightCapabilities.has(capability))
      throw new Error(`builtin role capability profile ${left} must be a subset of ${right}`);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function builtin(
  id: CanonicalBuiltinRoleId,
  description: string,
  systemPrompt: string,
  now: string,
): RoleSpec {
  const allowedTools = builtinRoleAllowedTools(id);
  const allowedToolEffects = builtinRoleAllowedToolEffects(id);
  return {
    ref: builtinRoleRef(id),
    revision: roleRevision({
      id,
      description,
      systemPrompt,
      capabilities: [...BUILTIN_ROLE_CAPABILITY_PROFILES[id]],
      allowedTools,
      allowedToolEffects,
      modelType: builtinRoleModelType(id),
    }),
    id,
    source: "builtin",
    description,
    systemPrompt,
    capabilities: [...BUILTIN_ROLE_CAPABILITY_PROFILES[id]],
    allowedTools,
    allowedToolEffects,
    modelType: builtinRoleModelType(id),
    origin: { kind: "builtin" },
    createdAt: now,
    updatedAt: now,
  };
}

export function canonicalBuiltinRoleId(id: BuiltinRoleId): CanonicalBuiltinRoleId {
  return id;
}

export function builtinRoleModelType(id: BuiltinRoleId): SparkRoleModelType {
  if (id === "administrator") return "coordination";
  if (id === "explorer") return "exploration";
  if (id === "executor") return "implementation";
  return "verification";
}

export class RoleRegistry {
  #roles = new Map<RoleRef, RoleSpec>();

  constructor(initialRoles: RoleSpec[] = createBuiltinRoles()) {
    for (const role of initialRoles) this.add(role);
  }

  add(role: RoleSpec): void {
    validateRoleSpec(role);
    this.#roles.set(role.ref, role);
  }

  get(ref: string): RoleSpec {
    const role = this.#roles.get(normalizeRoleRef(ref));
    if (!role) throw new Error(`unknown role: ${ref}`);
    return role;
  }

  has(ref: string): boolean {
    return this.#roles.has(normalizeRoleRef(ref));
  }

  list(filter: { source?: RoleSource } = {}): RoleSpec[] {
    return [...this.#roles.values()]
      .filter((role) => !filter.source || role.source === filter.source)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  select(idOrRef: string, filter: { source?: RoleSource } = {}): RoleSpec {
    const selection = idOrRef;
    const normalized =
      selection.startsWith("role:") || selection.startsWith("builtin-")
        ? normalizeRoleRef(selection)
        : undefined;
    if (normalized) {
      const role = this.get(normalized);
      if (filter.source && role.source !== filter.source)
        throw new Error(`role ${idOrRef} does not match source ${filter.source}`);
      return role;
    }
    const matches = this.list(filter).filter(
      (role) =>
        role.id === selection ||
        roleRefId(role.ref) === selection ||
        roleIdFromRef(role.ref) === selection,
    );
    if (matches.length === 0) throw new Error(`no role matches: ${idOrRef}`);
    if (matches.length > 1) throw new Error(`ambiguous role: ${idOrRef}`);
    return matches[0];
  }
}

export interface RoleStore {
  save(role: RoleSpec): Promise<void>;
  loadAll(): Promise<RoleSpec[]>;
  hydrate?(registry: RoleRegistry): Promise<void>;
}

export interface MarkdownRoleStoreOptions {
  rootDir: string;
  source: WritableRoleSource;
  writable?: boolean;
  originKind?: RoleOriginKind;
}

export class MarkdownRoleStore implements RoleStore {
  readonly rootDir: string;
  readonly source: WritableRoleSource;
  readonly writable: boolean;
  readonly originKind: RoleOriginKind;

  constructor(options: MarkdownRoleStoreOptions | string) {
    const normalized =
      typeof options === "string"
        ? ({ rootDir: options, source: "project" as const } satisfies MarkdownRoleStoreOptions)
        : options;
    this.rootDir = normalized.rootDir;
    this.source = normalized.source;
    this.writable = normalized.writable ?? true;
    this.originKind = normalized.originKind ?? "manual";
  }

  async save(role: RoleSpec): Promise<void> {
    validateRoleSpec(role);
    if (!this.writable) throw new Error("role store is read-only");
    if (role.source !== this.source)
      throw new Error(`only ${this.source} roles can be saved to this MarkdownRoleStore`);
    const filePath = this.pathFor(role);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, serializeRoleSpecMarkdown(role), "utf8");
  }

  async loadAll(): Promise<RoleSpec[]> {
    const paths = await findMarkdownFiles(this.rootDir);
    const roles: RoleSpec[] = [];
    for (const filePath of paths) {
      const text = await readFile(filePath, "utf8");
      if (isForeignAgentRoleMarkdown(text)) continue;
      const role = parseRoleSpecMarkdown(text, {
        source: this.source,
        id: idFromMarkdownPath(this.rootDir, filePath),
        sourcePath: filePath,
        originKind: this.originKind,
      });
      roles.push(role);
    }
    return roles;
  }

  async hydrate(registry: RoleRegistry): Promise<void> {
    for (const role of await this.loadAll()) registry.add(role);
  }

  pathFor(role: Pick<RoleSpec, "id">): string {
    return join(this.rootDir, `${role.id}.md`);
  }
}

export function defaultProjectRoleStore(cwd: string): MarkdownRoleStore {
  return new MarkdownRoleStore({ rootDir: join(cwd, ".agents", "roles"), source: "project" });
}

export function defaultUserRoleStore(home?: string): MarkdownRoleStore {
  const rootDir = home ? join(home, ".agents", "roles") : resolveSparkUserPaths().rolesDir;
  return new MarkdownRoleStore({ rootDir, source: "user" });
}

export type RoleModelSettingsSource = "project" | "user";
export type ResolvedRoleModelSource = "explicit" | RoleModelSettingsSource;

export interface RoleModelSettingsEntry {
  modelType: SparkRoleModelType;
  model: string;
  source: RoleModelSettingsSource;
}

interface RoleModelSettingsFileV2 {
  version: 2;
  modelTypes: Record<string, string>;
}

export interface ResolvedRoleModelSetting {
  model: string;
  source: ResolvedRoleModelSource;
  modelType?: SparkRoleModelType;
}

export class RoleModelSettingsStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid role model settings store: ${filePath}: ${message}`);
    this.name = "RoleModelSettingsStoreFormatError";
    this.filePath = filePath;
  }
}

export class RoleModelTypeUnconfiguredError extends Error {
  readonly code = "role_model_type_unconfigured" as const;
  readonly roleRef: RoleRef;
  readonly modelType: SparkRoleModelType;

  constructor(roleRef: RoleRef, modelType: SparkRoleModelType) {
    super(
      `role model type ${modelType} is not configured for ${roleRef}; configure it with role({ action: "model_set" })`,
    );
    this.name = "RoleModelTypeUnconfiguredError";
    this.roleRef = roleRef;
    this.modelType = modelType;
  }
}

export class RoleModelSettingsStore {
  readonly filePath: string;
  readonly source: RoleModelSettingsSource;

  constructor(filePath: string, source: RoleModelSettingsSource) {
    this.filePath = filePath;
    this.source = source;
  }

  async loadAll(): Promise<RoleModelSettingsEntry[]> {
    const modelTypes = await this.loadModelTypes();
    return Object.entries(modelTypes)
      .map(([modelType, model]) => ({
        modelType: modelType as SparkRoleModelType,
        model,
        source: this.source,
      }))
      .sort((left, right) => left.modelType.localeCompare(right.modelType));
  }

  async get(modelType: string): Promise<RoleModelSettingsEntry | undefined> {
    const normalized = normalizeRoleModelType(modelType, "modelType");
    return (await this.loadAll()).find((entry) => entry.modelType === normalized);
  }

  async save(modelType: string, model: string): Promise<RoleModelSettingsEntry> {
    const normalizedModelType = normalizeRoleModelType(modelType, "modelType");
    const normalizedModel = normalizeRoleModelName(model, "model");
    const modelTypes = await this.loadModelTypes();
    modelTypes[normalizedModelType] = normalizedModel;
    await writeRoleModelSettingsFile(this.filePath, modelTypes);
    return { modelType: normalizedModelType, model: normalizedModel, source: this.source };
  }

  async delete(modelType: string): Promise<boolean> {
    const normalizedModelType = normalizeRoleModelType(modelType, "modelType");
    const modelTypes = await this.loadModelTypes();
    const deleted = Object.hasOwn(modelTypes, normalizedModelType);
    delete modelTypes[normalizedModelType];
    if (deleted) await writeRoleModelSettingsFile(this.filePath, modelTypes);
    return deleted;
  }

  private async loadModelTypes(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    return normalizeRoleModelSettingsFile(
      parseRoleModelSettingsFileJson(raw, this.filePath),
      this.filePath,
    );
  }
}

export function defaultProjectRoleModelSettingsStore(cwd: string): RoleModelSettingsStore {
  return new RoleModelSettingsStore(join(cwd, ".spark", "role-model-settings.json"), "project");
}

export function defaultUserRoleModelSettingsStore(sparkHome?: string): RoleModelSettingsStore {
  return new RoleModelSettingsStore(
    resolveSparkUserPaths({ sparkHome }).roleModelSettingsFile,
    "user",
  );
}

export async function resolveRoleModelSetting(input: {
  explicitModel?: string;
  roleRef: string;
  modelType?: SparkRoleModelType;
  roleId?: string;
  roleName?: string;
  projectStore?: RoleModelSettingsStore;
  userStore?: RoleModelSettingsStore;
}): Promise<ResolvedRoleModelSetting | undefined> {
  const explicitModel = input.explicitModel?.trim();
  if (explicitModel) return { model: explicitModel, source: "explicit" };
  normalizeRoleRef(input.roleRef);
  const modelType = input.modelType;
  if (!modelType) return undefined;
  for (const store of [input.projectStore, input.userStore]) {
    if (!store) continue;
    const entry = await store.get(modelType);
    if (entry)
      return {
        model: entry.model,
        source: entry.source,
        modelType: entry.modelType,
      };
  }
  return undefined;
}

function normalizeRoleModelType(value: string, field: string): SparkRoleModelType {
  const parsed = sparkRoleModelTypeSchema.safeParse(value);
  if (!parsed.success) throw new Error(`role model ${field} is invalid`);
  return parsed.data;
}

function normalizeRoleModelName(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`role model ${field} is required`);
  return value.trim();
}

function parseRoleModelSettingsFileJson(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new RoleModelSettingsStoreFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeRoleModelSettingsFile(value: unknown, filePath: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new RoleModelSettingsStoreFormatError(filePath, "JSON root must be an object");
  }
  const keys = Object.keys(value).sort();
  if (
    value.version !== 2 ||
    keys.length !== 2 ||
    keys[0] !== "modelTypes" ||
    keys[1] !== "version"
  ) {
    throw new RoleModelSettingsStoreFormatError(
      filePath,
      "runtime requires strict version 2 with only version and modelTypes",
    );
  }
  if (!isRecord(value.modelTypes)) {
    throw new RoleModelSettingsStoreFormatError(filePath, "modelTypes must be an object");
  }
  validateRoleModelMap(value.modelTypes, filePath, "modelTypes");
  return Object.fromEntries(
    Object.entries(value.modelTypes).map(([modelType, model]) => [
      normalizeRoleModelType(modelType, "modelType"),
      String(model).trim(),
    ]),
  );
}

function validateRoleModelMap(
  value: Record<string, unknown>,
  filePath: string,
  field: "modelTypes",
): void {
  for (const [selector, model] of Object.entries(value)) {
    if (!selector.trim())
      throw new RoleModelSettingsStoreFormatError(filePath, `${field} selectors must be non-empty`);
    if (typeof model !== "string" || !model.trim())
      throw new RoleModelSettingsStoreFormatError(
        filePath,
        `${field}.${selector} must be a non-empty string`,
      );
  }
}

async function writeRoleModelSettingsFile(
  filePath: string,
  modelTypes: Record<string, string>,
): Promise<void> {
  const sorted = Object.fromEntries(
    Object.entries(modelTypes).sort(([left], [right]) => left.localeCompare(right)),
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeTextFileAtomic(
    filePath,
    `${JSON.stringify({ version: 2, modelTypes: sorted } satisfies RoleModelSettingsFileV2, null, 2)}\n`,
  );
}

export async function validateRoleModel(input: {
  catalog: ModelCatalogPort;
  model: string;
}): Promise<void> {
  const model = input.model.trim();
  if (!model) throw new Error("role model is required");
  if (!model.includes("/")) {
    throw new Error(`role model must use provider/model syntax: ${model}`);
  }
  const entry = await input.catalog.lookup(model);
  if (!entry) throw new Error(`model validation failed for ${model}: unknown model`);
  if (!entry.available) {
    throw new Error(
      `model validation failed for ${model}: ${entry.unavailableReason ?? "authentication required"}`,
    );
  }
}

export function modelCatalogPortFromHostRegistry(value: unknown): ModelCatalogPort | undefined {
  if (!isHostModelRegistry(value)) return undefined;
  return {
    async lookup(model) {
      const all = value.getAll();
      const match = all.find((entry) => `${entry.provider}/${entry.id}` === model);
      if (!match) return undefined;
      const available = (await value.getAvailable()).some(
        (entry) => entry.provider === match.provider && entry.id === match.id,
      );
      return {
        providerName: match.provider,
        modelId: match.id,
        available,
        ...(available
          ? {}
          : { unavailableReason: value.getError?.() ?? "authentication required" }),
      };
    },
  };
}

interface HostModelRegistry {
  getAvailable():
    | Array<{ provider: string; id: string }>
    | Promise<Array<{ provider: string; id: string }>>;
  getAll(): Array<{ provider: string; id: string }>;
  getError?(): string | undefined;
}

function isHostModelRegistry(value: unknown): value is HostModelRegistry {
  if (!isRecord(value)) return false;
  return typeof value.getAvailable === "function" && typeof value.getAll === "function";
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function hydrateDefaultRoleRegistry(
  registry: RoleRegistry,
  cwd: string,
  options: {
    home?: string;
    includeUser?: boolean;
  } = {},
): Promise<void> {
  hydrateExtensionRoles(registry);
  await defaultProjectRoleStore(cwd).hydrate(registry);
  if (options.includeUser) await defaultUserRoleStore(options.home).hydrate(registry);
}

export function createRoleSpec(proposal: RoleSpecProposal, now = nowIso()): RoleSpec {
  const source = proposal.source ?? "project";
  const role = {
    ref: createRoleRef(source, proposal.id),
    id: proposal.id,
    source,
    description: proposal.description,
    systemPrompt: proposal.systemPrompt,
    capabilities: proposal.capabilities,
    allowedTools: proposal.allowedTools,
    allowedToolEffects: proposal.allowedToolEffects,
    modelType: proposal.modelType,
    origin: proposal.origin,
    createdAt: now,
    updatedAt: now,
  };
  return { ...role, revision: roleRevision(role) };
}

export function createRoleRef(source: RoleSource, id: string): RoleRef {
  if (source === "builtin") return `role:builtin-${sanitizeRoleRefPart(id)}`;
  if (source === "extension") return `role:extension-${sanitizeRoleRefPart(id)}`;
  return `role:${source}-${stableId(id)}`;
}

export function validateRoleSpec(role: RoleSpec): void {
  if (!role.ref.startsWith("role:")) throw new Error(`invalid role ref: ${role.ref}`);
  assertNonEmpty(role.revision, `role ${role.id} revision`);
  assertNonEmpty(role.id, "role id");
  assertNonEmpty(role.description, `role ${role.id} description`);
  assertNonEmpty(role.systemPrompt, `role ${role.id} system prompt`);
  if (!normalizeRoleSource(role.source))
    throw new Error(`invalid role source: ${String(role.source)}`);
  const expectedRevision = roleRevision(role);
  if (role.revision !== expectedRevision) {
    throw new Error(`role ${role.id} revision does not match its content`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function sanitizeRoleRefPart(value: string): string {
  return slugifyRoleRefPart(value) || "role";
}

function slugifyRoleRefPart(value: string): string {
  let output = "";
  let previousDash = false;
  for (const char of value.trim().toLowerCase()) {
    const allowed = (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_";
    if (allowed) {
      output += char;
      previousDash = false;
    } else if (output && !previousDash) {
      output += "-";
      previousDash = true;
    }
  }
  return output.endsWith("-") ? output.slice(0, -1) : output;
}

async function findMarkdownFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
        result.push(filePath);
      }
    }
  }
  await visit(rootDir);
  return result.sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function idFromMarkdownPath(rootDir: string, filePath: string): string {
  const withoutExt = relative(rootDir, filePath).slice(0, -extname(filePath).length);
  return withoutExt.split(sep).join("/");
}

export function parseRoleSpecMarkdown(
  text: string,
  input: {
    source: WritableRoleSource;
    id: string;
    sourcePath?: string;
    originKind?: RoleOriginKind;
  },
): RoleSpec {
  const now = nowIso();
  const parsed = parseFrontmatter(text);
  const frontmatter = parsed.frontmatter;
  assertKnownRoleFrontmatter(frontmatter);
  const id =
    stringFrontmatter(frontmatter, "id") ?? stringFrontmatter(frontmatter, "name") ?? input.id;
  const source = normalizeRoleSource(frontmatter.source) ?? input.source;
  if (source === "builtin" || source === "extension")
    throw new Error("markdown role stores cannot load builtin or extension roles");
  const description =
    stringFrontmatter(frontmatter, "description") ?? firstMarkdownParagraph(parsed.body);
  const systemPrompt = parsed.body.trim();
  const origin = parseOrigin(frontmatter.origin) ?? {
    kind: input.originKind ?? "manual",
    sourcePath: input.sourcePath,
  };
  const allowedTools =
    arrayFrontmatter(frontmatter, "allowedTools") ?? arrayFrontmatter(frontmatter, "tools");
  const allowedToolEffects = arrayFrontmatter(frontmatter, "allowedToolEffects") as
    | ToolEffect[]
    | undefined;
  const capabilities =
    roleCapabilitiesFrontmatter(frontmatter) ?? capabilitiesFromAllowedTools(allowedTools);
  const modelType = sparkRoleModelTypeSchema.parse(
    stringFrontmatter(frontmatter, "modelType") ?? "custom",
  );
  const role: RoleSpec = {
    ref: createRoleRef(source, id),
    revision: roleRevision({
      id,
      description,
      systemPrompt,
      capabilities,
      allowedTools,
      allowedToolEffects,
      modelType,
    }),
    id,
    source,
    description,
    systemPrompt,
    capabilities,
    allowedTools,
    allowedToolEffects,
    modelType,
    origin,
    createdAt: stringFrontmatter(frontmatter, "createdAt") ?? now,
    updatedAt: stringFrontmatter(frontmatter, "updatedAt") ?? now,
  };
  validateRoleSpec(role);
  return role;
}

export function roleRevision(
  role: Pick<
    RoleSpec,
    | "id"
    | "description"
    | "systemPrompt"
    | "capabilities"
    | "allowedTools"
    | "allowedToolEffects"
    | "modelType"
  >,
): string {
  return `sha256:${contentHash(
    JSON.stringify({
      id: role.id,
      description: role.description,
      systemPrompt: role.systemPrompt,
      capabilities: role.capabilities,
      allowedTools: role.allowedTools ?? [],
      allowedToolEffects: role.allowedToolEffects ?? [],
      modelType: role.modelType,
    }),
  )}`;
}

export function serializeRoleSpecMarkdown(role: RoleSpec): string {
  validateRoleSpec(role);
  const frontmatter: Record<string, unknown> = {
    id: role.id,
    description: role.description,
    source: role.source,
    revision: role.revision,
    capabilities: role.capabilities,
    modelType: role.modelType,
  };
  if (role.allowedTools?.length) frontmatter.allowedTools = role.allowedTools;
  if (role.allowedToolEffects?.length) frontmatter.allowedToolEffects = role.allowedToolEffects;
  if (role.origin) frontmatter.origin = role.origin;
  frontmatter.createdAt = role.createdAt;
  frontmatter.updatedAt = role.updatedAt;
  return `---\n${formatFrontmatter(frontmatter)}---\n\n${role.systemPrompt.trim()}\n`;
}

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + "\n---".length).replace(/^\r?\n/, "");
  return { frontmatter: parseSimpleYaml(raw), body };
}

function isForeignAgentRoleMarkdown(text: string): boolean {
  const raw = rawFrontmatter(text);
  if (raw === undefined) return false;
  const topLevel = parseTopLevelYamlScalars(raw);
  const role = topLevel.get("role")?.toLowerCase();
  // `~/.agents/roles` is also used by lightweight subagent specs. They are
  // not Pi RoleSpec files and may legitimately contain fields such as
  // `model:` or `capabilities:` that Spark roles reserve for separate settings.
  return role === "subagent";
}

function rawFrontmatter(text: string): string | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return undefined;
  return text.slice(4, end);
}

function parseTopLevelYamlScalars(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) continue;
    const parsedLine = parseYamlLine(line);
    if (!parsedLine) continue;
    out.set(parsedLine.key, unquoteYaml(parsedLine.rest.trim()));
  }
  return out;
}

function parseSimpleYaml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const parsedLine = parseYamlLine(line);
    if (!parsedLine) continue;
    const { key, rest } = parsedLine;
    if (key === "defaultModel" || key === "model")
      throw new Error("role spec model fields are not supported; use role model settings");
    if (!ROLE_FRONTMATTER_KEYS.has(key)) continue;
    if (!rest) {
      const values: string[] = [];
      const object: Record<string, string> = {};
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (!/^\s+/.test(next)) break;
        index += 1;
        const trimmed = next.trim();
        if (trimmed.startsWith("- ")) values.push(unquoteYaml(trimmed.slice(2).trim()));
        else {
          const nested = parseYamlLine(trimmed);
          if (nested) object[nested.key] = unquoteYaml(nested.rest.trim());
        }
      }
      out[key] = values.length > 0 ? values : Object.keys(object).length > 0 ? object : "";
      continue;
    }
    out[key] = parseYamlScalar(rest.trim());
  }
  return out;
}

function parseYamlLine(line: string): { key: string; rest: string } | undefined {
  const colonIndex = line.indexOf(":");
  if (colonIndex <= 0) return undefined;
  const key = line.slice(0, colonIndex);
  if (!isYamlKey(key)) return undefined;
  return { key, rest: line.slice(colonIndex + 1).trimStart() };
}

function isYamlKey(value: string): boolean {
  const first = value[0];
  if (!first || !isYamlKeyStart(first)) return false;
  for (const char of value.slice(1)) if (!isYamlKeyChar(char)) return false;
  return true;
}

function isYamlKeyStart(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_";
}

function isYamlKeyChar(char: string): boolean {
  return isYamlKeyStart(char) || (char >= "0" && char <= "9") || char === "-";
}

function parseYamlScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquoteYaml(item.trim()))
      .filter(Boolean);
  }
  return unquoteYaml(value);
}

function unquoteYaml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function formatFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${quoteYaml(formatYamlScalar(item))}`);
    } else if (value && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue !== undefined)
          lines.push(`  ${nestedKey}: ${quoteYaml(formatYamlScalar(nestedValue))}`);
      }
    } else {
      lines.push(`${key}: ${quoteYaml(formatYamlScalar(value))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatYamlScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  return JSON.stringify(value);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function stringFrontmatter(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayFrontmatter(frontmatter: Record<string, unknown>, key: string): string[] | undefined {
  const value = frontmatter[key];
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function roleCapabilitiesFrontmatter(
  frontmatter: Record<string, unknown>,
): RoleCapability[] | undefined {
  const values = arrayFrontmatter(frontmatter, "capabilities");
  if (!values) return undefined;
  const vocabulary = new Set<string>(ROLE_CAPABILITY_VOCAB);
  for (const value of values) {
    if (!vocabulary.has(value)) throw new Error(`unknown role capability: ${value}`);
  }
  return values as RoleCapability[];
}

function capabilitiesFromAllowedTools(allowedTools: string[] | undefined): RoleCapability[] {
  if (!allowedTools) return [];
  const capabilities = new Set<RoleCapability>();
  for (const tool of allowedTools) {
    for (const capability of ROLE_CAPABILITY_VOCAB) {
      if ((ROLE_TOOLS_BY_CAPABILITY[capability] as readonly string[]).includes(tool))
        capabilities.add(capability);
    }
  }
  return [...capabilities];
}

function parseOrigin(value: unknown): RoleOrigin | undefined {
  if (value === undefined) return undefined;
  return sparkRoleOriginSchema.parse(value);
}

const ROLE_FRONTMATTER_FIELDS = new Set([
  "id",
  "name",
  "source",
  "revision",
  "description",
  "origin",
  "allowedTools",
  "tools",
  "allowedToolEffects",
  "capabilities",
  "modelType",
  "createdAt",
  "updatedAt",
]);

function assertKnownRoleFrontmatter(frontmatter: Record<string, unknown>): void {
  const unknown = Object.keys(frontmatter).filter((key) => !ROLE_FRONTMATTER_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown Role frontmatter fields: ${unknown.sort().join(", ")}`);
  }
}

function normalizeRoleOriginKind(value: unknown): RoleOriginKind | undefined {
  return value === "manual" || value === "generated" || value === "builtin" || value === "extension"
    ? value
    : undefined;
}

function firstMarkdownParagraph(body: string): string {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return paragraph?.slice(0, 200) || "Reusable Spark role.";
}

export class RoleRunTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`role run timed out after ${timeoutMs}ms`);
    this.name = "RoleRunTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class RoleRunCancelledError extends Error {
  readonly reason: string | undefined;

  constructor(reason?: string) {
    super(reason ? `role run cancelled: ${reason}` : "role run cancelled");
    this.name = "RoleRunCancelledError";
    this.reason = reason;
  }
}

const activeRoleRuns = new Map<RoleRunRef, ActiveRoleRun>();
const activeRoleRunInputControllers = new Map<RoleRunRef, ExtensionRoleRunInputController>();
const ROLE_RUN_INPUT_ERROR_GRACE_MS = 75;

export function listActiveRoleRuns(): ActiveRoleRun[] {
  return [...activeRoleRuns.values()];
}

export function cancelRoleRun(runRef: RoleRunRef, reason?: string): boolean {
  return activeRoleRuns.get(runRef)?.cancel(reason) ?? false;
}

export async function sendInputToRoleRun(
  runRef: RoleRunRef,
  text: string,
): Promise<RoleRunInputDeliveryResult | undefined> {
  const record = activeRoleRuns.get(runRef);
  if (!record) return undefined;
  return await deliverInputToActiveRoleRun(record, text);
}

async function deliverInputToActiveRoleRun(
  record: ActiveRoleRun,
  text: string,
): Promise<RoleRunInputDeliveryResult> {
  let delivered = false;
  let errorMessage: string | undefined;
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  const controller = activeRoleRunInputControllers.get(record.ref);
  const child = record.child;
  if (controller) {
    try {
      await controller.send(payload);
      delivered = activeRoleRuns.has(record.ref);
      if (!delivered) errorMessage = "active role-run was no longer registered";
    } catch (error) {
      errorMessage = unknownErrorMessage(error);
    }
  } else if (record.inputControl === "none" || !child) {
    errorMessage = "active role-run has no input control channel";
  } else if (!child.stdin?.writable) {
    errorMessage = "role-run input control channel is not writable";
  } else {
    const stdin = child.stdin;
    try {
      errorMessage = await new Promise<string | undefined>((resolve) => {
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const settle = (message: string | undefined): void => {
          if (settled) return;
          settled = true;
          if (graceTimer) clearTimeout(graceTimer);
          setImmediate(() => stdin.off("error", onError));
          resolve(message);
        };
        const onError = (error: Error): void => {
          delivered = false;
          settle(unknownErrorMessage(error));
        };
        stdin.on("error", onError);
        stdin.write(payload, (error?: Error | null) => {
          if (error) {
            delivered = false;
            settle(unknownErrorMessage(error));
            return;
          }
          if (!activeRoleRuns.has(record.ref) || stdin.destroyed || !stdin.writable) {
            delivered = false;
            settle("role-run input control channel is not writable");
            return;
          }
          graceTimer = setTimeout(() => {
            delivered = activeRoleRuns.has(record.ref) && !stdin.destroyed && stdin.writable;
            settle(delivered ? undefined : "role-run input control channel is not writable");
          }, ROLE_RUN_INPUT_ERROR_GRACE_MS);
          graceTimer.unref?.();
        });
      });
    } catch (error) {
      delivered = false;
      errorMessage = unknownErrorMessage(error);
    }
  }
  const pid = record.pid ?? record.child?.pid;
  return {
    ref: record.ref,
    roleRef: record.roleRef,
    launch: record.launch,
    cwd: record.cwd,
    startedAt: record.startedAt,
    inputControl: record.inputControl,
    bytes: Buffer.byteLength(payload),
    delivered,
    errorMessage,
    ...(record.runName ? { runName: record.runName } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(record.timedOutAt ? { timedOutAt: record.timedOutAt } : {}),
  };
}

export function normalizeRoleLaunchMode(value: unknown): RoleLaunchMode {
  if (value === undefined || value === null) return "fresh";
  if (value === "fresh" || value === "forked") return value;
  throw new Error(`unsupported role launch mode: ${formatUnknownValue(value)}`);
}

export function normalizeRoleThinkingLevel(value: unknown): RoleThinkingLevel {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  )
    return value;
  throw new Error(`unsupported role thinking level: ${formatUnknownValue(value)}`);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  )
    return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol")
    return value.description ? `symbol:${value.description}` : "symbol";
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

export function buildRoleRunPrompt(
  input: Pick<RoleRunCommandInput, "instruction" | "runGuidance">,
): string {
  return [input.runGuidance?.trim(), "Instruction:", input.instruction.trim()]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export function buildRoleRunArgs(input: RoleRunCommandInput): string[] {
  if (!input.roleRef) throw new Error("role run roleRef is required");
  if (!input.instruction.trim()) throw new Error("role run instruction is required");
  const launch = normalizeRoleLaunchMode(input.launch);
  const args = ["--print", "--mode", "json"];
  if (input.noExtensions) args.push("--no-extensions");
  if (input.model?.trim()) args.push("--model", input.model.trim());
  if (input.thinking !== undefined)
    args.push("--thinking", normalizeRoleThinkingLevel(input.thinking));
  const allowedTools = normalizedToolAllowlist(input.allowedTools);
  if (allowedTools.length > 0) args.push("--tools", allowedTools.join(","));
  if (input.sessionDir) args.push("--session-dir", input.sessionDir);
  if (launch === "forked") {
    if (!input.forkFromSession?.trim())
      throw new Error("forked role launch requires forkFromSession");
    args.push("--fork", input.forkFromSession.trim());
  }
  args.push("--append-system-prompt", input.systemPrompt, buildRoleRunPrompt(input));
  return args;
}

function normalizedToolAllowlist(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  return value.map((tool) => tool.trim()).filter(Boolean);
}

export function roleRunChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const remainingDepth = parseRoleRunDepth(env[ROLE_RUN_DEPTH_ENV]);
  if (remainingDepth <= 0) {
    throw new Error(`${ROLE_RUN_DEPTH_ENV} exhausted; refusing to spawn nested role run`);
  }
  return {
    ...env,
    [ROLE_RUN_DEPTH_ENV]: String(remainingDepth - 1),
  };
}

function parseRoleRunDepth(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_ROLE_RUN_DEPTH;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${ROLE_RUN_DEPTH_ENV} must be an integer`);
  }
  return parsed;
}

export async function runRole(input: RoleRunLauncherInput): Promise<RoleRunResult> {
  if (input.signal?.aborted) throw new RoleRunCancelledError(abortSignalReason(input.signal));
  // Preserve the recursion guard for nested role calls even when the run is
  // daemon-native rather than process-backed.
  const nativeEnv = roleRunChildEnv(input.env);
  const nativeExecutor = await resolveRoleNativeExecutor({ runRole: input.nativeExecutor });

  const launch = normalizeRoleLaunchMode(input.launch);
  if (launch === "forked" && !input.forkFromSession?.trim()) {
    throw new Error("forked role execution requires forkFromSession");
  }
  const startedAt = input.now?.() ?? nowIso();
  const timeoutMs = input.timeoutMs ?? 600_000;
  const abortController = new AbortController();
  let cancellationReason: string | undefined;
  const activeRun: ActiveRoleRun = {
    ref: input.runRef,
    roleRef: input.roleRef,
    runName: input.runName?.trim() || undefined,
    launch,
    model: input.model?.trim() || undefined,
    cwd: input.cwd,
    startedAt,
    inputControl: "none",
    cancel(reason?: string) {
      cancellationReason = reason ?? "cancelled";
      if (!abortController.signal.aborted) abortController.abort(cancellationReason);
      return true;
    },
  };
  activeRoleRuns.set(input.runRef, activeRun);

  const inputControl = {
    register(controller: ExtensionRoleRunInputController): () => void {
      activeRoleRunInputControllers.set(input.runRef, controller);
      activeRun.inputControl = "native";
      return () => {
        if (activeRoleRunInputControllers.get(input.runRef) !== controller) return;
        activeRoleRunInputControllers.delete(input.runRef);
        activeRun.inputControl = activeRun.child?.stdin?.writable ? "stdin" : "none";
      };
    },
  };

  const abort = () => activeRun.cancel(abortSignalReason(input.signal));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  try {
    const nativeInput = {
      ...(input.usageExecutionKind ? { usageExecutionKind: input.usageExecutionKind } : {}),
      ...(input.nativeCompatibilityRecovery
        ? { nativeCompatibilityRecovery: input.nativeCompatibilityRecovery }
        : {}),
      role: {
        ref: input.roleRef,
        id: input.roleId ?? roleIdFromRef(input.roleRef),
        revision: input.roleRevision ?? "unversioned",
        systemPrompt: input.systemPrompt,
        ...(input.roleRevision ? { revision: input.roleRevision } : {}),
        ...(input.roleSource ? { source: input.roleSource } : {}),
        ...(input.roleCapabilities ? { capabilities: input.roleCapabilities } : {}),
        ...(input.roleModelType ? { modelType: input.roleModelType } : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.allowedToolEffects ? { allowedToolEffects: input.allowedToolEffects } : {}),
      },
      instruction: {
        roleRef: input.roleRef,
        instruction: input.instruction,
      },
      record: {
        ref: input.runRef,
        roleRef: input.roleRef,
        roleRevision: input.roleRevision ?? "unversioned",
        instruction: input.instruction,
        status: "running" as const,
        startedAt,
        ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      },
      cwd: input.cwd,
      timeoutMs,
      phase: input.phase ?? "implement",
      requireStructuredOutcome: input.requireStructuredOutcome ?? false,
      signal: abortController.signal,
      ...(input.sessionDir ? { sessionDir: input.sessionDir } : {}),
      launch,
      ...(launch === "forked" && input.forkFromSession?.trim()
        ? { forkFromSession: input.forkFromSession.trim() }
        : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      env: nativeEnv,
      inputControl,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    };

    const result = await runNativeRoleWithTimeout({
      execute: () => nativeExecutor(nativeInput),
      timeoutMs,
      onTimeout: () => {
        cancellationReason = "timeout";
        activeRun.timedOutAt = input.now?.() ?? nowIso();
        input.onTimeout?.();
        activeRun.cancel("timeout");
      },
    });
    if (cancellationReason && result.record.status !== "cancelled") {
      throw new RoleRunCancelledError(cancellationReason);
    }
    return {
      record: {
        ...result.record,
        ref: input.runRef,
        roleRef: input.roleRef,
        roleRevision: input.roleRevision ?? result.record.roleRevision ?? "unversioned",
        model: input.model?.trim() || result.record.model,
        thinking: input.thinking,
        instruction: input.instruction,
        startedAt: result.record.startedAt ?? startedAt,
        finishedAt: result.record.finishedAt ?? input.now?.() ?? nowIso(),
      },
      outcome: result.outcome ?? result.record.outcome,
      stdout: result.stdout,
      stderr: result.stderr,
      jsonEvents: result.jsonEvents,
    };
  } catch (error) {
    if (error instanceof RoleRunTimeoutError) throw error;
    if (cancellationReason || input.signal?.aborted) {
      throw new RoleRunCancelledError(cancellationReason ?? abortSignalReason(input.signal));
    }
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    activeRoleRunInputControllers.delete(input.runRef);
    activeRoleRuns.delete(input.runRef);
  }
}

async function runNativeRoleWithTimeout<T>(input: {
  execute: () => Promise<T>;
  timeoutMs: number;
  onTimeout: () => void;
}): Promise<T> {
  if (input.timeoutMs <= 0) return await input.execute();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.execute(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          input.onTimeout();
          reject(new RoleRunTimeoutError(input.timeoutMs));
        }, input.timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parsePiJsonlEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Pi may emit non-JSON diagnostics. Keep parser tolerant.
    }
  }
  return events;
}

function abortSignalReason(signal: AbortSignal | undefined): string {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return "abort";
}
