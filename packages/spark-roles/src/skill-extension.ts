import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  RoleRef,
  SparkHostContext,
  ToolConfig,
  ToolRenderComponent,
} from "@zendev-lab/spark-core";
import {
  SparkSkillResolver,
  type SparkLoadedSkill,
  type SparkSkillResolverOptions,
} from "@zendev-lab/spark-host/skill-resolver";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import { truncateToWidth } from "@zendev-lab/spark-tui/text";
import { Type } from "typebox";
import { runRole, type RoleRunRef } from "./role-runtime.ts";

export interface SparkSkillDelegateToolOptions {
  sparkHome?: string;
  configPath?: string;
  builtinDirs?: string[];
  workspaceDir?: string;
  workspaceAgentsDirs?: string[];
  userDir?: string;
  userAgentsDir?: string;
  skillDirs?: string[];
  defaultTimeoutMs?: number;
  maxSkillChars?: number;
}

export interface SparkSkillDelegateHostApi {
  registerTool(config: ToolConfig): void;
}

const DEFAULT_SKILL_DELEGATE_TIMEOUT_MS = 300_000;
const MAX_SKILL_DELEGATE_TIMEOUT_MS = 1_200_000;
const DEFAULT_MAX_SKILL_CHARS = 64_000;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_DELEGATE_INSTRUCTION_CHARS = 12_000;
const MAX_SKILL_DELEGATE_INPUTS = 32;
const MAX_SKILL_DELEGATE_INPUT_CHARS = 2_048;
const MAX_SKILL_DELEGATE_OUTPUT_CHARS = 12_000;
const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const SKILL_NAME_REGEX = new RegExp(SKILL_NAME_PATTERN, "u");

/**
 * The parent owns orchestration and durable coordination. A Skill worker gets
 * only direct investigation/execution tools and cannot recurse into Roles,
 * Sessions, Tasks, Skill delegation, Git publication, Artifacts, or Evidence.
 */
export const SKILL_DELEGATE_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "context",
  "web_search",
  "code_search",
  "fetch_content",
  "get_search_content",
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
  "cue_jobs",
  "edit",
  "write",
] as const;

const SKILL_DELEGATE_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["skills", "roles"],
  phases: ["implement"],
  approval: "none",
} as const;

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

