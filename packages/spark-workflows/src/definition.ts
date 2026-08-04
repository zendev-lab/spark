import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  sparkLoopPolicySchema,
  type SparkLoopPolicy,
  type SparkLoopPolicyInput,
} from "@zendev-lab/spark-protocol";
import { parseDocument } from "yaml";

import { getBuiltinWorkflowDefinition, listBuiltinWorkflows } from "./builtins.ts";
import { parseWorkflowScript } from "./metadata.ts";
import { userWorkflowDir, workspaceWorkflowDir } from "./registry-paths.ts";

export const SPARK_WORKFLOW_DEFINITION_SCHEMA = "spark.workflow/v2" as const;
export const SPARK_REPRO_WORKFLOW_STAGES = [
  "contract",
  "reference",
  "target",
  "alignment",
  "delivery",
] as const;

export type WorkflowSource = "builtin" | "workspace" | "user";
export type WorkflowSelector = `${WorkflowSource}:${string}`;
export type WorkflowWorkbenchPolicy = "none" | "live" | "checkpoint";
export type WorkflowDefinitionPhase = "plan" | "implement";

export interface WorkflowStageDefinition {
  id: string;
  title: string;
  handler?: {
    path: string;
    digest: string;
    content: string;
  };
}

export interface WorkflowDefinition {
  schema: typeof SPARK_WORKFLOW_DEFINITION_SCHEMA;
  selector: WorkflowSelector;
  id: string;
  source: WorkflowSource;
  title: string;
  description: string;
  path: string;
  extends?: WorkflowSelector;
  ancestry: WorkflowSelector[];
  phase?: WorkflowDefinitionPhase;
  skills: string[];
  roles: string[];
  stages: WorkflowStageDefinition[];
  loop: SparkLoopPolicy;
  workbench: WorkflowWorkbenchPolicy;
  instructions: string;
  digest: string;
  /** The old dynamic runtime remains an execution adapter, not a definition source. */
  script: string;
}

export interface WorkflowDefinitionDescriptor {
  selector: WorkflowSelector;
  id: string;
  source: WorkflowSource;
  title: string;
  description: string;
  path: string;
  stages: string[];
  phase?: WorkflowDefinitionPhase;
  extends?: WorkflowSelector;
  skills: string[];
  roles: string[];
  workbench: WorkflowWorkbenchPolicy;
  definitionDigest: string;
}

export interface WorkflowDefinitionRegistryError {
  source: WorkflowSource;
  path: string;
  error: string;
}

export interface WorkflowDefinitionRegistryListing {
  workflows: WorkflowDefinitionDescriptor[];
  errors: WorkflowDefinitionRegistryError[];
}

export interface WorkflowDefinitionOptions {
  includeUser?: boolean;
  workspaceWorkflowDir?: string;
  userWorkflowDir?: string;
}

interface RawWorkflowStage {
  id: string;
  title: string;
  handler?: string;
}

export interface RawWorkflowDefinition {
  id: string;
  title: string;
  description: string;
  extends?: WorkflowSelector;
  skills: string[];
  roles: string[];
  stages: RawWorkflowStage[];
  loop?: Record<string, unknown>;
  workbench?: WorkflowWorkbenchPolicy;
  instructions: string;
}

interface WorkflowDefinitionResolverContext {
  cwd: string;
  includeUser: boolean;
  workspaceRoot: string;
  userRoot: string;
  chain: WorkflowSelector[];
}

export function normalizeWorkflowId(id: string): string {
  const normalized = id.trim().replaceAll("_", "-");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
    throw new Error("workflow id must be lowercase letters, digits, and hyphens");
  }
  return normalized;
}

export function workflowSelector(source: WorkflowSource, id: string): WorkflowSelector {
  return `${source}:${normalizeWorkflowId(id)}`;
}

export function parseWorkflowSelector(selector: string): {
  source: WorkflowSource;
  id: string;
} {
  const [source, rawId, ...rest] = selector.split(":");
  if (
    rest.length > 0 ||
    (source !== "builtin" && source !== "workspace" && source !== "user") ||
    !rawId
  ) {
    throw new Error("workflow selector must be builtin:<id>, workspace:<id>, or user:<id>");
  }
  return { source, id: normalizeWorkflowId(rawId) };
}

