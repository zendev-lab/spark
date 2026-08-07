import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  RoleRef,
  SparkHostContext,
  ToolConfig,
  ToolRenderComponent,
} from "@zendev-lab/spark-core";
import {
  loadSparkSkillByName,
  SparkSkillResolver,
  type SparkLoadedSkill,
  type SparkSkillResolverOptions,
} from "@zendev-lab/spark-host/skill-resolver";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import { truncateToWidth } from "@zendev-lab/spark-tui-adapter/text";
import { Type } from "typebox";
import { runRole, type RoleRunRef } from "./role-runtime.ts";

export interface SparkSkillAgentToolOptions {
  sparkHome?: string;
  configPath?: string;
  builtinDirs?: string[];
  workspaceDir?: string;
  workspaceAgentsDirs?: string[];
  userDir?: string;
  userAgentsDir?: string;
  skillDirs?: string[];
  defaultTimeoutMs?: number;
  maxCombinedSkillChars?: number;
}

export interface SparkSkillAgentHostApi {
  registerTool(config: ToolConfig): void;
}

const DEFAULT_SKILL_AGENT_TIMEOUT_MS = 300_000;
const MAX_SKILL_AGENT_TIMEOUT_MS = 1_200_000;
const DEFAULT_MAX_COMBINED_SKILL_CHARS = 64_000;
const MAX_SKILL_AGENT_SKILLS = 8;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_AGENT_INSTRUCTION_CHARS = 12_000;
const MAX_SKILL_AGENT_INPUTS = 32;
const MAX_SKILL_AGENT_INPUT_CHARS = 2_048;
const MAX_SKILL_AGENT_OUTPUT_CHARS = 12_000;
const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const SKILL_NAME_REGEX = new RegExp(SKILL_NAME_PATTERN, "u");

/**
 * The parent owns orchestration and durable coordination. A dedicated Skill
 * Agent gets only direct investigation/execution tools and cannot recurse into
 * Roles, Sessions, Tasks, Skill Agents, Git publication, Artifacts, or Evidence.
 */
