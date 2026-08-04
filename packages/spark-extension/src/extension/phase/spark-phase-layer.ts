import {
  assemblePhaseSystemPrompt,
  createPhaseRegistry,
  createPhaseTool,
  normalizePhaseToolAction,
  runPhaseToolAction,
  type Phase,
  type PhaseRegistry,
} from "@zendev-lab/spark-phases";
import { sparkActiveLens } from "../spark-phase-state.ts";
import type { SparkLanguage } from "../spark-i18n.ts";
import { sparkSystemPromptLanguageDirective } from "../spark-i18n.ts";
import { loadSparkPhase, saveSparkPhase } from "../session-state.ts";
import type { SparkToolRegistrar } from "../spark-tool-registration.ts";

const SPARK_PHASE_TOOLS_HINT =
  "Tools: task_read, task_write, assign, artifact, git, evidence, ask, role, memory, context, workflow, and spark-cue.";

let sparkPhaseRegistry: PhaseRegistry | undefined;

export function createSparkPhaseRegistry(): PhaseRegistry {
  return createPhaseRegistry({
    definitions: [
      sparkPhaseDefinition(
        "plan",
        "Plan",
        "investigate, answer, clarify scope, and create or revise durable task plans only when needed",
      ),
      sparkPhaseDefinition(
        "implement",
        "Implement",
        "claim and finish one concrete task at a time, continuing until blocked",
      ),
    ],
  });
}

export function defaultSparkPhaseRegistry(): PhaseRegistry {
  sparkPhaseRegistry ??= createSparkPhaseRegistry();
  return sparkPhaseRegistry;
}

export function renderSparkPhaseSystemPrompt(input: {
  basePrompt?: string;
  phase?: Phase;
  loopActive?: boolean;
  language?: SparkLanguage;
  trailingContext?: string;
}): string {
  const registry = defaultSparkPhaseRegistry();
  const resolved = registry.has(input.phase ?? "") ? input.phase! : "plan";
  const languageDirective = input.language
    ? sparkSystemPromptLanguageDirective(input.language)
    : undefined;
  return assemblePhaseSystemPrompt({
    basePrompt: input.basePrompt,
    registry,
    phase: resolved,
    context: { loopActive: input.loopActive },
    trailingContext: [languageDirective, input.trailingContext]
      .map((section) => section?.trim())
      .filter((section): section is string => Boolean(section))
      .join("\n\n"),
  });
}

export function registerSparkPhaseTool(registerSparkTool: SparkToolRegistrar): void {
  const registry = defaultSparkPhaseRegistry();
  const descriptor = createPhaseTool({ registry, name: "phase", label: "Phase" });
  registerSparkTool({
    ...descriptor,
    description: [
      "Switch the current session operating phase.",
      "action=status reports the current phase without changing it; plan or implement sets the persisted session phase and returns its requirements.",
      "Registered phases: plan, implement.",
    ].join(" "),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let action: ReturnType<typeof normalizePhaseToolAction>;
      try {
        action = normalizePhaseToolAction(params.action, registry);
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(error.message.replace(/^phase action/u, "phase action"));
        }
        throw error;
      }
      const current = await loadSparkPhase(ctx.cwd, ctx);
      const result = runPhaseToolAction({
        action,
        registry,
        currentPhase: current.phase,
        context: { focus: normalizeFocus(params.focus) },
      });
      if (!result.statusOnly) {
        const phase = result.phase as "plan" | "implement";
        await saveSparkPhase(ctx.cwd, ctx, { phase, projectRef: current.projectRef });
        ctx.sparkActiveLens = sparkActiveLens(phase);
      }
      const text = result.text
        .replace(/^Current lens:/u, "Current phase:")
        .replace(/^Lens set to:/u, "Phase set to:")
        .replace(/ for this turn\./u, ".");
      return {
        content: [{ type: "text", text }],
        details: { phase: result.phase, statusOnly: result.statusOnly },
      };
    },
  });
}

function sparkPhaseDefinition(id: Phase, title: string, summary: string) {
  return {
    id,
    title,
    summary,
    builtin: true,
    renderRequirements: () => `Spark phase: ${id}. ${SPARK_PHASE_TOOLS_HINT}`,
  };
}

function normalizeFocus(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