export async function resolveWorkflowDefinition(input: {
  cwd: string;
  selector: string;
  includeUser?: boolean;
  workspaceWorkflowDir?: string;
  userWorkflowDir?: string;
}): Promise<WorkflowDefinition> {
  const context: WorkflowDefinitionResolverContext = {
    cwd: input.cwd,
    includeUser: input.includeUser ?? true,
    workspaceRoot: input.workspaceWorkflowDir ?? workspaceWorkflowDir(input.cwd),
    userRoot: input.userWorkflowDir ?? userWorkflowDir(),
    chain: [],
  };
  return await resolveDefinition(input.selector, context);
}

export async function listWorkflowDefinitions(
  cwd: string,
  options: WorkflowDefinitionOptions = {},
): Promise<WorkflowDefinitionRegistryListing> {
  const includeUser = options.includeUser ?? true;
  const workspaceRoot = options.workspaceWorkflowDir ?? workspaceWorkflowDir(cwd);
  const userRoot = options.userWorkflowDir ?? userWorkflowDir();
  const selectors: Array<{ source: WorkflowSource; selector: WorkflowSelector; path: string }> =
    listBuiltinWorkflows().map((definition) => ({
      source: "builtin",
      selector: workflowSelector("builtin", definition.id),
      path: workflowSelector("builtin", definition.id),
    }));
  const errors: WorkflowDefinitionRegistryError[] = [];
  selectors.push(...(await discoverDefinitionSelectors("workspace", workspaceRoot, errors)));
  if (includeUser) {
    selectors.push(...(await discoverDefinitionSelectors("user", userRoot, errors)));
  }
  const workflows: WorkflowDefinitionDescriptor[] = [];
  for (const candidate of selectors) {
    try {
      const definition = await resolveWorkflowDefinition({
        cwd,
        selector: candidate.selector,
        includeUser,
        workspaceWorkflowDir: workspaceRoot,
        userWorkflowDir: userRoot,
      });
      workflows.push(workflowDefinitionDescriptor(definition));
    } catch (error) {
      errors.push({
        source: candidate.source,
        path: candidate.path,
        error: errorMessage(error),
      });
    }
  }
  return { workflows, errors };
}

export function workflowDefinitionDescriptor(
  definition: WorkflowDefinition,
): WorkflowDefinitionDescriptor {
  return {
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
  };
}

async function resolveDefinition(
  requestedSelector: string,
  context: WorkflowDefinitionResolverContext,
): Promise<WorkflowDefinition> {
  const parsed = parseWorkflowSelector(requestedSelector);
  const selector = workflowSelector(parsed.source, parsed.id);
  if (context.chain.includes(selector)) {
    throw new Error(`workflow extends cycle: ${[...context.chain, selector].join(" -> ")}`);
  }
  if (context.chain.length >= 8) throw new Error("workflow extends depth exceeds 8");
  if (parsed.source === "user" && !context.includeUser) {
    throw new Error("user workflows are disabled for this read");
  }
  const nextContext = { ...context, chain: [...context.chain, selector] };
  const own =
    parsed.source === "builtin"
      ? builtinWorkflowDefinition(parsed.id)
      : await fileWorkflowDefinition(parsed.source, parsed.id, nextContext);
  const parent = own.raw.extends
    ? await resolveDefinition(own.raw.extends, nextContext)
    : undefined;
  return finalizeWorkflowDefinition({ ...own, selector, parent });
}