export function createSparkSkillDelegateTool(
  options: SparkSkillDelegateToolOptions = {},
): ToolConfig {
  const defaultTimeoutMs = normalizeConfiguredTimeout(options.defaultTimeoutMs);
  const maxSkillChars = normalizeMaxSkillChars(options.maxSkillChars);
  return {
    name: "skill_delegate",
    label: "Skill Delegate",
    description:
      "Delegate one discovered Skill to a fresh anonymous Worker. The tool resolves and loads SKILL.md internally, so the parent can hand off a self-contained request instead of executing the Skill itself.",
    promptGuidelines: [
      "Use skill_delegate when a Skill can own a self-contained unit of work; use read only when the current session itself must follow that Skill.",
      "Pass a complete instruction because the temporary Worker cannot see the parent transcript.",
      "Do not explicitly read the Skill before delegating it, and do not duplicate the delegated work in the parent session.",
    ],
    policy: SKILL_DELEGATE_POLICY,
    effect: SKILL_DELEGATE_POLICY.effect,
    executionMode: SKILL_DELEGATE_POLICY.executionMode,
    parameters: Type.Object(
      {
        skill: Type.String({
          minLength: 1,
          maxLength: MAX_SKILL_NAME_CHARS,
          pattern: SKILL_NAME_PATTERN,
          description: "Exact Skill name from the available Skill catalog.",
        }),
        instruction: Type.String({
          minLength: 1,
          maxLength: MAX_SKILL_DELEGATE_INSTRUCTION_CHARS,
          description:
            "Self-contained request for the temporary Worker, including expected output and verification.",
        }),
        inputs: Type.Optional(
          Type.Array(
            Type.String({
              minLength: 1,
              maxLength: MAX_SKILL_DELEGATE_INPUT_CHARS,
              description: "Relevant path, ref, constraint, or bounded context item.",
            }),
            {
              maxItems: MAX_SKILL_DELEGATE_INPUTS,
              description: "Optional bounded inputs supplied to the Worker.",
            },
          ),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: 1_000,
            maximum: MAX_SKILL_DELEGATE_TIMEOUT_MS,
            description: `Worker timeout in milliseconds. Default: ${defaultTimeoutMs}.`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      const skill = typeof args.skill === "string" ? args.skill : "?";
      const inputs = Array.isArray(args.inputs) ? `inputs=${args.inputs.length}` : undefined;
      const text = ["skill_delegate", skill, inputs].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal.throwIfAborted();
      const cwd = requiredCwd(ctx);
      const skillName = requiredBoundedString(
        params.skill,
        "skill_delegate.skill",
        MAX_SKILL_NAME_CHARS,
      );
      if (!SKILL_NAME_REGEX.test(skillName)) {
        throw new Error("skill_delegate.skill must use lowercase letters, digits, and hyphens");
      }
      const instruction = requiredBoundedString(
        params.instruction,
        "skill_delegate.instruction",
        MAX_SKILL_DELEGATE_INSTRUCTION_CHARS,
      );
      const inputs = optionalStringArray(params.inputs, "skill_delegate.inputs");
      const timeoutMs = normalizeTimeout(params.timeoutMs, defaultTimeoutMs);
      const model = sessionModelName(ctx);
      if (!model) throw new Error("skill_delegate requires an active session model");

      const resolver = await createSkillResolver(cwd, options);
      const loaded = await resolver.loadSkill(skillName);
      if (!loaded) {
        const { skills } = await resolver.resolve();
        throw unknownSkillError(
          skillName,
          skills.filter((skill) => !skill.disableModelInvocation).map((skill) => skill.name),
        );
      }
      if (loaded.content.length > maxSkillChars) {
        throw new Error(
          `skill_delegate refuses ${skillName}: Skill source is ${loaded.content.length} characters, above the ${maxSkillChars} character execution limit`,
        );
      }

      const roleRef = `role:skill-${loaded.skill.name}` as RoleRef;
      const runRef = `run:${randomUUID()}` as RoleRunRef;
      const runName = `skill:${loaded.skill.name}`;
      const workerInstruction = renderSkillWorkerInstruction(instruction, inputs);
      const result = await runRole({
        usageExecutionKind: "role_run",
        runRef,
        roleRef,
        roleId: `skill-${loaded.skill.name}`,
        runName,
        systemPrompt: renderSkillWorkerSystemPrompt(loaded),
        instruction: workerInstruction,
        allowedTools: [...SKILL_DELEGATE_ALLOWED_TOOLS],
        cwd,
        timeoutMs,
        signal,
        launch: "fresh",
        model,
        noSession: true,
        stdinMode: "ignore",
        nativeExecutor: ctx.runRole,
      });

      const output = boundedWorkerOutput(result.stdout);
      const succeeded =
        result.record.status === "succeeded" &&
        (result.outcome === undefined || result.outcome.kind === "completed");
      const lines = [
        `Skill Worker ${succeeded ? "completed" : result.record.status}: ${loaded.skill.name}`,
        output || "(Worker returned no text output.)",
        !succeeded && result.outcome?.reason ? `Outcome: ${result.outcome.reason}` : undefined,
        !succeeded && result.stderr.trim()
          ? `stderr:\n${tailText(result.stderr.trim(), 8_000)}`
          : undefined,
      ].filter((line): line is string => Boolean(line));

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: {
          skill: {
            name: loaded.skill.name,
            description: loaded.skill.description,
            layer: loaded.skill.layer,
            filePath: loaded.skill.filePath,
          },
          runRef,
          runName,
          model,
          timeoutMs,
          record: result.record,
          outcome: result.outcome,
          jsonEventCount: result.jsonEvents.length,
          output,
        },
        ...(succeeded ? {} : { isError: true }),
      };
    },
  };
}

export function registerSparkSkillDelegateTool(
  api: SparkSkillDelegateHostApi,
  options: SparkSkillDelegateToolOptions = {},
): void {
  api.registerTool(createSparkSkillDelegateTool(options));
}

export function renderSkillWorkerSystemPrompt(loaded: SparkLoadedSkill): string {
  const { skill } = loaded;
  return [
    `You are a temporary Spark Worker dedicated to the ${skill.name} Skill.`,
    "Execute only the assigned request. The parent transcript is intentionally unavailable.",
    "Treat the Skill instructions below as your specialized operating procedure and the incoming instruction as the concrete task.",
    `Resolve every relative Skill reference against: ${skill.baseDir}`,
    "Do not ask interactively, spawn another Role, delegate another Skill, or mutate Task, Session, Artifact, Evidence, or Git coordination state.",
    "Do not widen scope. Return the produced output or changed files, verification performed, and any exact blocker.",
    "",
    `Skill file: ${skill.filePath}`,
    "--- Skill instructions ---",
    loaded.body.trim(),
    "--- End Skill instructions ---",
  ].join("\n");
}

function renderSkillWorkerInstruction(instruction: string, inputs: readonly string[]): string {
  if (inputs.length === 0) return instruction;
  return [instruction, "", "Bounded inputs:", ...inputs.map((input) => `- ${input}`)].join("\n");
}

async function createSkillResolver(
  cwd: string,
  options: SparkSkillDelegateToolOptions,
): Promise<SparkSkillResolver> {
  const skillDirs = options.skillDirs ?? (await loadConfiguredSkillDirs(cwd, options));
  const resolverOptions: SparkSkillResolverOptions = {
    cwd,
    skillDirs,
    ...(options.sparkHome ? { sparkHome: options.sparkHome } : {}),
    ...(options.builtinDirs ? { builtinDirs: options.builtinDirs } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    ...(options.workspaceAgentsDirs ? { workspaceAgentsDirs: options.workspaceAgentsDirs } : {}),
    ...(options.userDir ? { userDir: options.userDir } : {}),
    ...(options.userAgentsDir ? { userAgentsDir: options.userAgentsDir } : {}),
  };
  return new SparkSkillResolver(resolverOptions);
}

async function loadConfiguredSkillDirs(
  cwd: string,
  options: Pick<SparkSkillDelegateToolOptions, "sparkHome" | "configPath">,
): Promise<string[]> {
  const configPath =
    options.configPath ?? resolveSparkUserPaths({ sparkHome: options.sparkHome, cwd }).configFile;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as { skills?: unknown };
    if (!Array.isArray(parsed.skills)) return [];
    return parsed.skills.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function unknownSkillError(name: string, skillNames: readonly string[]): Error {
  const available = [...new Set(skillNames)].sort((a, b) => a.localeCompare(b)).slice(0, 20);
  const suffix = available.length > 0 ? ` Available Skills: ${available.join(", ")}.` : "";
  return new Error(`skill_delegate could not resolve Skill ${JSON.stringify(name)}.${suffix}`);
}

function sessionModelName(ctx: SparkHostContext): string | undefined {
  const provider = ctx.model?.provider.trim();
  const id = ctx.model?.id.trim();
  return provider && id ? `${provider}/${id}` : undefined;
}

function requiredCwd(ctx: SparkHostContext): string {
  if (typeof ctx.cwd === "string" && ctx.cwd.trim()) return ctx.cwd.trim();
  throw new Error("skill_delegate requires ctx.cwd");
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function requiredBoundedString(value: unknown, field: string, maxLength: number): string {
  const normalized = requiredString(value, field);
  if (normalized.length > maxLength) {
    throw new Error(`${field} must contain at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SKILL_DELEGATE_INPUTS) {
    throw new Error(`${field} must be an array with at most ${MAX_SKILL_DELEGATE_INPUTS} items`);
  }
  return value.map((item, index) => {
    const normalized = optionalString(item);
    if (!normalized) throw new Error(`${field}[${index}] must be a non-empty string`);
    if (normalized.length > MAX_SKILL_DELEGATE_INPUT_CHARS) {
      throw new Error(
        `${field}[${index}] must contain at most ${MAX_SKILL_DELEGATE_INPUT_CHARS} characters`,
      );
    }
    return normalized;
  });
}

function normalizeConfiguredTimeout(value: number | undefined): number {
  return normalizeTimeout(value, DEFAULT_SKILL_DELEGATE_TIMEOUT_MS);
}

function normalizeTimeout(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1_000 ||
    value > MAX_SKILL_DELEGATE_TIMEOUT_MS
  ) {
    throw new Error(
      `skill_delegate.timeoutMs must be an integer between 1000 and ${MAX_SKILL_DELEGATE_TIMEOUT_MS}`,
    );
  }
  return value;
}

function normalizeMaxSkillChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SKILL_CHARS;
  if (!Number.isInteger(value) || value < 1_000) {
    throw new Error("skill_delegate maxSkillChars must be an integer of at least 1000");
  }
  return value;
}

function boundedWorkerOutput(stdout: string): string | undefined {
  const output = stdout.trim();
  return output ? tailText(output, MAX_SKILL_DELEGATE_OUTPUT_CHARS) : undefined;
}

function tailText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(value.length - maxLength)}`;
}