export const SKILL_AGENT_ALLOWED_TOOLS = [
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

const SKILL_AGENT_POLICY = {
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

export function createSparkSkillAgentTool(options: SparkSkillAgentToolOptions = {}): ToolConfig {
  const defaultTimeoutMs = normalizeConfiguredTimeout(options.defaultTimeoutMs);
  const maxCombinedSkillChars = normalizeMaxCombinedSkillChars(options.maxCombinedSkillChars);
  return {
    name: "skill_agent",
    label: "Skill Agent",
    description:
      "Run one dedicated anonymous Agent with one or more discovered Skills loaded in full exactly once. Use it for a self-contained unit of work jointly governed by the selected Skills.",
    promptGuidelines: [
      "Use skill_agent once with the complete matching Skill set when one or more Skills jointly own a self-contained unit of work; use read only when the current session itself must inspect and follow Skill instructions.",
      "Pass a complete instruction because the dedicated Agent cannot see the parent transcript.",
      "Do not explicitly read selected Skills before calling skill_agent, and do not duplicate the assigned work in the parent session.",
    ],
    policy: SKILL_AGENT_POLICY,
    effect: SKILL_AGENT_POLICY.effect,
    executionMode: SKILL_AGENT_POLICY.executionMode,
    parameters: Type.Object(
      {
        skills: Type.Array(
          Type.String({
            minLength: 1,
            maxLength: MAX_SKILL_NAME_CHARS,
            pattern: SKILL_NAME_PATTERN,
            description: "Exact Skill name from the available Skill catalog.",
          }),
          {
            minItems: 1,
            maxItems: MAX_SKILL_AGENT_SKILLS,
            description:
              "Complete set of Skills that jointly govern this dedicated Agent invocation.",
          },
        ),
        instruction: Type.String({
          minLength: 1,
          maxLength: MAX_SKILL_AGENT_INSTRUCTION_CHARS,
          description:
            "Self-contained request for the dedicated Agent, including expected output and verification.",
        }),
        inputs: Type.Optional(
          Type.Array(
            Type.String({
              minLength: 1,
              maxLength: MAX_SKILL_AGENT_INPUT_CHARS,
              description: "Relevant path, ref, constraint, or bounded context item.",
            }),
            {
              maxItems: MAX_SKILL_AGENT_INPUTS,
              description: "Optional bounded inputs supplied to the Agent.",
            },
          ),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: 1_000,
            maximum: MAX_SKILL_AGENT_TIMEOUT_MS,
            description: `Agent timeout in milliseconds. Default: ${defaultTimeoutMs}.`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      const skills = Array.isArray(args.skills)
        ? args.skills.filter((value): value is string => typeof value === "string")
        : [];
      const skillLabel = skills.length > 0 ? skills.join(",") : "?";
      const inputs = Array.isArray(args.inputs) ? `inputs=${args.inputs.length}` : undefined;
      const text = ["skill_agent", skillLabel, inputs].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal.throwIfAborted();
      const cwd = requiredCwd(ctx);
      const skillNames = normalizeSkillNames(params.skills);
      const instruction = requiredBoundedString(
        params.instruction,
        "skill_agent.instruction",
        MAX_SKILL_AGENT_INSTRUCTION_CHARS,
      );
      const inputs = optionalStringArray(params.inputs, "skill_agent.inputs");
      const timeoutMs = normalizeTimeout(params.timeoutMs, defaultTimeoutMs);
      const model = sessionModelName(ctx);
      if (!model) throw new Error("skill_agent requires an active session model");

      const resolver = await createSkillResolver(cwd, options);
      const { skills: resolvedSkills } = await resolver.resolve();
      const loaded = await Promise.all(
        skillNames.map((name) => loadSparkSkillByName(resolvedSkills, name)),
      );
      const missing = skillNames.filter((_name, index) => loaded[index] === undefined);
      if (missing.length > 0) {
        throw unknownSkillsError(
          missing,
          resolvedSkills
            .filter((skill) => !skill.disabled && !skill.disableModelInvocation)
            .map((skill) => skill.name),
        );
      }
      const loadedSkills = loaded.filter((skill): skill is SparkLoadedSkill => skill !== undefined);
      const combinedChars = loadedSkills.reduce((sum, skill) => sum + skill.content.length, 0);
      if (combinedChars > maxCombinedSkillChars) {
        throw new Error(
          `skill_agent refuses ${skillNames.join(", ")}: combined Skill source is ${combinedChars} characters, above the ${maxCombinedSkillChars} character execution limit`,
        );
      }

      const identity = skillAgentIdentity(skillNames);
      const roleRef = `role:${identity}` as RoleRef;
      const runRef = `run:${randomUUID()}` as RoleRunRef;
      const runName = `skills:${skillNames.join(",")}`;
      const agentInstruction = renderSkillAgentInstruction(instruction, inputs);
      const result = await runRole({
        usageExecutionKind: "role_run",
        runRef,
        roleRef,
        roleId: identity,
        runName,
        systemPrompt: renderSkillAgentSystemPrompt(loadedSkills),
        instruction: agentInstruction,
        allowedTools: [...SKILL_AGENT_ALLOWED_TOOLS],
        cwd,
        timeoutMs,
        signal,
        launch: "fresh",
        model,
        noSession: true,
        stdinMode: "ignore",
        nativeExecutor: ctx.runRole,
      });

      const output = boundedAgentOutput(result.stdout);
      const succeeded =
        result.record.status === "succeeded" &&
        (result.outcome === undefined || result.outcome.kind === "completed");
      const skillSummary = skillNames.join(", ");
      const lines = [
        `Skill Agent ${succeeded ? "completed" : result.record.status}: ${skillSummary}`,
        output || "(Agent returned no text output.)",
        !succeeded && result.outcome?.reason ? `Outcome: ${result.outcome.reason}` : undefined,
        !succeeded && result.stderr.trim()
          ? `stderr:\n${tailText(result.stderr.trim(), 8_000)}`
          : undefined,
      ].filter((line): line is string => Boolean(line));

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: {
          skills: loadedSkills.map(({ skill }) => ({
            name: skill.name,
            description: skill.description,
            layer: skill.layer,
            filePath: skill.filePath,
          })),
          combinedSkillChars: combinedChars,
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

export function registerSparkSkillAgentTool(
  api: SparkSkillAgentHostApi,
  options: SparkSkillAgentToolOptions = {},
): void {
  api.registerTool(createSparkSkillAgentTool(options));
}

export function renderSkillAgentSystemPrompt(loadedSkills: readonly SparkLoadedSkill[]): string {
  const skillNames = loadedSkills.map(({ skill }) => skill.name);
  const lines = [
    `You are a dedicated Spark Agent for executing the following Skills: ${skillNames.join(", ")}.`,
    "Complete the assigned task autonomously within the combined scope of these Skills. Follow every applicable Skill instruction and the concrete task instruction.",
    "All selected Skill instructions are already included below. Do not search for, read, reload, or delegate these Skills again.",
    "Apply each Skill to the part of the task it governs. The Skills have equal authority. Reconcile compatible instructions. If applicable instructions materially conflict and cannot all be satisfied, stop and report the exact conflict to the parent Agent instead of silently choosing one.",
    "The parent transcript is intentionally unavailable. Execute only the assigned request and do not widen its scope.",
    "Do not ask interactively, spawn another Role, call another Skill Agent, or mutate Task, Session, Goal, Loop, Repro, Workflow, Artifact, Evidence, Memory, or Git publication state.",
    "Return the completed result or changed files, verification performed and its outcome, and any exact blocker, missing user decision, or authorization required.",
    "",
    "<skills>",
  ];
  for (const loaded of loadedSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${loaded.skill.name}</name>`);
    lines.push(`    <source>${loaded.skill.filePath}</source>`);
    lines.push(`    <base_dir>${loaded.skill.baseDir}</base_dir>`);
    lines.push("    <instructions>");
    lines.push(loaded.body.trim());
    lines.push("    </instructions>");
    lines.push("  </skill>");
  }
  lines.push("</skills>");
  return lines.join("\n");
}

function renderSkillAgentInstruction(instruction: string, inputs: readonly string[]): string {
  if (inputs.length === 0) return instruction;
  return [instruction, "", "Bounded inputs:", ...inputs.map((input) => `- ${input}`)].join("\n");
}

async function createSkillResolver(
  cwd: string,
  options: SparkSkillAgentToolOptions,
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
  options: Pick<SparkSkillAgentToolOptions, "sparkHome" | "configPath">,
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

function normalizeSkillNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SKILL_AGENT_SKILLS) {
    throw new Error(
      `skill_agent.skills must be an array with 1-${MAX_SKILL_AGENT_SKILLS} Skill names`,
    );
  }
  const names = value.map((item, index) => {
    const name = requiredBoundedString(item, `skill_agent.skills[${index}]`, MAX_SKILL_NAME_CHARS);
    if (!SKILL_NAME_REGEX.test(name)) {
      throw new Error(
        `skill_agent.skills[${index}] must use lowercase letters, digits, and hyphens`,
      );
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("skill_agent.skills must not contain duplicate Skill names");
  }
  return names;
}

function unknownSkillsError(names: readonly string[], skillNames: readonly string[]): Error {
  const available = [...new Set(skillNames)].sort((a, b) => a.localeCompare(b)).slice(0, 20);
  const suffix = available.length > 0 ? ` Available Skills: ${available.join(", ")}.` : "";
  return new Error(`skill_agent could not resolve Skills ${JSON.stringify(names)}.${suffix}`);
}

function skillAgentIdentity(skillNames: readonly string[]): string {
  const digest = createHash("sha256").update(skillNames.join("\0")).digest("hex").slice(0, 12);
  return `skill-agent-${digest}`;
}

function sessionModelName(ctx: SparkHostContext): string | undefined {
  const provider = ctx.model?.provider.trim();
  const id = ctx.model?.id.trim();
  return provider && id ? `${provider}/${id}` : undefined;
}

function requiredCwd(ctx: SparkHostContext): string {
  if (typeof ctx.cwd === "string" && ctx.cwd.trim()) return ctx.cwd.trim();
  throw new Error("skill_agent requires ctx.cwd");
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
  if (!Array.isArray(value) || value.length > MAX_SKILL_AGENT_INPUTS) {
    throw new Error(`${field} must be an array with at most ${MAX_SKILL_AGENT_INPUTS} items`);
  }
  return value.map((item, index) => {
    const normalized = optionalString(item);
    if (!normalized) throw new Error(`${field}[${index}] must be a non-empty string`);
    if (normalized.length > MAX_SKILL_AGENT_INPUT_CHARS) {
      throw new Error(
        `${field}[${index}] must contain at most ${MAX_SKILL_AGENT_INPUT_CHARS} characters`,
      );
    }
    return normalized;
  });
}

function normalizeConfiguredTimeout(value: number | undefined): number {
  return normalizeTimeout(value, DEFAULT_SKILL_AGENT_TIMEOUT_MS);
}

function normalizeTimeout(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1_000 ||
    value > MAX_SKILL_AGENT_TIMEOUT_MS
  ) {
    throw new Error(
      `skill_agent.timeoutMs must be an integer between 1000 and ${MAX_SKILL_AGENT_TIMEOUT_MS}`,
    );
  }
  return value;
}

function normalizeMaxCombinedSkillChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_COMBINED_SKILL_CHARS;
  if (!Number.isInteger(value) || value < 1_000) {
    throw new Error("skill_agent maxCombinedSkillChars must be an integer of at least 1000");
  }
  return value;
}

function boundedAgentOutput(stdout: string): string | undefined {
  const output = stdout.trim();
  return output ? tailText(output, MAX_SKILL_AGENT_OUTPUT_CHARS) : undefined;
}

function tailText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(value.length - maxLength)}`;
}
