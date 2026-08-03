import {
  LOOP_COMPLETION_BOUNDARY_GUIDANCE,
  createLoop,
  loopContinuationPrompt,
} from "@zendev-lab/spark-loop";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/spark-tasks";
import { type ProjectRef } from "@zendev-lab/spark-core";
import type {
  SparkDriverContinuity,
  SparkDriverKind,
  SparkDriverView,
} from "@zendev-lab/spark-protocol";
import type { SparkEntryIntent } from "./spark-entry.ts";
import { applySparkEntryResolution } from "./spark-entry-application.ts";
import { detectSparkProjectState, resolveSparkEntry } from "./spark-entry-resolution.ts";
import { currentSparkProject, loadSparkGraph } from "./session-state.ts";
import { startOrInferSessionGoal } from "./spark-goal-tool-registration.ts";
import {
  clearSessionGoal,
  loadSessionGoal,
  updateSessionGoalStatus,
  type SparkSessionGoal,
} from "./spark-session-goals.ts";
import {
  clearSessionLoop,
  loadSessionLoop,
  setSessionLoop,
  updateSessionLoopStatus,
} from "./spark-session-loops.ts";
import {
  clearSessionRepro,
  currentReproStage,
  readSessionRepro,
  reviseReproPlan,
  writeSessionRepro,
} from "./spark-session-repro.ts";
import { createProjectBackedSessionRepro } from "./spark-repro-project.ts";
import { renderReproTickInstruction } from "./spark-repro-tool-registration.ts";
import {
  goalContextStrings,
  goalInstructions,
  goalNotifications,
  sparkLanguageForProject,
  type SparkLanguage,
} from "./spark-i18n.ts";
import { renderSparkGoalDriverPrompt } from "./spark-mode-prompts.ts";
import {
  enterSparkUltracodeDriver,
  enterSparkWorkflowDriver,
  executeDynamicWorkflowNavigatorAction,
  publishDynamicWorkflowRunViews,
  type SparkWorkflowNavigatorAction,
} from "./spark-workflow-driver-entry.ts";
import { defaultSparkDynamicWorkflowEventStore } from "./spark-dynamic-workflow-event-store.ts";
import { sparkActiveLens } from "./spark-drive-state.ts";
import {
  buildSparkDynamicWorkflowDashboardView,
  renderSparkDynamicWorkflowDashboardText,
} from "./spark-dynamic-workflow-run-rendering.ts";
import {
  compactInline,
  parseDynamicWorkflowRunRefArg,
  parseGoalCommandAction,
  parseLoopCommandAction,
  parseReproCommandArgs,
} from "./spark-command-parser-utils.ts";
import { registerSparkWorkflowCommands } from "./spark-command-workflow-registration.ts";
import {
  prepareSparkDaemonDriverOwner,
  sparkDaemonDriverOwnerSessionId,
} from "./spark-daemon-driver-client.ts";
import type {
  SparkCommandApi,
  SparkCommandContext,
  SparkCommandRegistrationDeps,
} from "./spark-command-types.ts";

type SparkProjectLike = ReturnType<TaskGraph["projects"]>[number];
export type {
  SparkCommandApi,
  SparkCommandContext,
  SparkCommandRegistrationDeps,
} from "./spark-command-types.ts";

