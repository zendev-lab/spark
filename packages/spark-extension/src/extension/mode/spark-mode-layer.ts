import {
  assembleModeSystemPrompt,
  createModeRegistry,
  createModeTool,
  normalizeModeToolAction,
  runModeToolAction,
  type Mode,
  type ModeRegistry,
} from "@zendev-lab/spark-modes";
import { sparkActiveMode } from "../spark-mode-state.ts";
import type { SparkLanguage } from "../spark-i18n.ts";
import { sparkSystemPromptLanguageDirective } from "../spark-i18n.ts";
import { loadSparkMode, saveSparkMode } from "../session-state.ts";
import type { SparkToolRegistrar } from "../spark-tool-registration.ts";

const SPARK_MODE_TOOLS_HINT =
  "Tools: task_read, task_write, assign, artifact, git, evidence, ask, role, memory, context, workflow, and spark-cue.";

let sparkModeRegistry: ModeRegistry | undefined;

export function createSparkModeRegistry(): ModeRegistry {
  return createModeRegistry({
    definitions: [
      sparkModeDefinition(
        "plan",
        "Plan",
        "investigate, answer, clarify scope, and create or revise durable task plans only when needed",
      ),
      sparkModeDefinition(
        "execute",
        "Execute",
        "claim and finish one concrete task at a time, continuing until blocked",
      ),
    ],
  });
}

export function defaultSparkModeRegistry(): ModeRegistry {
  sparkModeRegistry ??= createSparkModeRegistry();
  return sparkModeRegistry;
}

export function renderSparkModeSystemPrompt(input: {
  basePrompt?: string;
  mode?: Mode;
  loopActive?: boolean;
  language?: SparkLanguage;
  trailingContext?: string;
}): string {
  const registry = defaultSparkModeRegistry();
  const resolved = registry.has(input.mode ?? "") ? input.mode! : "plan";
  const languageDirective = input.language
    ? sparkSystemPromptLanguageDirective(input.language)
    : undefined;
  return assembleModeSystemPrompt({
    basePrompt: input.basePrompt,
    registry,
    mode: resolved,
    context: { loopActive: input.loopActive },
    trailingContext: [languageDirective, input.trailingContext]
      .map((section) => section?.trim())
      .filter((section): section is string => Boolean(section))
      .join("\n\n"),
  });
}

export function registerSparkModeTool(registerSparkTool: SparkToolRegistrar): void {
  const registry = defaultSparkModeRegistry();
  const descriptor = createModeTool({ registry, name: "mode", label: "Mode" });
  registerSparkTool({
    ...descriptor,
    description: [
      "Switch the current session operating mode.",
      "action=status reports the current mode without changing it; plan or execute sets the persisted session mode and returns its requirements.",
      "Registered modes: plan, execute.",
    ].join(" "),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let action: ReturnType<typeof normalizeModeToolAction>;
      try {
        action = normalizeModeToolAction(params.action, registry);
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(error.message.replace(/^mode action/u, "mode action"));
        }
        throw error;
      }
      const current = await loadSparkMode(ctx.cwd, ctx);
      const result = runModeToolAction({
        action,
        registry,
        currentMode: current.mode,
        context: { focus: normalizeFocus(params.focus) },
      });
      if (!result.statusOnly) {
        const mode = result.mode as "plan" | "execute";
        await saveSparkMode(ctx.cwd, ctx, { mode });
        ctx.sparkActiveMode = sparkActiveMode(mode);
      }
      const text = result.text
        .replace(/^Current lens:/u, "Current mode:")
        .replace(/^Lens set to:/u, "Mode set to:")
        .replace(/ for this turn\./u, ".");
      return {
        content: [{ type: "text", text }],
        details: { mode: result.mode, statusOnly: result.statusOnly },
      };
    },
  });
}

function sparkModeDefinition(id: Mode, title: string, summary: string) {
  return {
    id,
    title,
    summary,
    builtin: true,
    renderRequirements: () => `Spark mode: ${id}. ${SPARK_MODE_TOOLS_HINT}`,
  };
}

function normalizeFocus(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