function builtinWorkflowDefinition(id: string): {
  raw: RawWorkflowDefinition;
  source: WorkflowSource;
  path: string;
  phase?: WorkflowDefinitionPhase;
  builtinScript: string;
  handlers: WorkflowStageDefinition[];
} {
  const builtin = getBuiltinWorkflowDefinition(id);
  if (!builtin) throw new Error(`unknown builtin workflow: ${id}`);
  const script = builtin.scriptFactory();
  const meta = parseWorkflowScript(script).meta;
  const stages = (meta.stages ?? meta.phases ?? []).map((stage) => ({
    id: normalizeStageId(stage.title),
    title: stage.title,
  }));
  const isRepro = id === "repro";
  return {
    source: "builtin",
    path: workflowSelector("builtin", id),
    phase: builtin.phase,
    builtinScript: script,
    handlers: stages,
    raw: {
      id,
      title: meta.name,
      description: meta.description,
      skills: [],
      roles: [],
      stages,
      loop: isRepro
        ? {
            cadence: "30s",
            retry: { maxAttempts: 3, delays: ["30s", "1m", "2m"] },
            beforeTick: [
              {
                id: "repro-pending-decision",
                when: {
                  kind: "evaluator",
                  selector: "builtin:repro-pending-decision",
                  input: {},
                },
                then: { action: "block" },
              },
            ],
            completion: { selector: "builtin:repro-reviewer", input: {} },
          }
        : undefined,
      workbench: isRepro ? "live" : "none",
      instructions: isRepro
        ? [
            "Advance the canonical Repro work summary by one evidence-backed tick.",
            "Never weaken formal gates, accept narration as proof, or complete while a typed decision is pending.",
          ].join("\n")
        : meta.description,
    },
  };
}

async function fileWorkflowDefinition(
  source: Exclude<WorkflowSource, "builtin">,
  id: string,
  context: WorkflowDefinitionResolverContext,
): Promise<{
  raw: RawWorkflowDefinition;
  source: WorkflowSource;
  path: string;
  handlers: WorkflowStageDefinition[];
}> {
  const root = source === "workspace" ? context.workspaceRoot : context.userRoot;
  const workflowDir = resolve(root, id);
  try {
    await assertDirectoryNotSymlink(workflowDir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      const legacyPath = resolve(root, `${id}.js`);
      try {
        const legacy = await lstat(legacyPath);
        if (legacy.isFile()) {
          throw new Error(
            `legacy top-level workflow script ${basename(legacyPath)} is rejected; migrate to ${id}/WORKFLOW.md and reference JS only from a stage handler`,
          );
        }
      } catch (legacyError) {
        if (!isNodeErrorCode(legacyError, "ENOENT")) throw legacyError;
      }
    }
    throw error;
  }
  const path = resolve(workflowDir, "WORKFLOW.md");
  await assertRegularFileNotSymlink(path);
  const markdown = await readFile(path, "utf8");
  const raw = parseWorkflowMarkdown(markdown, { expectedId: id, path });
  const handlers = await Promise.all(
    raw.stages.map(async (stage): Promise<WorkflowStageDefinition> => {
      if (!stage.handler) return { id: stage.id, title: stage.title };
      const handlerPath = await resolveHandlerPath(workflowDir, stage.handler);
      const content = await readFile(handlerPath, "utf8");
      if (/^\s*export\s+const\s+meta\b/mu.test(content)) {
        throw new Error(
          `workflow stage handler ${stage.handler} must be a body-only handler, not a top-level workflow script`,
        );
      }
      return {
        id: stage.id,
        title: stage.title,
        handler: {
          path: handlerPath,
          digest: sha256(content),
          content,
        },
      };
    }),
  );
  return { raw, source, path, handlers };
}