export function registerSparkCommands(
  pi: SparkCommandApi,
  deps: SparkCommandRegistrationDeps,
): void {
  pi.registerCommand("plan", {
    description: "Turn a goal into verifiable project tasks without implementing them yet.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        phase: "plan",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("implement", {
    description: "Work through ready project tasks until complete or blocked.",
    async handler(args, ctx) {
      await handleSparkEntryCommand(pi, ctx, {
        kind: "direct",
        phase: "implement",
        prompt: args.trim(),
      });
    },
  });

  pi.registerCommand("automate", {
    description: "Choose an existing long-running mode without starting it yet.",
    metadata: {
      source: "extension",
      extensionId: "spark-drive",
      plane: "tui",
      resource: "automation",
      verbs: ["select"],
    },
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui?.notify?.(
          "Usage: /automate. Choose a mode, then complete and submit the canonical command.",
          "warning",
        );
        return;
      }

      const choices = new Map([
        ["Goal — finish one defined outcome", "/goal start "],
        ["Loop — repeat open-ended work", "/loop start "],
        ["Repro — follow evidence-gated reproduction steps", "/repro start "],
        ["Workflow — choose a saved procedure", "/workflow list"],
      ]);
      if (!ctx.ui?.select) {
        ctx.ui?.notify?.(
          [
            "Choose an existing automation command:",
            "- /goal start <objective>",
            "- /loop start <objective>",
            "- /repro start <objective>",
            "- /workflow list",
          ].join("\n"),
          "info",
        );
        return;
      }

      const selection = await ctx.ui.select("Choose how Spark should continue", [
        ...choices.keys(),
      ]);
      const command = selection ? choices.get(selection) : undefined;
      if (!command) return;
      const setEditorText = ctx.ui.setEditorText ?? ctx.setEditorText;
      if (setEditorText) {
        setEditorText(command);
        return;
      }
      ctx.ui.notify?.(`Enter ${command.trimEnd()}`, "info");
    },
  });

  pi.registerCommand("goal", {
    description: "Continue toward a durable goal until it finishes or needs your input.",
    argumentHint: "[start|status|stop|restart] [objective]",
    metadata: {
      source: "extension",
      extensionId: "spark-drive",
      plane: "daemon",
      resource: "goal",
      verbs: ["start", "status", "stop", "restart"],
    },
    async handler(args, ctx) {
      await handleSparkGoalCommand(pi, ctx, args.trim());
    },
  });

  pi.registerCommand("loop", {
    description: "Repeat open-ended work only when the loop schedules another step.",
    argumentHint: "[start|status|stop|restart] [objective]",
    metadata: {
      source: "extension",
      extensionId: "spark-drive",
      plane: "daemon",
      resource: "loop",
      verbs: ["start", "status", "stop", "restart"],
    },
    async handler(args, ctx) {
      await handleSparkLoopCommand(pi, ctx, args.trim());
    },
  });

  pi.registerCommand("repro", {
    description: "Run an evidence-gated reproduction from setup through delivery.",
    argumentHint: "[start|status|stop|restart] [objective]",
    metadata: {
      source: "extension",
      extensionId: "spark-drive",
      plane: "daemon",
      resource: "repro",
      verbs: ["start", "status", "stop", "restart"],
    },
    async handler(args, ctx) {
      await handleSparkReproCommand(pi, ctx, args.trim());
    },
  });

  registerSparkWorkflowCommands(pi, {
    handleSparkWorkflowCommand,
    handleSparkUltracodeCommand,
    handleSparkDynamicWorkflowDashboardCommand,
    handleSparkDynamicWorkflowActionCommand,
  });

  async function handleSparkDynamicWorkflowDashboardCommand(
    ctx: SparkCommandContext,
    args: string,
    commandLabel = "workflow-runs",
  ): Promise<void> {
    const store = defaultSparkDynamicWorkflowEventStore(ctx.cwd);
    await store.reconcileStale();
    const runRef = args ? parseDynamicWorkflowRunRefArg(commandLabel, args) : undefined;
    const runs = await store.listRuns();
    publishDynamicWorkflowRunViews(ctx, runs);
    const text = renderSparkDynamicWorkflowDashboardText(
      buildSparkDynamicWorkflowDashboardView({
        action: "dashboard",
        runs,
        includeHistory: true,
        detailed: true,
        targetRunRef: runRef,
      }),
    );
    ctx.ui?.notify?.(text, "info");
    await deps.refreshSparkWidget(ctx.cwd, ctx);
  }

  async function handleSparkDynamicWorkflowActionCommand(
    ctx: SparkCommandContext,
    action: SparkWorkflowNavigatorAction,
    args: string,
    commandLabel = `workflow-${action}`,
  ): Promise<void> {
    const runRef = parseDynamicWorkflowRunRefArg(commandLabel, args);
    await executeDynamicWorkflowNavigatorAction(ctx, deps, { dynamicAction: action, runRef });
  }

  async function handleSparkEntryCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    intent: SparkEntryIntent,
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const projectState = await detectSparkProjectState(ctx.cwd, graph, ctx);
    const resolution = await resolveSparkEntry(ctx, intent, graph, projectState);
    await applySparkEntryResolution(piApi, deps, ctx, graph, resolution);
  }

  async function handleSparkWorkflowCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    parsed: { selector?: string; focus: string; forceNavigator?: boolean },
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    await enterSparkWorkflowDriver(piApi, deps, ctx, graph, parsed.focus, parsed.selector, {
      forceNavigator: parsed.forceNavigator,
    });
  }

  async function handleSparkUltracodeCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    focus: string,
  ): Promise<void> {
    await enterSparkUltracodeDriver(piApi, deps, ctx, focus);
  }

  async function handleSparkLoopCommand(
    _piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    rawArgs: string,
  ): Promise<void> {
    const parsedFresh = parseFreshLoopArgs(rawArgs);
    const loopAction = parseLoopCommandAction(parsedFresh.args);
    let existingLoop = await loadSessionLoop(ctx.cwd, ctx);
    if (existingLoop?.status === "paused") {
      await clearSessionLoop(ctx.cwd, ctx);
      existingLoop = undefined;
    }
    if (loopAction.action === "clear") {
      if (!existingLoop) {
        ctx.ui?.notify?.("No Spark loop is active.", "info");
        return;
      }
      await stopDriverForKind(ctx, "loop", "loop stopped by user");
      await clearSessionLoop(ctx.cwd, ctx);
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      ctx.ui?.notify?.(`Spark loop stopped: ${compactInline(existingLoop.objective)}`, "info");
      return;
    }
    if (loopAction.action === "status") {
      const daemon = await driverForKind(ctx, "loop");
      ctx.ui?.notify?.(
        existingLoop
          ? `Spark loop ${daemon?.status ?? existingLoop.status}: ${compactInline(existingLoop.objective)}${daemon?.dueAt ? ` · next=${daemon.dueAt}` : ""}`
          : "No Spark loop is active. Use /loop <objective> or /loop start <objective> to begin.",
        "info",
      );
      return;
    }
    if (loopAction.action === "removed") {
      ctx.ui?.notify?.("/loop pause was removed; use /loop stop to clear a plain loop.", "info");
      return;
    }
    if (loopAction.action === "restart") {
      await stopDriverForKind(ctx, "loop", "loop restarted by user");
      await clearSessionLoop(ctx.cwd, ctx);
      existingLoop = undefined;
    }

    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    const existingGoal = await loadSessionGoal(ctx.cwd, ctx);
    const explicitObjective =
      loopAction.action === "continue" || loopAction.action === "restart"
        ? loopAction.objective
        : "";
    const objective =
      explicitObjective ||
      existingLoop?.objective ||
      existingGoal?.objective ||
      project?.purpose ||
      project?.description ||
      project?.title ||
      "Continue Spark progress until blocked.";
    if (existingGoal) {
      await stopDriverForKind(ctx, "goal", "replaced by loop");
      await clearSessionGoal(ctx.cwd, ctx);
    }
    const loop =
      existingLoop && !explicitObjective
        ? await updateSessionLoopStatus(ctx.cwd, ctx, "active", {
            expectedLoopId: existingLoop.loopId,
          })
        : await setSessionLoop(ctx.cwd, ctx, {
            objective,
            source: explicitObjective ? "explicit" : "inferred",
            status: "active",
          });
    if (!loop) return;
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const visible = `Spark loop active: ${compactInline(loop.objective)}${projectLabel}`;
    ctx.ui?.notify?.(visible, "info");
    const tick = createLoop(loop.objective);
    await startDriver(ctx, {
      driverId: loop.loopId,
      kind: "loop",
      continuity: parsedFresh.continuity,
      prompt: renderSparkLoopInstruction(loop.objective, graph, project, tick),
      reason: "loop started",
    });
  }

  async function handleSparkReproCommand(
    _piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    rawArgs: string,
  ): Promise<void> {
    const parsed = parseReproCommandArgs(rawArgs);
    const { action } = parsed;
    const objective = parsed.objective.trim();

    if (action === "stop") {
      const existing = await readSessionRepro(ctx.cwd, ctx);
      await stopDriverForKind(ctx, "repro", "repro stopped by user");
      await clearSessionRepro(ctx.cwd, ctx);
      ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", "assist");
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      ctx.ui?.notify?.(
        existing
          ? `Spark repro stopped: ${currentReproStage(existing).title}`
          : "No Spark repro drive is active.",
        "info",
      );
      return;
    }

    if (action === "status") {
      const existing = await readSessionRepro(ctx.cwd, ctx);
      if (!existing) {
        ctx.ui?.notify?.(
          "No Spark repro drive is active. Use /repro <objective> or /repro start to begin.",
          "info",
        );
        return;
      }
      const stage = currentReproStage(existing);
      const daemon = await driverForKind(ctx, "repro");
      const objectiveLabel = existing.objective
        ? ` objective=${compactInline(existing.objective)},`
        : "";
      ctx.ui?.notify?.(
        `Spark repro ${daemon?.status ?? existing.status}:${objectiveLabel} ${stage.title} (${existing.currentStageIndex + 1}/${existing.stages.length}), phase=${existing.currentPhase}${daemon?.dueAt ? `, next=${daemon.dueAt}` : ""}`,
        "info",
      );
      return;
    }

    const ownerSessionId = await prepareSparkDaemonDriverOwner(ctx, deps.driverControl);
    const previousRepro = await readSessionRepro(ctx.cwd, ctx);
    await stopDriverForKind(ctx, "goal", "replaced by repro");
    await stopDriverForKind(ctx, "loop", "replaced by repro");
    await clearSessionGoal(ctx.cwd, ctx);
    await clearSessionLoop(ctx.cwd, ctx);
    if (action === "restart") {
      await stopDriverForKind(ctx, "repro", "repro restarted by user");
      await clearSessionRepro(ctx.cwd, ctx);
    }

    const existing = await readSessionRepro(ctx.cwd, ctx);
    const active =
      existing?.status === "active"
        ? existing.projectRef
          ? existing
          : (await createProjectBackedSessionRepro(ctx.cwd, ctx, { existing })).repro
        : (await createProjectBackedSessionRepro(ctx.cwd, ctx, { objective })).repro;
    const repro =
      objective && active.objective !== objective
        ? reviseReproPlan(active, {
            reason: "Repro objective updated by command",
            goalContract: {
              objective,
              constraints: active.goalContract.constraints,
              nonGoals: active.goalContract.nonGoals,
              successCriteria: active.goalContract.successCriteria,
              evidenceRequired: active.goalContract.evidenceRequired,
            },
          })
        : active;
    if (repro !== active) await writeSessionRepro(ctx.cwd, repro, ctx);

    const stage = currentReproStage(repro);
    const objectivePrefix = repro.objective ? `${compactInline(repro.objective)} · ` : "";
    const visible = `Spark repro active: ${objectivePrefix}${stage.title} (${repro.currentStageIndex + 1}/${repro.stages.length}), phase=${repro.currentPhase}`;
    try {
      await startDriver(
        ctx,
        {
          driverId: repro.reproId,
          kind: "repro",
          prompt: renderReproTickInstruction(repro),
          reason: "repro started",
        },
        ownerSessionId,
      );
    } catch (error) {
      if (action === "restart" || previousRepro?.status !== "active") {
        await clearSessionRepro(ctx.cwd, ctx);
        ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", "assist");
      } else {
        await writeSessionRepro(ctx.cwd, previousRepro, ctx);
        ctx.sparkActiveLens = sparkActiveLens(previousRepro.currentPhase, "repro");
      }
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      throw error;
    }
    ctx.sparkActiveLens = sparkActiveLens(repro.currentPhase, "repro");
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    ctx.ui?.notify?.(visible, "info");
  }

  async function handleSparkGoalCommand(
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    rawArgs: string,
  ): Promise<void> {
    const parsed = parseGoalCommandAction(rawArgs);
    const objective = parsed.objective;
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    let existingGoal = await loadSessionGoal(ctx.cwd, ctx);
    if (parsed.action === "stop") {
      await stopDriverForKind(ctx, "goal", "goal stopped by user");
      await clearSessionGoal(ctx.cwd, ctx);
      ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", "assist");
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      ctx.ui?.notify?.(
        existingGoal
          ? `Spark goal stopped: ${compactInline(existingGoal.objective)}`
          : "No Spark goal is active.",
        "info",
      );
      return;
    }
    if (parsed.action === "status") {
      const daemon = await driverForKind(ctx, "goal");
      ctx.ui?.notify?.(
        existingGoal
          ? `Spark goal ${daemon?.status ?? existingGoal.status}: ${compactInline(existingGoal.objective)}${daemon?.dueAt ? ` · next=${daemon.dueAt}` : ""}`
          : "No Spark goal is active. Use /goal <objective> or /goal start <objective> to begin.",
        "info",
      );
      return;
    }
    if (parsed.action === "restart") {
      await stopDriverForKind(ctx, "goal", "goal restarted by user");
      await clearSessionGoal(ctx.cwd, ctx);
      existingGoal = undefined;
    }
    const language = sparkLanguageForProject({
      project,
      goal: existingGoal,
      fallbackText: objective,
    });
    const notifications = goalNotifications(language);
    if (existingGoal && existingGoal.status !== "complete") {
      const completedProject = graph
        ? completedProjectForInferredGoal(existingGoal, graph)
        : undefined;
      if (completedProject) {
        await stopDriverForKind(ctx, "goal", "stale goal replaced");
        if (objective.trim()) {
          const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective);
          if (!goal) return;
          await clearSessionLoopForGoal(ctx);
          await deps.refreshSparkWidget(ctx.cwd, ctx);
          const projectLabel = project ? ` · project: ${project.title}` : "";
          const visible = notifications.goalActiveHeader(
            compactInline(goal.objective),
            projectLabel,
          );
          ctx.ui?.notify?.(notifications.staleReplaced, "info");
          await queueForegroundGoalStartInstruction(
            piApi,
            ctx,
            project?.title,
            goal,
            visible,
            language,
          );
          return;
        }
        await clearSessionGoal(ctx.cwd, ctx);
        await deps.refreshSparkWidget(ctx.cwd, ctx);
        ctx.ui?.notify?.(
          notifications.staleClearedFor(compactInline(completedProject.title)),
          "info",
        );
        return;
      }
      const goal =
        existingGoal.status === "active"
          ? existingGoal
          : await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
              reason: "Goal restarted by /goal without changing the existing objective.",
            });
      if (!goal) return;
      await clearSessionLoopForGoal(ctx);
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      const projectLabel = project ? ` · project: ${project.title}` : "";
      const visible = notifications.goalContinuingHeader(
        compactInline(goal.objective),
        projectLabel,
      );
      ctx.ui?.notify?.(visible, "info");
      await startDriver(ctx, {
        driverId: goal.goalId,
        kind: "goal",
        prompt: renderForegroundGoalTickInstruction(
          project?.title,
          goal.objective,
          graph,
          project,
          language,
          createLoop(goal.objective),
        ),
        reason: "goal continued",
      });
      return;
    }
    if (!objective) {
      await deps.refreshSparkWidget(ctx.cwd, ctx);
      const summary = renderEmptyGoalInferContext(graph, project, language);
      ctx.ui?.notify?.(notifications.noActiveGoal, "info");
      const instructions = goalInstructions(language);
      const instruction = [
        instructions.emptyGoalNotSet,
        instructions.emptyGoalReadContext,
        instructions.emptyGoalWriteHint,
        instructions.emptyGoalNoCounts,
        summary,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      await startDriver(ctx, {
        driverId: `goal-infer:${sparkDaemonDriverOwnerSessionId(ctx)}`,
        kind: "goal",
        prompt: instruction,
        reason: "infer goal from active context",
      });
      return;
    }
    const goal = await startOrInferSessionGoal(ctx.cwd, ctx, graph, objective);
    if (!goal) return;
    await clearSessionLoopForGoal(ctx);
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    const projectLabel = project ? ` · project: ${project.title}` : "";
    const goalLanguage = sparkLanguageForProject({ project, goal, fallbackText: objective });
    const goalNotificationsForLang = goalNotifications(goalLanguage);
    const visible = goalNotificationsForLang.goalActiveHeader(
      compactInline(goal.objective),
      projectLabel,
    );
    ctx.ui?.notify?.(visible, "info");
    await queueForegroundGoalStartInstruction(
      piApi,
      ctx,
      project?.title,
      goal,
      visible,
      goalLanguage,
    );
  }

  function renderEmptyGoalInferContext(
    graph: TaskGraph | null,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
  ): string {
    const strings = goalContextStrings(language);
    if (!graph) return strings.notInitialized;
    const lines: string[] = [];
    if (project) {
      const tasks = graph.tasks(project.ref);
      const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
      const ready = graph.readyTasks(project.ref);
      lines.push(strings.currentProjectLine(project.title));
      lines.push(strings.unfinishedReadyLine(unfinished.length, ready.length));
      const readyTitles = ready.slice(0, 5).map((task) => task.title);
      if (readyTitles.length > 0) lines.push(strings.readyFrontierLine(readyTitles));
    } else {
      const projects = graph.projects();
      lines.push(strings.noActiveProject(projects.length));
      const projectTitles = projects.slice(0, 5).map((candidate) => candidate.title);
      if (projectTitles.length > 0) lines.push(strings.activeProjectCandidates(projectTitles));
    }
    return lines.join("\n");
  }

  function completedProjectForInferredGoal(
    goal: SparkSessionGoal,
    graph: TaskGraph,
  ): ReturnType<TaskGraph["projects"]>[number] | undefined {
    if (goal.source !== "inferred") return undefined;
    const projects = graph.projects();
    const candidate = projects.find((project) =>
      inferredGoalObjectiveMatchesProject(goal.objective, project),
    );
    if (!candidate) return undefined;
    const unfinished = graph
      .tasks(candidate.ref)
      .some((task) => isUnfinishedTaskStatus(task.status));
    return unfinished ? undefined : candidate;
  }

  function inferredGoalObjectiveMatchesProject(
    objective: string,
    project: SparkProjectLike,
  ): boolean {
    const normalized = normalizeGoalMatchText(objective);
    const title = normalizeGoalMatchText(project.title);
    const outcome =
      normalizeGoalMatchText(project.purpose) || normalizeGoalMatchText(project.description);
    const legacyTitleCandidates = [
      `Advance project “${title}”`,
      `Advance project "${title}"`,
      `Advance project '${title}'`,
    ];
    if (legacyTitleCandidates.some((candidate) => normalized.includes(candidate))) return true;
    const candidates = [
      `Achieve the intended outcome of “${title}”.`,
      `Achieve the intended outcome of "${title}".`,
      `Achieve the intended outcome of '${title}'.`,
      `实现“${title}”的预期成果。`,
      `实现"${title}"的预期成果。`,
      outcome
        ? `Achieve the intended project outcome: ${withGoalMatchPunctuation(outcome, ".")}`
        : undefined,
      outcome ? `实现项目预期成果：${withGoalMatchPunctuation(outcome, "。")}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return candidates.some((candidate) => normalized === normalizeGoalMatchText(candidate));
  }

  function normalizeGoalMatchText(value: string | undefined): string {
    return value?.replaceAll(/\s+/gu, " ").trim() ?? "";
  }

  function withGoalMatchPunctuation(text: string, fallback: "." | "。"): string {
    return /[.!?。！？]$/u.test(text) ? text : `${text}${fallback}`;
  }

  async function clearSessionLoopForGoal(ctx: SparkCommandContext): Promise<void> {
    if (await loadSessionLoop(ctx.cwd, ctx)) await clearSessionLoop(ctx.cwd, ctx);
  }

  async function queueForegroundGoalStartInstruction(
    _piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    projectTitle: string | undefined,
    goal: SparkSessionGoal,
    visible: string,
    language: SparkLanguage,
  ): Promise<void> {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    const project = graph ? await currentSparkProject(ctx.cwd, ctx, graph) : undefined;
    const instructions = goalInstructions(language);
    const instruction = [
      instructions.goalActiveHeader,
      projectTitle ? instructions.currentProject(projectTitle) : undefined,
      instructions.goalLine(goal.objective),
      instructions.pauseLineForeground,
      instructions.loopModeDecisionContract,
      instructions.loopReviewerOwnership,
      graph ? renderForegroundGoalPhasePrompt(graph, project?.ref, goal.objective) : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    await startDriver(ctx, {
      driverId: goal.goalId,
      kind: "goal",
      prompt: instruction,
      reason: visible,
    });
  }

  function renderSparkLoopInstruction(
    objective: string,
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    loop: ReturnType<typeof createLoop>,
  ): string {
    const status = renderSparkLoopStatus(graph, project);
    return [
      loopContinuationPrompt(loop),
      "",
      "Spark foreground loop tick.",
      project ? `Current project: ${project.title}.` : undefined,
      `Loop objective: ${objective}`,
      status,
      LOOP_COMPLETION_BOUNDARY_GUIDANCE,
      "For reviewer-gated goal completion, start or continue /goal instead of this open-ended loop.",
      'Before ending this /loop tick, call loop({ action: "schedule", delayMs, reason }) to choose the next tick time; there is no fixed default interval. If cadence/cost/urgency is a material user preference, call ask before scheduling.',
      renderSparkLoopPhasePrompt(graph, project?.ref, objective),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  function renderSparkLoopPhasePrompt(
    _graph: TaskGraph | null | undefined,
    _selectedProjectRef: ProjectRef | undefined,
    _objective: string,
  ): string {
    return [
      "Loop driver requirements:",
      "- Use the loop objective, current project/task state, and blocker/validation signals to choose the next concrete step; do not classify the whole tick as plan or implement.",
      "- Continue one concrete low-risk step; block on human decisions or report external blockers instead of lowering scope.",
      "- Use /goal when the user wants evidence-audited completion with reviewer gating.",
      "- End the turn by scheduling the next tick with the loop tool, unless you cleared the loop or reported a blocker that prevents scheduling.",
    ].join("\n");
  }

  function renderSparkLoopStatus(
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
  ): string | undefined {
    if (!graph || !project) {
      return 'No current project is selected. If durable task state is needed, use task_read({ action: "workspace_status" }) and task_write({ action: "project_use", title, description }) explicitly.';
    }
    const tasks = graph.tasks(project.ref);
    const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
    const ready = graph.readyTasks(project.ref);
    const readyHead = ready.slice(0, 3).map((task) => task.title);
    return [
      `Project status: unfinished=${unfinished.length}, ready=${ready.length}.`,
      readyHead.length > 0 ? `Ready frontier: ${readyHead.join("; ")}.` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  function renderForegroundGoalTickInstruction(
    projectTitle: string | undefined,
    objective: string,
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
    loop: ReturnType<typeof createLoop>,
  ): string {
    const instructions = goalInstructions(language);
    const status = renderForegroundGoalTickStatus(graph, project, language);
    return [
      instructions.loopTickHeader,
      projectTitle ? instructions.currentProject(projectTitle) : undefined,
      instructions.goalLine(objective),
      status,
      renderForegroundGoalLoopLayer(loop),
      instructions.loopModeDecisionContract,
      instructions.loopReviewerOwnership,
      graph ? renderForegroundGoalPhasePrompt(graph, project?.ref, objective) : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  function renderForegroundGoalLoopLayer(loop: ReturnType<typeof createLoop>): string {
    return [
      `Foreground goal tick scheduled (loop_id=${loop.loopId}).`,
      'When the objective is fully verified, request reviewer-gated completion with goal({ action: "complete" }); otherwise continue the next concrete step or report the blocker.',
    ].join("\n");
  }

  function renderForegroundGoalPhasePrompt(
    graph: TaskGraph,
    selectedProjectRef: ProjectRef | undefined,
    objective: string,
  ): string {
    return renderSparkGoalDriverPrompt(graph, selectedProjectRef, objective);
  }

  function renderForegroundGoalTickStatus(
    graph: TaskGraph | null | undefined,
    project: SparkProjectLike | undefined,
    language: SparkLanguage,
  ): string | undefined {
    if (!graph || !project) return renderGoalBootstrapStatus(language);
    const tasks = graph.tasks(project.ref);
    const unfinished = tasks.filter((task) => isUnfinishedTaskStatus(task.status));
    const ready = graph.readyTasks(project.ref);
    const readyHead = ready.slice(0, 3).map((task) => task.title);
    return goalContextStrings(language).projectStatus(unfinished.length, ready.length, readyHead);
  }

  function renderGoalBootstrapStatus(language: SparkLanguage): string {
    return language === "zh"
      ? '当前 goal 尚未绑定项目。下一步：用 task_write({ action: "project_use", title, description }) 基于目标创建或选择项目，然后用 task_write({ action: "plan" }) 规划初始具体任务。不要等待用户手动建项目，除非目标意图确实不明确。'
      : 'No current project is selected for this goal. Next: create or select a project with task_write({ action: "project_use", title, description }) using the goal objective as project intent, then plan initial concrete tasks with task_write({ action: "plan" }). Do not wait for the user to create the project manually unless the goal intent is genuinely ambiguous.';
  }

  async function startDriver(
    ctx: SparkCommandContext,
    input: {
      driverId: string;
      kind: SparkDriverKind;
      continuity?: SparkDriverContinuity;
      prompt: string;
      reason?: string;
    },
    preparedOwnerSessionId?: string,
  ): Promise<SparkDriverView> {
    const ownerSessionId =
      preparedOwnerSessionId ?? (await prepareSparkDaemonDriverOwner(ctx, deps.driverControl));
    const result = await deps.driverControl.start({
      ...input,
      ownerSessionId,
      continuity: input.continuity ?? "session",
      cwd: ctx.cwd,
    });
    return result.driver;
  }

  async function driverForKind(
    ctx: SparkCommandContext,
    kind: SparkDriverKind,
  ): Promise<SparkDriverView | undefined> {
    const ownerSessionId = sparkDaemonDriverOwnerSessionId(ctx);
    const result = await deps.driverControl.list({
      ownerSessionId,
      includeStopped: false,
    });
    return result.drivers.find((driver) => driver.kind === kind);
  }

  async function stopDriverForKind(
    ctx: SparkCommandContext,
    kind: SparkDriverKind,
    reason: string,
  ): Promise<void> {
    const driver = await driverForKind(ctx, kind);
    if (driver) await deps.driverControl.stop({ driverId: driver.driverId, reason });
  }

  function parseFreshLoopArgs(rawArgs: string): {
    args: string;
    continuity: SparkDriverContinuity;
  } {
    const tokens = rawArgs.trim().split(/\s+/u).filter(Boolean);
    const freshIndex = tokens.findIndex((token) => token === "fresh" || token === "--fresh");
    if (freshIndex < 0) return { args: rawArgs, continuity: "session" };
    tokens.splice(freshIndex, 1);
    return { args: tokens.join(" "), continuity: "fresh" };
  }
}