export function parseWorkflowMarkdown(
  markdown: string,
  input: { expectedId?: string; path?: string } = {},
): RawWorkflowDefinition {
  const path = input.path ?? "WORKFLOW.md";
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    throw new Error(`${path} must start with strict YAML frontmatter`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match) throw new Error(`${path} has unterminated YAML frontmatter`);
  const document = parseDocument(match[1]!, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${path} frontmatter is invalid: ${document.errors[0]!.message}`);
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  const frontmatter = requireRecord(value, `${path} frontmatter`);
  assertKnownKeys(
    frontmatter,
    ["id", "title", "description", "extends", "skills", "roles", "stages", "loop", "workbench"],
    `${path} frontmatter`,
  );
  const id = normalizeWorkflowId(requiredString(frontmatter.id, `${path} id`));
  if (input.expectedId && id !== input.expectedId) {
    throw new Error(`${path} id ${id} must match directory ${input.expectedId}`);
  }
  const title = requiredString(frontmatter.title, `${path} title`);
  const instructions = match[2]!.trim();
  if (!instructions) throw new Error(`${path} Markdown instructions must not be empty`);
  return {
    id,
    title,
    description:
      optionalString(frontmatter.description, `${path} description`) ??
      firstParagraph(instructions),
    extends: optionalSelector(frontmatter.extends, `${path} extends`),
    skills: stringArray(frontmatter.skills, `${path} skills`),
    roles: stringArray(frontmatter.roles, `${path} roles`),
    stages: workflowStages(frontmatter.stages, `${path} stages`),
    loop:
      frontmatter.loop === undefined ? undefined : requireRecord(frontmatter.loop, `${path} loop`),
    workbench: workbenchPolicy(frontmatter.workbench, `${path} workbench`),
    instructions,
  };
}

function finalizeWorkflowDefinition(input: {
  raw: RawWorkflowDefinition;
  source: WorkflowSource;
  path: string;
  phase?: WorkflowDefinitionPhase;
  builtinScript?: string;
  handlers: WorkflowStageDefinition[];
  selector: WorkflowSelector;
  parent?: WorkflowDefinition;
}): WorkflowDefinition {
  const { raw, parent } = input;
  const ownPolicy = normalizeWorkflowLoop(raw.loop);
  const stages = mergeStages(parent?.stages ?? [], input.handlers);
  const ancestry = [...(parent?.ancestry ?? []), ...(parent ? [parent.selector] : [])];
  const reproDerived = input.selector === "builtin:repro" || ancestry.includes("builtin:repro");
  const loop = parent ? mergeLoopPolicy(parent.loop, ownPolicy, raw.loop) : ownPolicy;
  const workbench = raw.workbench ?? parent?.workbench ?? "none";
  if (reproDerived) assertReproDefinition(stages, loop, workbench, input.selector);
  const instructions = [parent?.instructions, raw.instructions].filter(Boolean).join("\n\n");
  const merged = {
    schema: SPARK_WORKFLOW_DEFINITION_SCHEMA,
    selector: input.selector,
    id: raw.id,
    source: input.source,
    title: raw.title,
    description: raw.description,
    path: input.path,
    extends: raw.extends,
    ancestry,
    phase: input.phase ?? parent?.phase,
    skills: unique([...(parent?.skills ?? []), ...raw.skills]),
    roles: unique([...(parent?.roles ?? []), ...raw.roles]),
    stages,
    loop,
    workbench,
    instructions,
  } satisfies Omit<WorkflowDefinition, "digest" | "script">;
  const digest = workflowDefinitionDigest(merged);
  return {
    ...merged,
    digest,
    script: input.builtinScript ?? compileWorkflowDefinitionScript(merged),
  };
}

export function compileWorkflowDefinitionScript(
  definition: Omit<WorkflowDefinition, "digest" | "script"> | WorkflowDefinition,
): string {
  const meta = {
    name: definition.title,
    description: definition.description,
    stages: definition.stages.map((stage) => ({ title: stage.title })),
  };
  const chunks = [
    `export const meta = ${JSON.stringify(meta, null, 2)}`,
    `const workflowInstructions = ${JSON.stringify(definition.instructions)}`,
  ];
  const hasHandlers = definition.stages.some((stage) => stage.handler);
  if (hasHandlers) chunks.push("let workflowResult");
  for (const stage of definition.stages) {
    if (hasHandlers && !stage.handler) continue;
    chunks.push(`stage(${JSON.stringify(stage.title)})`);
    if (stage.handler) {
      chunks.push(`workflowResult = await (async () => {\n${stage.handler.content}\n})()`);
    }
  }
  chunks.push(hasHandlers ? "return workflowResult" : "return { workflowInstructions }");
  return `${chunks.join("\n\n")}\n`;
}

export function workflowDefinitionDigest(value: unknown): string {
  return sha256(JSON.stringify(sortJson(stripDigestPayload(value))));
}

function normalizeWorkflowLoop(raw: Record<string, unknown> | undefined): SparkLoopPolicy {
  if (!raw) return sparkLoopPolicySchema.parse({});
  assertKnownKeys(raw, ["cadence", "retry", "beforeTick", "afterTick", "completion"], "loop");
  const retry = raw.retry === undefined ? undefined : requireRecord(raw.retry, "loop.retry");
  if (retry) assertKnownKeys(retry, ["maxAttempts", "delays"], "loop.retry");
  const input: SparkLoopPolicyInput = {
    cadenceMs: parseDuration(raw.cadence ?? "30s", "loop.cadence"),
    ...(retry
      ? {
          retry: {
            maxAttempts: optionalInteger(retry.maxAttempts, "loop.retry.maxAttempts") ?? 3,
            delaysMs: durationArray(retry.delays, "loop.retry.delays", [30_000, 60_000, 120_000]),
          },
        }
      : {}),
    ...(raw.beforeTick !== undefined ? { beforeTick: raw.beforeTick as never } : {}),
    ...(raw.afterTick !== undefined ? { afterTick: raw.afterTick as never } : {}),
    ...(raw.completion !== undefined ? { completion: raw.completion as never } : {}),
  };
  return sparkLoopPolicySchema.parse(input);
}

function mergeLoopPolicy(
  parent: SparkLoopPolicy,
  own: SparkLoopPolicy,
  raw: Record<string, unknown> | undefined,
): SparkLoopPolicy {
  if (!raw) return parent;
  return sparkLoopPolicySchema.parse({
    cadenceMs: Object.hasOwn(raw, "cadence") ? own.cadenceMs : parent.cadenceMs,
    retry: Object.hasOwn(raw, "retry") ? own.retry : parent.retry,
    beforeTick: [...parent.beforeTick, ...own.beforeTick],
    afterTick: [...parent.afterTick, ...own.afterTick],
    completion: Object.hasOwn(raw, "completion") ? own.completion : parent.completion,
  });
}

function assertReproDefinition(
  stages: WorkflowStageDefinition[],
  loop: SparkLoopPolicy,
  workbench: WorkflowWorkbenchPolicy,
  selector: string,
): void {
  const prefix = stages.slice(0, SPARK_REPRO_WORKFLOW_STAGES.length).map((stage) => stage.id);
  if (JSON.stringify(prefix) !== JSON.stringify(SPARK_REPRO_WORKFLOW_STAGES)) {
    throw new Error(`${selector} cannot remove, reorder, or replace builtin:repro stages`);
  }
  if (loop.completion?.selector !== "builtin:repro-reviewer") {
    throw new Error(`${selector} cannot remove or replace the builtin:repro completion reviewer`);
  }
  if (workbench !== "live") {
    throw new Error(`${selector} cannot weaken builtin:repro workbench policy below live`);
  }
}

function mergeStages(
  parent: WorkflowStageDefinition[],
  own: WorkflowStageDefinition[],
): WorkflowStageDefinition[] {
  const ids = new Set(parent.map((stage) => stage.id));
  for (const stage of own) {
    if (ids.has(stage.id)) {
      throw new Error(`workflow extension cannot replace inherited stage: ${stage.id}`);
    }
    ids.add(stage.id);
  }
  return [...parent, ...own];
}

async function discoverDefinitionSelectors(
  source: Exclude<WorkflowSource, "builtin">,
  root: string,
  errors: WorkflowDefinitionRegistryError[],
): Promise<Array<{ source: WorkflowSource; selector: WorkflowSelector; path: string }>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const selectors = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".js")) {
      errors.push({
        source,
        path,
        error:
          `legacy top-level workflow script ${entry.name} is rejected; migrate to ` +
          `${entry.name.slice(0, -3)}/WORKFLOW.md and reference JS only from a stage handler`,
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const id = normalizeWorkflowId(entry.name);
      if (id !== entry.name) throw new Error(`workflow directory must use canonical id ${id}`);
      selectors.push({ source, selector: workflowSelector(source, id), path });
    } catch (error) {
      errors.push({ source, path, error: errorMessage(error) });
    }
  }
  return selectors;
}

function workflowStages(value: unknown, field: string): RawWorkflowStage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const path = `${field}[${index}]`;
    const raw = typeof item === "string" ? { id: item } : requireRecord(item, path);
    assertKnownKeys(raw, ["id", "title", "handler"], path);
    const id = normalizeStageId(requiredString(raw.id, `${path}.id`));
    if (seen.has(id)) throw new Error(`${field} contains duplicate stage ${id}`);
    seen.add(id);
    return {
      id,
      title: optionalString(raw.title, `${path}.title`) ?? id,
      handler: optionalString(raw.handler, `${path}.handler`),
    };
  });
}

function normalizeStageId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  if (!id) throw new Error("workflow stage id must contain a letter or digit");
  return id;
}

async function resolveHandlerPath(workflowDir: string, handler: string): Promise<string> {
  if (isAbsolute(handler)) throw new Error("workflow stage handler path must be relative");
  if (!handler.endsWith(".js")) throw new Error("workflow stage handler must use a .js file");
  const path = resolve(workflowDir, handler);
  const boundary = relative(workflowDir, path);
  if (!boundary || boundary.startsWith("..") || isAbsolute(boundary)) {
    throw new Error(`workflow stage handler escapes its workflow directory: ${handler}`);
  }
  await assertRegularFileNotSymlink(path);
  const canonicalRoot = await realpath(workflowDir);
  const canonicalPath = await realpath(path);
  const canonicalBoundary = relative(canonicalRoot, canonicalPath);
  if (canonicalBoundary.startsWith("..") || isAbsolute(canonicalBoundary)) {
    throw new Error(`workflow stage handler resolves outside its workflow directory: ${handler}`);
  }
  return canonicalPath;
}

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`workflow definition root must be a real directory: ${path}`);
  }
}

async function assertRegularFileNotSymlink(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`workflow definition file must be a real file: ${path}`);
  }
}

function workbenchPolicy(value: unknown, field: string): WorkflowWorkbenchPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "none" || value === "live" || value === "checkpoint") return value;
  throw new Error(`${field} must be none, live, or checkpoint`);
}

function optionalSelector(value: unknown, field: string): WorkflowSelector | undefined {
  const selector = optionalString(value, field);
  if (!selector) return undefined;
  const parsed = parseWorkflowSelector(selector);
  return workflowSelector(parsed.source, parsed.id);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return unique(value.map((item, index) => requiredString(item, `${field}[${index}]`)));
}

function parseDuration(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string") throw new Error(`${field} must be milliseconds or a duration`);
  const match = /^(\d+)(ms|s|m|h|d)$/u.exec(value.trim());
  if (!match) throw new Error(`${field} must use ms, s, m, h, or d`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const duration = Number(match[1]) * factors[match[2] as keyof typeof factors];
  if (!Number.isSafeInteger(duration) || duration > 7 * 86_400_000) {
    throw new Error(`${field} exceeds the seven day Loop limit`);
  }
  return duration;
}

function durationArray(value: unknown, field: string, fallback: number[]): number[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be non-empty`);
  return value.map((item, index) => parseDuration(item, `${field}[${index}]`));
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim() || undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${field} has unknown fields: ${unknown.join(", ")}`);
}

function firstParagraph(markdown: string): string {
  const paragraph = markdown
    .split(/\r?\n\r?\n/u)
    .map((value) => value.replace(/^#+\s*/u, "").trim())
    .find(Boolean);
  return paragraph ?? "Workflow instructions";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripDigestPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDigestPayload);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "digest" && key !== "script" && key !== "path")
      .map(([key, nested]) => [
        key,
        key === "handler" && nested && typeof nested === "object"
          ? handlerDigestPayload(nested as Record<string, unknown>)
          : stripDigestPayload(nested),
      ]),
  );
}

function handlerDigestPayload(handler: Record<string, unknown>): Record<string, unknown> {
  return {
    digest: handler.digest,
    path: typeof handler.path === "string" ? basename(handler.path) : "",
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}
