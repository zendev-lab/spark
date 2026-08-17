import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { sparkSessionKey } from "@zendev-lab/spark-extension/host-support";
import { sparkTuiCliStrings, sparkTuiPiParityStrings } from "@zendev-lab/spark-i18n/cli";
import { isTaskStatus } from "@zendev-lab/spark-core";
import {
  createId,
  SPARK_PROTOCOL_VERSION,
  SPARK_SESSION_PROMPT_HISTORY_MAX,
  type SparkMessageView,
  type SparkSessionPromptHistoryEntry,
  type SparkSessionProjection,
  type SparkSessionView,
  type SparkTaskView,
  type SparkThinkingLevel,
  type SparkTurnResult,
} from "@zendev-lab/spark-protocol";

import {
  attachSparkWorkspaceClient,
  attachSparkWorkspaceSessionClient,
  clientCancelTurn,
  clientCreateManagedSession,
  clientGetManagedSession,
  clientGetManagedSessionPromptHistory,
  clientGetManagedSessionSnapshot,
  clientListDaemonWorkspaces,
  clientListManagedSessions,
  clientResolveSessionCwd,
  clientRestoreManagedSession,
  clientTurnStatus,
  createSparkDaemonNativeCommands,
  createSparkDaemonNativeResponder,
  formatSparkDaemonTransportRetry,
  requestSparkDaemonControl,
  ensureSparkDaemonWorkspaceSession,
  handleSparkDaemonHumanInteractionRequest,
  handleSparkDaemonCliCommand,
  type SparkDaemonClientOptions,
  type SparkDaemonWorkspace,
  type SparkSessionCwdResolution,
} from "./cli/daemon.ts";
import {
  createSparkNativeLocalControlSlashCommands,
  createSparkNativeRuntimeSlashCommands,
  createSparkNativeSideThreadSlashCommands,
  createSparkNativeUiTransport,
  runNativeSparkTui,
  type RunNativeSparkTuiOptions,
  type SparkNativeSlashCommandMap,
  type SparkNativeTuiExitReason,
  type SparkNativeTuiApp,
  type SparkNativeWorkspaceSessionState,
} from "./native-tui.ts";
import {
  createSparkPiParitySlashCommands,
  PI_PARITY_COMMAND_NAMES,
} from "./cli/pi-parity-commands.ts";
import {
  createSparkDaemonModelAuthClient,
  daemonSnapshotToPickerState,
  resolveDaemonModelSelection,
  type SparkDaemonModelAuthClient,
} from "./cli/model-control.ts";
import { createSparkPromptTemplateSlashCommands } from "./cli/prompt-template-commands.ts";
import type { SparkCliHostServices, SparkCliHostServicesOptions } from "./host/bootstrap.ts";
import {
  formatSelection as formatSparkModelSelection,
  resolveSparkModelSelectionById,
  sparkModelSelectionValue,
  SPARK_MODEL_CYCLE_NEXT_BINDING_ID,
  SPARK_MODEL_CYCLE_PREV_BINDING_ID,
  SPARK_MODEL_PICKER_BINDING_ID,
  type SparkModelPickerState,
} from "./host/model-selector.ts";
import { loadSparkConfig, type SparkConfig } from "./host/config.ts";
import type { SparkActiveSelection } from "./host/provider-registry.ts";
import { registerSparkSessionsCommand } from "./host/session-navigation.ts";
import { SparkSessionStore, workspaceSessionHash } from "./host/session-store.ts";
import {
  createSparkModelPickerFromCustomUi,
  type SparkModelSelectorCustomUi,
} from "./tui/model-selector.ts";
import {
  formatSparkSessionListByWorkspace,
  runNativeSparkSessionSelector,
  type SparkSessionSelectorOptions,
  type SparkSessionSelectorSelection,
  type SparkSessionSelectorWorkspace,
} from "./tui/session-selector.ts";
import { renderSparkFirstRunOnboarding } from "./cli/onboarding.ts";
import {
  SPARK_TUI_RELOAD_EXIT_CODE,
  type SparkTuiReloadHandoff,
} from "./cli/process-supervisor.ts";
import {
  parseSparkCliArgs as parseSparkCliArgsShared,
  parseSparkCliCommand as parseSparkCliCommandShared,
  type SparkCliArgs,
  type SparkCliCommand,
  type SparkCliRuntimeOptions,
} from "./cli/args.ts";

export {
  type SparkCliArgs,
  type SparkCliCommand,
  type SparkCliRuntimeOptions,
} from "./cli/args.ts";

const tuiCliStrings = sparkTuiCliStrings();

export interface SparkCliTerminalState {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export interface RunSparkCliOptions {
  daemonClient?: SparkDaemonClientOptions;
  attachSessionClient?: typeof attachSparkWorkspaceSessionClient;
  runTui?: (input?: string | RunNativeSparkTuiOptions) => Promise<SparkNativeTuiExitReason | void>;
  selectSession?: (
    options: SparkSessionSelectorOptions,
  ) => Promise<SparkSessionSelectorSelection | null>;
  selectSessionCwd?: (
    options: SparkSessionCwdSelectorOptions,
  ) => Promise<SparkSessionCwdSelection | null>;
  createHostServices?: SparkCliHostServicesFactory;
  /** Test/embedding override; production uses process.cwd() as a non-mutating selector suggestion. */
  launchCwd?: string;
  terminal?: SparkCliTerminalState;
  onReload?: (handoff: SparkTuiReloadHandoff) => void | Promise<void>;
}

export interface SparkSessionCwdSelection {
  cwd?: string;
  cwdArtifactRef?: string;
}

export interface SparkSessionCwdSelectorOptions {
  currentCwd: string;
  currentCwdArtifactRef?: string;
  workspaceRoot: string;
  gitChanges: Array<{ artifactRef: string; title: string }>;
}

type SparkCliHostServicesFactory = (
  options?: SparkCliHostServicesOptions,
) => Promise<SparkCliHostServices>;

export function parseSparkCliArgs(argv: string[]): SparkCliArgs {
  return parseSparkCliArgsShared(argv);
}

export function parseSparkCliCommand(argv: string[]): SparkCliCommand {
  return parseSparkCliCommandShared(argv);
}

interface SparkCliSessionAttachResolution {
  target?: string;
  state: SparkNativeWorkspaceSessionState;
  attachMatchesControlPlane: boolean;
  shouldEmitSessionStart: boolean;
}

interface SparkCliLegacySessionTarget {
  sessionId: string;
  sessionPath: string;
}

interface SparkCliControlPlaneSelection {
  workspace?: SparkSessionSelectorWorkspace;
  session?: SparkSessionProjection;
  legacySession?: SparkCliLegacySessionTarget;
  create?: boolean;
  cancelled?: boolean;
  cwdSuggestion?: SparkSessionCwdResolution;
}

async function selectSparkCliWorkspaceSession(
  runtimeOptions: SparkCliRuntimeOptions | undefined,
  daemonClient: SparkDaemonClientOptions,
  selectSession: (
    options: SparkSessionSelectorOptions,
  ) => Promise<SparkSessionSelectorSelection | null>,
  launchCwd: string,
): Promise<SparkCliControlPlaneSelection> {
  const [sessions, registeredWorkspaces, resolvedLaunchCwd] = await Promise.all([
    clientListManagedSessions({ includeArchived: true }, daemonClient),
    listSparkSessionSelectorWorkspaces(daemonClient),
    clientResolveSessionCwd(launchCwd, daemonClient).catch(() => undefined),
  ]);
  const target = requestedSparkCliSessionTarget(runtimeOptions);
  if (target) {
    const session = await resolveExplicitManagedSessionTarget(
      sessions,
      target,
      launchCwd,
      daemonClient,
    );
    if (session) {
      if (session.scope.kind !== "workspace") {
        throw new Error(`Spark TUI session has no workspace owner: ${target}`);
      }
      if (session.lifecycle !== "open") {
        throw new Error(`Spark TUI session is ${session.lifecycle}: ${target}`);
      }
      const activeSession =
        session.placement === "archived"
          ? await clientRestoreManagedSession(session.sessionId, daemonClient)
          : session;
      if (
        activeSession.sessionId !== session.sessionId ||
        activeSession.scope.kind !== "workspace" ||
        activeSession.scope.workspaceId !== session.scope.workspaceId ||
        activeSession.lifecycle !== "open" ||
        activeSession.placement === "archived"
      ) {
        throw new Error(`Spark TUI session restore returned an invalid record: ${target}`);
      }
      return {
        workspace: requireSelectorWorkspace(registeredWorkspaces, activeSession.scope.workspaceId),
        session: activeSession,
      };
    }
    const legacy = await resolveLegacySparkCliSessionTarget(
      target,
      runtimeOptions,
      registeredWorkspaces,
      launchCwd,
    );
    if (legacy) return legacy;
    throw new Error(`Spark TUI session was not found in the daemon registry: ${target}`);
  }

  const { workspaces, suggestedWorkspaceId } = workspaceOptionsForLaunchCwd(
    registeredWorkspaces,
    launchCwd,
    resolvedLaunchCwd?.workspace.id,
  );
  if (workspaces.length === 0) {
    throw new Error(
      `No available registered Spark workspace. Register ${launchCwd} with spark daemon workspace register before opening the TUI.`,
    );
  }
  const selection = await selectSession({
    sessions: sessions.filter((session) => session.scope.kind === "workspace"),
    workspaces,
    ...(suggestedWorkspaceId ? { suggestedWorkspaceId } : {}),
  });
  if (!selection) return { cancelled: true };
  assertSparkSessionSelectorSelection(selection);
  const workspace = requireSelectorWorkspace(workspaces, selection.workspaceId);
  if (selection.kind === "create") {
    const cwdSuggestion =
      resolvedLaunchCwd &&
      requireSelectorWorkspace(workspaces, resolvedLaunchCwd.workspace.id).canonicalId ===
        workspace.canonicalId
        ? resolvedLaunchCwd
        : undefined;
    return { workspace, create: true, ...(cwdSuggestion ? { cwdSuggestion } : {}) };
  }

  const session = requireSelectedManagedSession(sessions, selection.sessionId);
  if (session.scope.kind !== "workspace") {
    throw new Error(`Selected Spark session has no workspace owner: ${selection.sessionId}`);
  }
  const sessionWorkspaceId = session.scope.workspaceId;
  const sessionWorkspace = requireSelectorWorkspace(workspaces, sessionWorkspaceId);
  if (sessionWorkspace.canonicalId !== workspace.canonicalId) {
    throw new Error(
      `Selected Spark session workspace mismatch: ${sessionWorkspace.canonicalId} != ${workspace.canonicalId}`,
    );
  }
  if (session.lifecycle !== "open") {
    throw new Error(`Selected Spark session is ${session.lifecycle}: ${selection.sessionId}`);
  }
  if (session.placement !== "archived") return { workspace, session };

  const activeSession = await clientRestoreManagedSession(session.sessionId, daemonClient);
  if (
    activeSession.sessionId !== session.sessionId ||
    activeSession.scope.kind !== "workspace" ||
    activeSession.scope.workspaceId !== sessionWorkspaceId ||
    activeSession.lifecycle !== "open" ||
    activeSession.placement === "archived"
  ) {
    throw new Error(
      `Selected Spark session restore returned an invalid record: ${selection.sessionId}`,
    );
  }
  return { workspace, session: activeSession };
}

function assertSparkSessionSelectorSelection(
  selection: SparkSessionSelectorSelection,
): asserts selection is SparkSessionSelectorSelection {
  if (!selection || typeof selection !== "object") {
    throw new Error("Spark session selection must include an explicit workspace.");
  }
  if (!selection.workspaceId?.trim()) {
    throw new Error("Spark session selection must include an explicit workspace.");
  }
  if (selection.kind === "create") return;
  if (selection.kind === "session" && selection.sessionId?.trim()) return;
  throw new Error("Spark session selector returned an invalid selection.");
}

function workspaceOptionsForLaunchCwd(
  registeredWorkspaces: SparkSessionSelectorWorkspace[],
  launchCwd: string,
  resolvedWorkspaceId?: string,
): { workspaces: SparkSessionSelectorWorkspace[]; suggestedWorkspaceId?: string } {
  if (resolvedWorkspaceId) {
    const resolvedWorkspace = registeredWorkspaces.find(
      (workspace) =>
        workspace.id === resolvedWorkspaceId || workspace.canonicalId === resolvedWorkspaceId,
    );
    if (resolvedWorkspace) {
      return {
        workspaces: registeredWorkspaces,
        suggestedWorkspaceId: resolvedWorkspace.canonicalId,
      };
    }
  }
  const canonicalWorkspaces = uniqueSelectorWorkspaces(registeredWorkspaces);
  const resolvedLaunchCwd = safeRealpath(launchCwd) ?? launchCwd;
  const matchingWorkspace = canonicalWorkspaces
    .filter((workspace) => {
      const root = safeRealpath(workspace.localPath) ?? workspace.localPath;
      return isSameOrChildPath(resolvedLaunchCwd, root);
    })
    .sort((left, right) => right.localPath.length - left.localPath.length)[0];
  if (matchingWorkspace) {
    return {
      workspaces: registeredWorkspaces,
      suggestedWorkspaceId: matchingWorkspace.canonicalId,
    };
  }

  const fallback = canonicalWorkspaces[0];
  return {
    workspaces: registeredWorkspaces,
    ...(fallback ? { suggestedWorkspaceId: fallback.canonicalId } : {}),
  };
}

function uniqueSelectorWorkspaces(
  workspaces: SparkSessionSelectorWorkspace[],
): SparkSessionSelectorWorkspace[] {
  const canonical = new Map<string, SparkSessionSelectorWorkspace>();
  for (const workspace of workspaces) {
    const current = canonical.get(workspace.canonicalId);
    if (!current || workspace.id === workspace.canonicalId) {
      canonical.set(workspace.canonicalId, workspace);
    }
  }
  return [...canonical.values()];
}

function requireSelectorWorkspace(
  workspaces: SparkSessionSelectorWorkspace[],
  workspaceId: string,
): SparkSessionSelectorWorkspace {
  const workspace = workspaces.find(
    (candidate) => candidate.id === workspaceId || candidate.canonicalId === workspaceId,
  );
  if (!workspace)
    throw new Error(`Selected Spark workspace is no longer available: ${workspaceId}`);
  return (
    workspaces.find(
      (candidate) =>
        candidate.canonicalId === workspace.canonicalId && candidate.id === candidate.canonicalId,
    ) ?? workspace
  );
}

function requireSelectedManagedSession(
  sessions: SparkSessionProjection[],
  sessionId: string,
): SparkSessionProjection {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!session) throw new Error(`Selected Spark session is no longer available: ${sessionId}`);
  return session;
}

function attachResolutionForManagedSession(
  baseState: Omit<SparkNativeWorkspaceSessionState, "mode">,
  sessionId: string,
  session: SparkSessionProjection | undefined,
  controlPlaneWorkspaceId: string,
): SparkCliSessionAttachResolution {
  const workspaceDir = baseState.workspaceDir;
  const ownsControlPlane = session?.scope.kind === "workspace" && Boolean(controlPlaneWorkspaceId);
  return {
    target: sessionId,
    state: {
      ...baseState,
      mode: "attached",
      sessionId: sparkSessionKey({ sessionId }),
      workspaceDir,
      workspaceHash: ownsControlPlane
        ? baseState.workspaceHash
        : workspaceSessionHash(workspaceDir),
      attachTarget: sessionId,
      ...(session?.name?.trim() ? { sessionName: session.name.trim() } : {}),
    },
    attachMatchesControlPlane: ownsControlPlane,
    shouldEmitSessionStart: ownsControlPlane,
  };
}

async function managedSessionSnapshotIfAvailable(
  sessionId: string,
  daemonClient: SparkDaemonClientOptions,
): Promise<SparkSessionView | undefined> {
  try {
    return await clientGetManagedSessionSnapshot(sessionId, daemonClient);
  } catch {
    return undefined;
  }
}

async function loadManagedSessionPromptHistory(
  sessionId: string,
  daemonClient: SparkDaemonClientOptions,
): Promise<SparkSessionPromptHistoryEntry[]> {
  try {
    const history = await clientGetManagedSessionPromptHistory(
      sessionId,
      daemonClient,
      SPARK_SESSION_PROMPT_HISTORY_MAX,
    );
    return history.prompts;
  } catch {
    return [];
  }
}

function requestedSparkCliSessionTarget(
  options: SparkCliRuntimeOptions | undefined,
): string | undefined {
  return (
    options?.sessionId?.trim() ||
    options?.session?.trim() ||
    options?.sparkSessionKey?.trim() ||
    undefined
  );
}

async function resolveExplicitManagedSessionTarget(
  sessions: SparkSessionProjection[],
  target: string,
  launchCwd: string,
  daemonClient: SparkDaemonClientOptions,
): Promise<SparkSessionProjection | undefined> {
  const candidateIds = explicitSessionIdCandidates(target);
  for (const candidateId of candidateIds) {
    const listed = sessions.find((session) => session.sessionId === candidateId);
    if (listed) return listed;
  }

  if (looksLikeSparkSessionPath(target)) {
    const normalizedTarget = target.startsWith("file://") ? fileURLToPath(target) : target;
    const matchingSessions = sessions.filter((session) => {
      if (!session.sessionPath) return false;
      const sessionCwd = session.cwd ?? launchCwd;
      const sessionPath = resolve(sessionCwd, session.sessionPath);
      const resolvedSessionPath = safeRealpath(sessionPath) ?? sessionPath;
      return [resolve(launchCwd, normalizedTarget), resolve(sessionCwd, normalizedTarget)].some(
        (candidate) => (safeRealpath(candidate) ?? candidate) === resolvedSessionPath,
      );
    });
    if (matchingSessions.length > 1) {
      throw new Error(`Spark TUI session path is ambiguous in the daemon registry: ${target}`);
    }
    return matchingSessions[0];
  }

  for (const candidateId of candidateIds) {
    const session = await clientGetManagedSession(candidateId, daemonClient).catch(() => undefined);
    if (session) return session;
  }
  return undefined;
}

async function resolveLegacySparkCliSessionTarget(
  target: string,
  runtimeOptions: SparkCliRuntimeOptions | undefined,
  registeredWorkspaces: SparkSessionSelectorWorkspace[],
  launchCwd: string,
): Promise<
  | (SparkCliControlPlaneSelection & {
      workspace: SparkSessionSelectorWorkspace;
      legacySession: SparkCliLegacySessionTarget;
    })
  | undefined
> {
  const { workspaces, suggestedWorkspaceId } = workspaceOptionsForLaunchCwd(
    registeredWorkspaces,
    launchCwd,
  );
  const candidates = looksLikeSparkSessionPath(target)
    ? uniqueSelectorWorkspaces(workspaces)
    : suggestedWorkspaceId
      ? [requireSelectorWorkspace(workspaces, suggestedWorkspaceId)]
      : [];
  const matches: Array<{
    workspace: SparkSessionSelectorWorkspace;
    legacySession: SparkCliLegacySessionTarget;
  }> = [];

  for (const workspace of candidates) {
    const store = new SparkSessionStore({
      cwd: workspace.localPath,
      ...(runtimeOptions?.sessionDir ? { sparkHome: runtimeOptions.sessionDir } : {}),
    });
    const record = looksLikeSparkSessionPath(target)
      ? await loadLegacySessionPath(store, target, launchCwd, workspace.localPath)
      : await findLegacySessionById(store, explicitSessionIdCandidates(target));
    if (!record || record.header.visibility === "internal") continue;
    matches.push({
      workspace,
      legacySession: { sessionId: record.header.id, sessionPath: record.path },
    });
  }

  if (matches.length > 1) {
    throw new Error(`Spark TUI legacy session target is ambiguous across workspaces: ${target}`);
  }
  return matches[0];
}

async function loadLegacySessionPath(
  store: SparkSessionStore,
  target: string,
  launchCwd: string,
  workspaceCwd: string,
) {
  const normalizedTarget = target.startsWith("file://") ? fileURLToPath(target) : target;
  const sessionDir = safeRealpath(store.sessionDir) ?? store.sessionDir;
  const candidates = new Set([
    resolve(launchCwd, normalizedTarget),
    resolve(workspaceCwd, normalizedTarget),
  ]);
  for (const candidate of candidates) {
    const resolvedCandidate = safeRealpath(candidate) ?? candidate;
    if (!isSameOrChildPath(resolvedCandidate, sessionDir)) continue;
    try {
      return await store.load(resolvedCandidate);
    } catch {
      // Continue so the same relative ref can be checked against the owning workspace.
    }
  }
  return undefined;
}

async function findLegacySessionById(store: SparkSessionStore, candidateIds: string[]) {
  for (const candidateId of candidateIds) {
    const record = await store.findById(candidateId);
    if (record) return record;
  }
  return undefined;
}

function explicitSessionIdCandidates(target: string): string[] {
  return [
    target,
    target.startsWith("session:") ? target.slice("session:".length) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function looksLikeSparkSessionPath(value: string): boolean {
  return (
    value.startsWith("file://") ||
    value.endsWith(".jsonl") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

async function ensureLegacyManagedSession(
  legacy: SparkCliLegacySessionTarget,
  workspaceId: string,
  cwd: string,
  daemonClient: SparkDaemonClientOptions,
): Promise<SparkSessionProjection> {
  const sessions = await clientListManagedSessions({ includeArchived: true }, daemonClient);
  const administrator = sessions.find(
    (session) =>
      session.scope.kind === "workspace" &&
      session.scope.workspaceId === workspaceId &&
      session.owner.kind === "workspace",
  );
  if (!administrator) {
    throw new Error(`workspace ${workspaceId} has no reconciled Administrator Session`);
  }
  try {
    return await clientCreateManagedSession(
      {
        sessionId: legacy.sessionId,
        scope: { kind: "workspace", workspaceId },
        supervisorSessionId: administrator.sessionId,
        roleBinding: { kind: "none" },
        cwd,
        sessionPath: legacy.sessionPath,
      },
      daemonClient,
    );
  } catch (createError) {
    const existing = await clientGetManagedSession(legacy.sessionId, daemonClient).catch(
      () => undefined,
    );
    if (!existing) throw createError;
    if (existing.placement === "archived") {
      throw new Error(`Spark TUI session is archived: ${legacy.sessionId}`);
    }
    if (existing.lifecycle !== "open") {
      throw new Error(`Spark TUI session is ${existing.lifecycle}: ${legacy.sessionId}`);
    }
    if (existing.scope.kind !== "workspace" || existing.scope.workspaceId !== workspaceId) {
      throw new Error(`Spark TUI legacy session id belongs to another scope: ${legacy.sessionId}`);
    }
    const absoluteExistingPath = existing.sessionPath
      ? resolve(existing.cwd ?? cwd, existing.sessionPath)
      : undefined;
    const existingPath = absoluteExistingPath
      ? (safeRealpath(absoluteExistingPath) ?? absoluteExistingPath)
      : undefined;
    const absoluteLegacyPath = resolve(cwd, legacy.sessionPath);
    const legacyPath = safeRealpath(absoluteLegacyPath) ?? absoluteLegacyPath;
    if (existingPath !== legacyPath) {
      throw new Error(
        `Spark TUI legacy session id already points at another transcript: ${legacy.sessionId}`,
      );
    }
    return existing;
  }
}

function runtimeOptionsWithoutSparkSessionTarget(
  options: SparkCliRuntimeOptions | undefined,
): SparkCliRuntimeOptions | undefined {
  if (!options) return undefined;
  const result = { ...options };
  delete result.session;
  delete result.sessionId;
  delete result.sparkSessionKey;
  return result;
}

function runtimeOptionsForSparkSession(
  options: SparkCliRuntimeOptions | undefined,
  sessionId: string,
): SparkCliRuntimeOptions {
  return {
    ...runtimeOptionsWithoutSparkSessionTarget(options),
    sessionId,
  };
}

export function sparkTuiReloadArgv(
  options: SparkCliRuntimeOptions | undefined,
  sessionId: string,
): string[] {
  const argv: string[] = [];
  const value = (flag: string, entry: string | undefined) => {
    if (entry !== undefined) argv.push(flag, entry);
  };
  const repeated = (flag: string, entries: readonly string[] | undefined) => {
    for (const entry of entries ?? []) argv.push(flag, entry);
  };

  value("--provider", options?.provider);
  value("--model", options?.model);
  value("--session-dir", options?.sessionDir);
  value("--name", options?.name);
  repeated("--extension", options?.extensions);
  if (options?.noExtensions) argv.push("--no-extensions");
  repeated("--skill", options?.skills);
  if (options?.noSkills) argv.push("--no-skills");
  repeated("--prompt-template", options?.promptTemplates);
  if (options?.noPromptTemplates) argv.push("--no-prompt-templates");
  repeated("--theme", options?.themes);
  if (options?.noThemes) argv.push("--no-themes");
  if (options?.noContextFiles) argv.push("--no-context-files");
  value("--thinking", options?.thinking);
  if (options?.tools?.length) argv.push("--tools", options.tools.join(","));
  if (options?.excludeTools?.length) {
    argv.push("--exclude-tools", options.excludeTools.join(","));
  }
  if (options?.projectTrustOverride === true) argv.push("--approve");
  if (options?.projectTrustOverride === false) argv.push("--no-approve");
  argv.push("--session-id", sessionId);
  return argv;
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isLocalDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSameOrChildPath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function sparkSessionSelectorWorkspaceIds(workspace: SparkDaemonWorkspace): string[] {
  return [workspace.id, workspace.serverWorkspaceId, workspace.localWorkspaceKey].filter(
    (id): id is string => Boolean(id),
  );
}

async function listSparkSessionSelectorWorkspaces(
  daemonClient: SparkDaemonClientOptions,
): Promise<SparkSessionSelectorWorkspace[]> {
  const { workspaces } = await clientListDaemonWorkspaces(daemonClient);
  return workspaces.flatMap((workspace) => {
    if (!isLocalDirectory(workspace.localPath)) return [];
    return sparkSessionSelectorWorkspaceIds(workspace).map((id) => ({
      id,
      canonicalId: workspace.id,
      displayName: workspace.displayName,
      localPath: workspace.localPath,
      registration: "registered" as const,
    }));
  });
}

async function listWorkspaceGitChanges(
  lease: Awaited<ReturnType<typeof attachSparkWorkspaceClient>>,
  daemonClient: SparkDaemonClientOptions,
): Promise<Array<{ artifactRef: string; title: string }>> {
  try {
    const result = await requestSparkDaemonControl(
      "artifact.execute",
      {
        cwd: lease.workspace.localPath,
        toolCallId: createId("cmd"),
        operationId: createId("idem"),
        params: { action: "list", kind: "git_change" },
        hostContext: { workspaceId: lease.workspace.id, sessionSource: "tui", hasUI: true },
      },
      daemonClient,
    );
    const artifacts = result.details?.artifacts;
    if (!Array.isArray(artifacts)) return [];
    return artifacts.flatMap((artifact) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return [];
      const artifactRef = (artifact as Record<string, unknown>).ref;
      const title = (artifact as Record<string, unknown>).title;
      return typeof artifactRef === "string" && typeof title === "string"
        ? [{ artifactRef, title }]
        : [];
    });
  } catch {
    return [];
  }
}

async function runNativeSparkSessionCwdSelector(
  options: SparkSessionCwdSelectorOptions,
): Promise<SparkSessionCwdSelection | null> {
  const roots = [
    { label: `Current cwd · ${options.currentCwd}`, kind: "current" as const },
    { label: `Workspace root · ${options.workspaceRoot}`, kind: "workspace" as const },
    ...options.gitChanges.map((change) => ({
      label: `GitChange · ${change.title} · ${change.artifactRef}`,
      kind: "artifact" as const,
      artifactRef: change.artifactRef,
    })),
  ];
  console.error("\nSelect execution root:");
  roots.forEach((root, index) => console.error(`  ${index + 1}. ${root.label}`));
  const readline = createInterface({ input: processStdin, output: processStdout });
  try {
    const answer = (await readline.question("Root [1], or q to cancel: ")).trim();
    if (answer.toLowerCase() === "q") return null;
    const index = answer ? Number.parseInt(answer, 10) - 1 : 0;
    const selected = roots[index];
    if (!selected) return null;
    if (selected.kind === "current") {
      return {
        cwd: options.currentCwd,
        ...(options.currentCwdArtifactRef ? { cwdArtifactRef: options.currentCwdArtifactRef } : {}),
      };
    }
    const cwd = (await readline.question("Relative subdirectory [.]: ")).trim();
    return {
      ...(cwd && cwd !== "." ? { cwd } : {}),
      ...(selected.kind === "artifact" ? { cwdArtifactRef: selected.artifactRef } : {}),
    };
  } finally {
    readline.close();
  }
}

async function resolveSparkWorkspaceBindingId(
  workspaceId: string,
  controlPlaneWorkspace: SparkDaemonWorkspace,
  daemonClient: SparkDaemonClientOptions,
): Promise<string> {
  if (sparkSessionSelectorWorkspaceIds(controlPlaneWorkspace).includes(workspaceId)) {
    return controlPlaneWorkspace.id;
  }
  const workspaces = await listSparkSessionSelectorWorkspaces(daemonClient);
  return workspaces.find((workspace) => workspace.id === workspaceId)?.canonicalId ?? workspaceId;
}

async function daemonSparkSessionListText(
  services: SparkCliHostServices,
  daemonClient: SparkDaemonClientOptions,
  workspace: { workspaceId: string; workspaceLabel: string },
): Promise<string | undefined> {
  try {
    const [sessions, workspaces] = await Promise.all([
      clientListManagedSessions({}, daemonClient),
      listSparkSessionSelectorWorkspaces(daemonClient),
    ]);
    return formatSparkSessionListByWorkspace({
      sessions,
      workspaces,
      suggestedWorkspaceId: workspace.workspaceId,
    });
  } catch {
    return await durableSparkSessionListText(services);
  }
}

async function durableSparkSessionListText(
  services: SparkCliHostServices,
): Promise<string | undefined> {
  const stateRoot = services.runtime.makeContext().sparkStateRoot?.trim();
  if (!stateRoot) return undefined;
  const indexPath = join(stateRoot, "sessions", "index.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
    return undefined;
  }
  const lines = ["Spark durable sessions:"];
  for (const session of parsed.sessions.slice(0, 12)) {
    if (!isRecord(session)) continue;
    const sessionKey = stringField(session, "sessionKey") ?? "session:unknown";
    const project = stringField(session, "currentProjectRef");
    const task = stringField(session, "currentTaskRef");
    const activeGoal = session.activeGoal === true ? " goal=active" : "";
    const updated = stringField(session, "updatedAt");
    lines.push(
      `- ${sessionKey}${project ? ` project=${project}` : ""}${task ? ` task=${task}` : ""}${activeGoal}${updated ? ` updated=${updated}` : ""}`,
    );
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

async function hydrateNativeHubFromTaskRead(
  services: SparkCliHostServices,
  app: SparkNativeTuiApp,
  workspaceSession: SparkNativeWorkspaceSessionState,
): Promise<void> {
  const tool = services.runtime.getTool("task_read")?.config;
  if (!tool) return;
  let details: Record<string, unknown> | undefined;
  try {
    const result = await tool.execute(
      "native-hub-hydrate",
      { action: "project_status", view: "active", format: "json", limit: 6 },
      new AbortController().signal,
      () => undefined,
      services.runtime.makeContext(),
    );
    details = isRecord(result.details) ? result.details : parseFirstJsonContent(result.content);
  } catch {
    return;
  }
  if (!details?.found) return;
  const selectedProject = isRecord(details.selectedProject)
    ? details.selectedProject
    : isRecord(details.activeProject)
      ? details.activeProject
      : undefined;
  const projectTitle = stringField(selectedProject, "title");
  const tasks: SparkTaskView[] = [];
  addCompactTaskView(tasks, details.currentClaim);
  addCompactTaskViews(tasks, details.ready);
  addCompactTaskView(tasks, details.selectedTask);
  app.hydrateHub({
    sessionId: workspaceSession.attachTarget ?? workspaceSession.controlPlaneSessionId,
    ...(projectTitle ? { sessionTitle: projectTitle } : {}),
    sessionStatus: "idle",
    tasks,
  });
}

function addCompactTaskViews(output: SparkTaskView[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) addCompactTaskView(output, entry);
}

function addCompactTaskView(output: SparkTaskView[], value: unknown): void {
  if (!isRecord(value)) return;
  const ref = stringField(value, "ref");
  const title = stringField(value, "title");
  const status = stringField(value, "status");
  if (!ref || !title || !status || !isTaskStatus(status) || output.some((task) => task.ref === ref))
    return;
  const todosRecord = isRecord(value.todos) ? value.todos : undefined;
  const todoItems = Array.isArray(todosRecord?.items) ? todosRecord.items : [];
  output.push({
    version: SPARK_PROTOCOL_VERSION,
    ref,
    ...(stringField(value, "name") ? { name: stringField(value, "name") } : {}),
    title,
    ...(stringField(value, "kind") ? { kind: stringField(value, "kind") } : {}),
    status,
    ...(stringField(value, "projectRef") ? { projectRef: stringField(value, "projectRef") } : {}),
    ...(stringField(value, "owner") ? { owner: stringField(value, "owner") } : {}),
    todos: todoItems.filter(isRecord).map((todo) => ({
      id: stringField(todo, "id") ?? "todo",
      content: stringField(todo, "content") ?? "todo",
      status: sparkTaskTodoStatus(stringField(todo, "status")),
      notes: [],
    })),
    runRefs: [],
    evidenceRefs: [],
    artifactRefs: [],
    metadata: {},
  });
}

function sparkTaskTodoStatus(value: string | undefined): SparkTaskView["todos"][number]["status"] {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "done" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "pending";
}

function parseFirstJsonContent(
  content: Array<{ type: "text"; text: string }>,
): Record<string, unknown> | undefined {
  const text = content.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function runSparkCli(
  argv: string[] = process.argv.slice(2),
  options: RunSparkCliOptions = {},
): Promise<number> {
  const command = parseSparkCliCommand(argv);
  const daemonClient = options.daemonClient ?? {};
  switch (command.kind) {
    case "help":
      printHelp();
      return 0;
    case "error":
      throw new Error(command.message);
    case "run": {
      const sessionId =
        command.options?.sessionId ??
        command.options?.session ??
        `spark-print-${Date.now().toString(36)}`;
      const lease = await attachSparkWorkspaceClient(daemonClient, {
        kind: "headless",
        displayName: tuiCliStrings.headlessDisplayName,
        heartbeatIntervalMs: false,
      });
      try {
        await ensureSparkDaemonWorkspaceSession(
          {
            sessionId,
            workspaceId: lease.workspace.id,
            cwd: lease.cwd,
            ...(lease.cwdArtifactRef ? { cwdArtifactRef: lease.cwdArtifactRef } : {}),
          },
          daemonClient,
        );
        const result = await handleSparkDaemonCliCommand(
          {
            action: "submit",
            json: true,
            sessionId,
            prompt: command.prompt,
            model:
              command.options?.model &&
              command.options.provider &&
              !command.options.model.includes("/")
                ? `${command.options.provider}/${command.options.model}`
                : command.options?.model,
          },
          daemonClient,
        );

        if (!command.options?.wait) {
          // Default: queued ACK semantics
          if (command.json) printSparkJsonEventStream(command.prompt, sessionId, result);
          else console.log(JSON.stringify(result, null, 2));
          return 0;
        }

        // --wait: poll until terminal status, then fetch result
        const submitResult = (result as { result?: { invocationId?: string } }).result;
        const invocationId = submitResult?.invocationId;
        if (!invocationId) {
          console.error("No invocationId in submit response; cannot --wait.");
          return 1;
        }

        const waitResult = await waitForInvocationTerminal(invocationId, daemonClient);
        if (command.json) {
          printSparkJsonEventStream(
            command.prompt,
            sessionId,
            { result: waitResult },
            waitResult.status === "succeeded"
              ? (waitResult.assistantText ?? tuiCliStrings.headlessAccepted)
              : `[${waitResult.status}] ${waitResult.error?.message ?? ""}`,
          );
        } else {
          console.log(JSON.stringify(waitResult, null, 2));
        }
        if (waitResult.status === "succeeded") return 0;
        if (waitResult.status === "cancelled") return 2;
        return 1; // failed or unknown
      } finally {
        await lease.release();
      }
    }
    case "tui": {
      if (!isInteractiveSparkCliTerminal(options) && (options.terminal || !options.runTui)) {
        console.error(tuiCliStrings.tuiRequiresTty);
        return 2;
      }
      const selectSession = options.selectSession ?? runNativeSparkSessionSelector;
      let selectionOptions = command.options;
      let currentSessionOptions: SparkCliRuntimeOptions | undefined;
      let initialMessage = command.initialMessage;
      let hasLaunchedTui = false;
      while (true) {
        const selection = await selectSparkCliWorkspaceSession(
          selectionOptions,
          daemonClient,
          selectSession,
          options.launchCwd ?? process.cwd(),
        );
        if (selection.cancelled) {
          if (!currentSessionOptions) return 0;
          selectionOptions = currentSessionOptions;
          continue;
        }
        if (!selection.workspace) {
          throw new Error("Spark TUI requires an explicit workspace selection.");
        }
        const result = await runSparkCliTuiSelection({
          command,
          options,
          daemonClient,
          selection: selection as SparkCliControlPlaneSelection & {
            workspace: SparkSessionSelectorWorkspace;
          },
          initialMessage,
          hasLaunchedTui,
        });
        if (result.reloadHandoff) {
          if (!options.onReload) {
            throw new Error("Spark TUI reload requires the process supervisor.");
          }
          await options.onReload(result.reloadHandoff);
          return SPARK_TUI_RELOAD_EXIT_CODE;
        }
        if (result.cancelled) {
          selectionOptions = currentSessionOptions;
          continue;
        }
        currentSessionOptions = runtimeOptionsForSparkSession(command.options, result.sessionId);
        initialMessage = undefined;
        hasLaunchedTui = true;
        if (result.newSessionId) {
          selectionOptions = runtimeOptionsForSparkSession(command.options, result.newSessionId);
          continue;
        }
        if (!result.sessionSelectorRequested) return 0;
        selectionOptions = runtimeOptionsWithoutSparkSessionTarget(command.options);
      }
    }
  }
}

type SparkCliTuiSelectionResult =
  | { cancelled: true; reloadHandoff?: undefined }
  | {
      cancelled?: false;
      sessionId: string;
      sessionSelectorRequested: boolean;
      newSessionId?: string;
      reloadHandoff?: SparkTuiReloadHandoff;
    };

async function runSparkCliTuiSelection(input: {
  command: Extract<SparkCliCommand, { kind: "tui" }>;
  options: RunSparkCliOptions;
  daemonClient: SparkDaemonClientOptions;
  selection: SparkCliControlPlaneSelection & { workspace: SparkSessionSelectorWorkspace };
  initialMessage?: string;
  hasLaunchedTui: boolean;
}): Promise<SparkCliTuiSelectionResult> {
  const { command, options, daemonClient, selection } = input;
  const lease = await attachSparkWorkspaceClient(daemonClient, {
    kind: "interactive",
    displayName: tuiCliStrings.interactiveDisplayName,
    metadata: { surface: "tui" },
    ...(selection.workspace.registration === "suggested"
      ? { localPath: selection.workspace.localPath }
      : { workspaceId: selection.workspace.canonicalId }),
    onLeaseTransferPrompt: async (transfer) => {
      console.error(
        `\nLease transfer requested for “${transfer.workspaceDisplayName}” → ${transfer.targetServerUrl}`,
      );
      console.error("Accept within 30s or it auto-authorizes. [y] transfer / [n] keep");
      return await readLeaseTransferAnswer();
    },
  });
  try {
    const suggestedCwd = selection.cwdSuggestion ?? {
      workspace: lease.workspace,
      cwd: lease.workspace.localPath,
    };
    const selectSessionCwd =
      options.selectSessionCwd ??
      (options.selectSession ? undefined : runNativeSparkSessionCwdSelector);
    const cwdSelection = selection.create
      ? selectSessionCwd
        ? await selectSessionCwd({
            currentCwd: suggestedCwd.cwd,
            ...(suggestedCwd.cwdArtifactRef
              ? { currentCwdArtifactRef: suggestedCwd.cwdArtifactRef }
              : {}),
            workspaceRoot: lease.workspace.localPath,
            gitChanges: await listWorkspaceGitChanges(lease, daemonClient),
          })
        : {
            cwd: suggestedCwd.cwd,
            ...(suggestedCwd.cwdArtifactRef ? { cwdArtifactRef: suggestedCwd.cwdArtifactRef } : {}),
          }
      : undefined;
    if (selection.create && !cwdSelection) return { cancelled: true };
    let selectedManagedSession = selection.create
      ? await (async () => {
          const administrator = (
            await clientListManagedSessions({ includeArchived: true }, daemonClient)
          ).find(
            (session) =>
              session.scope.kind === "workspace" &&
              session.scope.workspaceId === lease.workspace.id &&
              session.owner.kind === "workspace",
          );
          if (!administrator) {
            throw new Error(
              `workspace ${lease.workspace.id} has no reconciled Administrator Session`,
            );
          }
          return await clientCreateManagedSession(
            {
              scope: { kind: "workspace", workspaceId: lease.workspace.id },
              supervisorSessionId: administrator.sessionId,
              roleBinding: { kind: "none" },
              ...(cwdSelection?.cwd ? { cwd: cwdSelection.cwd } : {}),
              ...(cwdSelection?.cwdArtifactRef
                ? { cwdArtifactRef: cwdSelection.cwdArtifactRef }
                : {}),
            },
            daemonClient,
          );
        })()
      : selection.legacySession
        ? await ensureLegacyManagedSession(
            selection.legacySession,
            lease.workspace.id,
            lease.workspace.localPath,
            daemonClient,
          )
        : selection.session;
    if (!selectedManagedSession || selectedManagedSession.scope.kind !== "workspace") {
      throw new Error("Spark TUI requires a selected daemon-managed workspace session.");
    }
    const sessionWorkspaceId = await resolveSparkWorkspaceBindingId(
      selectedManagedSession.scope.workspaceId,
      lease.workspace,
      daemonClient,
    );
    if (sessionWorkspaceId !== lease.workspace.id) {
      throw new Error(
        `Selected Spark session workspace mismatch: ${sessionWorkspaceId} != ${lease.workspace.id}`,
      );
    }
    const currentSessionId = selectedManagedSession.sessionId;
    const currentSessionIdentity = sparkSessionKey({ sessionId: currentSessionId });
    const sessionCwd = selectedManagedSession.cwd ?? lease.workspace.localPath;
    const createHostServices = options.createHostServices ?? createDefaultSparkCliHostServices;
    let pendingNativeUiTransport: ReturnType<typeof createSparkNativeUiTransport> | undefined;
    let activeNativeTuiApp: SparkNativeTuiApp | undefined;
    const setTransportRetryStatus = (text: string | undefined) => {
      const app = activeNativeTuiApp;
      if (app) {
        app.setStatus("spark-transport-retry", text);
        return;
      }
      pendingNativeUiTransport?.setStatus?.("spark-transport-retry", text);
    };
    const tuiDaemonClient: SparkDaemonClientOptions = {
      ...daemonClient,
      onTurnTransportRetry: (event) => {
        try {
          daemonClient.onTurnTransportRetry?.(event);
        } catch (error) {
          pendingNativeUiTransport?.notify?.(
            `transport retry observer failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        setTransportRetryStatus(formatSparkDaemonTransportRetry(event));
      },
      onTurnTransportReady: () => {
        try {
          daemonClient.onTurnTransportReady?.();
        } catch (error) {
          pendingNativeUiTransport?.notify?.(
            `transport ready observer failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        setTransportRetryStatus(undefined);
      },
    };
    const services = await createHostServices({
      ...(await hostServiceOptionsFromRuntime(command.options)),
      cwd: sessionCwd,
      workspaceId: sessionWorkspaceId,
      sparkStateRoot: join(lease.workspace.localPath, ".spark"),
      sessionSource: "tui",
      hasUI: true,
      modelPicker: (state, ctx) =>
        pendingNativeUiTransport
          ? createSparkModelPickerFromCustomUi(
              pendingNativeUiTransport as SparkModelSelectorCustomUi,
            )(state, ctx)
          : undefined,
    });
    if (selection.create) {
      const defaults = createSparkDaemonModelAuthClient(tuiDaemonClient, {
        sessionId: selectedManagedSession.sessionId,
      });
      const model = services.modelSelector.getActive();
      if (model) {
        try {
          selectedManagedSession = await defaults.setSessionModel(model);
        } catch {
          // A stale local model preference must not block opening a new session.
        }
      }
      if (services.config.activeThinkingLevel) {
        try {
          selectedManagedSession = await defaults.setSessionThinkingLevel(
            services.config.activeThinkingLevel,
          );
        } catch {
          // Preference initialization is best-effort; turn admission remains usable.
        }
      }
    }
    const baseState = {
      workspaceDir: services.cwd,
      workspaceHash: services.sessionStore.workspaceHash,
      controlPlaneSessionId: lease.client.id,
    } satisfies Omit<SparkNativeWorkspaceSessionState, "mode">;
    const workspaceSession = attachResolutionForManagedSession(
      baseState,
      currentSessionId,
      selectedManagedSession,
      lease.workspace.id,
    );
    const loadSnapshot = async () =>
      await managedSessionSnapshotIfAvailable(currentSessionId, tuiDaemonClient);
    services.runtime.setSessionContext({
      sessionId: currentSessionIdentity,
      cwd: sessionCwd,
      workspaceId: sessionWorkspaceId,
      sparkStateRoot: join(lease.workspace.localPath, ".spark"),
    });
    registerSparkSessionsCommand(services.runtime, {
      store: services.sessionStore,
      getNavigationState: () => undefined,
      listTextProvider: () =>
        daemonSparkSessionListText(services, tuiDaemonClient, {
          workspaceId: lease.workspace.id,
          workspaceLabel: `${lease.workspace.displayName} • ${services.cwd}`,
        }),
    });
    let activeModelControl: SparkDaemonModelAuthClient | undefined;
    const modelControl = createDelegatingSparkDaemonModelAuthClient(() => activeModelControl);
    registerSparkNativeModelCommand(services, modelControl);
    registerSparkDaemonModelKeybindings(services, modelControl);
    const ensureCurrentSession = async () => undefined;
    const firstRunOnboarding =
      input.hasLaunchedTui || input.initialMessage || !selection.create
        ? undefined
        : renderSparkFirstRunOnboarding(services);
    let sessionStatusModel =
      modelRefToSelection(selectedManagedSession.model) ?? services.modelSelector.getActive();
    let sessionStatusThinkingLevel =
      selectedManagedSession.thinkingLevel ?? services.config.activeThinkingLevel;
    const daemonModelControl = createSparkDaemonModelAuthClient(tuiDaemonClient, {
      sessionId: currentSessionId,
      ensureSession: ensureCurrentSession,
    });
    activeModelControl = {
      ...daemonModelControl,
      snapshot: async () => {
        const modelSnapshot = await daemonModelControl.snapshot();
        sessionStatusModel =
          modelRefToSelection(modelSnapshot.session?.model ?? modelSnapshot.defaultModel) ??
          sessionStatusModel;
        sessionStatusThinkingLevel =
          modelSnapshot.session?.thinkingLevel ?? sessionStatusThinkingLevel;
        return modelSnapshot;
      },
      setSessionModel: async (model) => {
        const session = await daemonModelControl.setSessionModel(model);
        sessionStatusModel = modelRefToSelection(session.model ?? model);
        return session;
      },
      setSessionThinkingLevel: async (thinkingLevel) => {
        const session = await daemonModelControl.setSessionThinkingLevel(thinkingLevel);
        sessionStatusThinkingLevel = session.thinkingLevel ?? thinkingLevel;
        await persistThinkingLevel(services, sessionStatusThinkingLevel);
        return session;
      },
    };
    let sessionSelectorRequested = false;
    let newSessionId: string | undefined;
    const runTui = options.runTui ?? runNativeSparkTui;
    const attachSessionClient = options.attachSessionClient ?? attachSparkWorkspaceSessionClient;
    const sessionHeartbeat = await attachSessionClient(tuiDaemonClient, {
      workspaceId: sessionWorkspaceId,
      sessionId: currentSessionIdentity,
    });
    services.runtime.setSessionLeaseProvider(() => {
      const current = sessionHeartbeat?.lease;
      if (!current) return undefined;
      return {
        workspaceId: current.workspaceId,
        clientId: current.clientId,
        leaseFence: current.leaseFence,
        sessionId: current.sessionId,
      };
    });
    let tuiExitReason: SparkNativeTuiExitReason | void;
    try {
      tuiExitReason = await runTui({
        initialMessage: input.initialMessage,
        responder: createSparkDaemonNativeResponder(tuiDaemonClient, {
          sessionId: currentSessionId,
          identitySessionId: currentSessionIdentity,
          workspaceId: sessionWorkspaceId,
          cwd: sessionCwd,
          ensureSession: ensureCurrentSession,
          conversationProjection: "view-events",
          onViewEvent: (event) => {
            pendingNativeUiTransport?.publishView?.(event);
          },
          onInteractionRequest: async (request, event, interactionContext) => {
            const interaction = pendingNativeUiTransport?.interaction;
            const app = activeNativeTuiApp;
            if (!interaction || !app) {
              throw new Error("Spark TUI interaction surface is not ready for this request.");
            }
            await app.withReloadBlocked(async () => {
              await handleSparkDaemonHumanInteractionRequest(request, event, {
                currentSessionId,
                client: tuiDaemonClient,
                ...(interactionContext.signal ? { signal: interactionContext.signal } : {}),
                interaction,
                notify: (message, level) => pendingNativeUiTransport?.notify?.(message, level),
              });
            });
          },
        }),
        workspaceSession: workspaceSession.state,
        slashCommands: createSparkNativeSlashCommands(
          services,
          tuiDaemonClient,
          modelControl,
          currentSessionId,
          sessionWorkspaceId,
          ensureCurrentSession,
          () => {
            sessionSelectorRequested = true;
          },
          async () => {
            const session = await clientCreateManagedSession(
              {
                scope: { kind: "workspace", workspaceId: lease.workspace.id },
                supervisorSessionId: selectedManagedSession.sessionId,
                roleBinding: { kind: "none" },
                cwd: sessionCwd,
                ...(selectedManagedSession.cwdArtifactRef
                  ? { cwdArtifactRef: selectedManagedSession.cwdArtifactRef }
                  : {}),
              },
              tuiDaemonClient,
            );
            newSessionId = session.sessionId;
          },
        ),
        autocompleteBasePath: sessionCwd,
        keybindings: services.keybindings,
        statusContext: {
          activeProvider: () => sessionStatusModel?.providerName,
          activeModel: () => sessionStatusModel?.modelId,
          thinkingLevel: () => sessionStatusThinkingLevel ?? "default",
          autoCompactionEnabled: () => true,
          contextWindow: () => {
            const active = sessionStatusModel;
            return active
              ? services.providerRegistry
                  .listModelsFor(active.providerName)
                  .find((model) => model.id === active.modelId)?.contextWindow
              : undefined;
          },
        },
        theme: services.theme,
        messageRenderers: new Map(
          services.runtime
            .listMessageRenderers()
            .map(({ customType, renderer }) => [customType, renderer]),
        ),
        configureApp: async (app, session) => {
          activeNativeTuiApp = app;
          pendingNativeUiTransport = createSparkNativeUiTransport(app, session);
          services.runtime.setUiTransport(pendingNativeUiTransport);
          app.setWorkspaceSession(workspaceSession.state);
          // runNativeSparkTui awaits configuration before starting terminal input or
          // submitting the initial prompt, so hydrate daemon-owned history inside
          // that startup barrier instead of racing it in a detached task.
          const [snapshot] = await Promise.all([
            loadSnapshot(),
            session.hydrateRetryableFailure().catch(() => undefined),
          ]);
          if (snapshot) {
            const durablePrompts =
              snapshot.messages.length > 0
                ? await loadManagedSessionPromptHistory(currentSessionId, tuiDaemonClient)
                : [];
            app.hydratePromptHistory(durablePrompts);
            sessionStatusModel = modelRefToSelection(snapshot.model) ?? sessionStatusModel;
            sessionStatusThinkingLevel = snapshot.thinkingLevel ?? sessionStatusThinkingLevel;
            app.applyViewModelEvent({
              version: SPARK_PROTOCOL_VERSION,
              type: "session.snapshot",
              session: snapshot,
            });
          }
          if (workspaceSession.attachMatchesControlPlane) {
            await hydrateNativeHubFromTaskRead(services, app, workspaceSession.state);
          }
          if (workspaceSession.shouldEmitSessionStart) {
            await services.runtime.emit("session_start", {
              source: "native-tui",
              workspaceDir: workspaceSession.state.workspaceDir,
              workspaceHash: workspaceSession.state.workspaceHash,
              controlPlaneSessionId: workspaceSession.state.controlPlaneSessionId,
              attachTarget: workspaceSession.target,
            });
          }
          if (firstRunOnboarding) {
            session.addCustomMessage({
              customType: "first-run-onboarding",
              content: firstRunOnboarding,
              display: true,
            });
          }
        },
      });
    } finally {
      activeNativeTuiApp = undefined;
      services.runtime.setSessionLeaseProvider(undefined);
      await stopSparkSessionHeartbeat(sessionHeartbeat, (message) => {
        if (pendingNativeUiTransport?.notify) {
          pendingNativeUiTransport.notify(message, "warning");
        } else {
          console.error(`[spark] ${message}`);
        }
      });
      pendingNativeUiTransport = undefined;
    }
    return {
      sessionId: currentSessionId,
      sessionSelectorRequested,
      ...(newSessionId ? { newSessionId } : {}),
      ...(tuiExitReason === "reload"
        ? {
            reloadHandoff: {
              sessionId: currentSessionId,
              cwd: process.cwd(),
              argv: sparkTuiReloadArgv(command.options, currentSessionId),
            },
          }
        : {}),
    };
  } finally {
    await lease.release();
  }
}

export function formatSparkCliFailure(error: unknown, argv: readonly string[]): string {
  const message =
    error instanceof Error
      ? error.message || error.name
      : typeof error === "string"
        ? error
        : String(error);
  if (!jsonFlagRequested(argv)) return message;
  return JSON.stringify(
    {
      action: "error",
      error: {
        code: "cli_error",
        message,
      },
    },
    null,
    2,
  );
}

function jsonFlagRequested(argv: readonly string[]): boolean {
  const delimiterIndex = argv.indexOf("--");
  const options = delimiterIndex < 0 ? argv : argv.slice(0, delimiterIndex);
  return options.includes("--json");
}

function isInteractiveSparkCliTerminal(options: RunSparkCliOptions): boolean {
  return Boolean(
    (options.terminal?.stdinIsTTY ?? processStdin.isTTY) &&
    (options.terminal?.stdoutIsTTY ?? processStdout.isTTY),
  );
}

const NATIVE_SLASH_COMMAND_EXCLUSIONS = [
  "help",
  "exit",
  "quit",
  "clear",
  "reload",
  "stop",
  "retry",
  "inspect",
  "hub",
  "runs",
  "run",
  "tasks",
  "task",
  "artifacts",
  "artifact",
  "evidence",
  "reviews",
  "review",
  "graft",
  "session",
] as const;

function registerSparkNativeModelCommand(
  services: SparkCliHostServices,
  modelControl?: SparkDaemonModelAuthClient,
): void {
  if (services.runtime.getCommand("model")) return;
  services.runtime.registerCommand("model", {
    description: tuiCliStrings.modelCommandDescription,
    argumentHint: tuiCliStrings.modelCommandArgumentHint,
    metadata: {
      source: "extension",
      extensionId: "spark-model",
      plane: "daemon",
      resource: "model",
      verbs: ["select", "status"],
      canonicalCliTarget: "spark daemon model set <provider/model> --session <id>",
    },
    getArgumentCompletions: (prefix) => modelArgumentCompletions(services, prefix),
    async handler(args, ctx) {
      const selection = await handleSparkNativeModelCommand(services, args, modelControl);
      ctx.ui?.notify?.(formatSparkModelSelection(selection), "info");
    },
  });
}

export async function handleSparkNativeModelCommand(
  services: SparkCliHostServices,
  args: string,
  modelControl?: SparkDaemonModelAuthClient,
): Promise<SparkActiveSelection> {
  if (modelControl) {
    const snapshot = await modelControl.snapshot();
    const query = args.trim();
    const selection = query
      ? resolveDaemonModelSelection(snapshot, query)
      : await services.modelSelector.pick(daemonSnapshotToPickerState(snapshot), { hasUI: true });
    if (!selection) {
      const active = modelRefToSelection(snapshot.session?.model ?? snapshot.defaultModel);
      if (!active) throw new Error(tuiCliStrings.noActiveModel);
      return active;
    }
    await persistDaemonModelSelection(services, modelControl, selection);
    return selection;
  }
  const query = args.trim();
  if (query) return await services.modelSelector.select(resolveSparkModelArgument(services, query));
  const picked = await services.modelSelector.openPicker({ hasUI: true });
  const active = picked ?? services.modelSelector.getActive();
  if (!active) throw new Error(tuiCliStrings.noActiveModel);
  return active;
}

function registerSparkDaemonModelKeybindings(
  services: SparkCliHostServices,
  modelControl: SparkDaemonModelAuthClient,
): void {
  const keybindings = services.keybindings as SparkCliHostServices["keybindings"] & {
    register?: SparkCliHostServices["keybindings"]["register"];
  };
  if (typeof keybindings.register !== "function") return;
  const notify = (selection: SparkActiveSelection | undefined) => {
    if (selection) {
      services.runtime.makeContext().ui?.notify?.(formatSparkModelSelection(selection), "info");
    }
  };
  keybindings.register({
    id: SPARK_MODEL_PICKER_BINDING_ID,
    defaultKey: "ctrl+l",
    description: "Open the model selector",
    handler: async (ctx) => {
      const snapshot = await modelControl.snapshot();
      const selection = await services.modelSelector.pick(
        daemonSnapshotToPickerState(snapshot),
        ctx,
      );
      if (!selection) return;
      await persistDaemonModelSelection(services, modelControl, selection);
      notify(selection);
    },
  });
  registerDaemonModelCycleKeybinding(
    services,
    modelControl,
    SPARK_MODEL_CYCLE_NEXT_BINDING_ID,
    "ctrl+p",
    "next",
    notify,
  );
  registerDaemonModelCycleKeybinding(
    services,
    modelControl,
    SPARK_MODEL_CYCLE_PREV_BINDING_ID,
    "shift+ctrl+p",
    "prev",
    notify,
  );
  services.keybindings.register({
    id: "app.thinking.cycle",
    defaultKey: "shift+tab",
    description: "Cycle the assistant thinking level (off/minimal/low/medium/high/xhigh)",
    handler: async () => {
      const snapshot = await modelControl.snapshot();
      const next = cycleThinkingLevel(
        snapshot.session?.thinkingLevel ?? services.config.activeThinkingLevel,
      );
      await modelControl.setSessionThinkingLevel(next);
      await persistThinkingLevel(services, next);
      services.runtime
        .makeContext()
        .ui?.notify?.(sparkTuiPiParityStrings().thinkingLevelSet(next), "info");
    },
  });
}

function registerDaemonModelCycleKeybinding(
  services: SparkCliHostServices,
  modelControl: SparkDaemonModelAuthClient,
  id: string,
  defaultKey: string,
  direction: "next" | "prev",
  notify: (selection: SparkActiveSelection | undefined) => void,
): void {
  services.keybindings.register({
    id,
    defaultKey,
    description: `Cycle to the ${direction} Spark model`,
    handler: async () => {
      const snapshot = await modelControl.snapshot();
      const items = daemonSnapshotToPickerState(snapshot).items.filter((item) => item.available);
      if (items.length === 0) return;
      const effectiveModel = snapshot.session?.model ?? snapshot.defaultModel;
      const activeValue = effectiveModel
        ? `${effectiveModel.providerName}/${effectiveModel.modelId}`
        : undefined;
      const activeIndex = activeValue ? items.findIndex((item) => item.value === activeValue) : -1;
      const step = direction === "next" ? 1 : -1;
      const index =
        activeIndex < 0
          ? direction === "next"
            ? 0
            : items.length - 1
          : (activeIndex + step + items.length) % items.length;
      const item = items[index]!;
      const selection = { providerName: item.providerName, modelId: item.modelId };
      await persistDaemonModelSelection(services, modelControl, selection);
      notify(selection);
    },
  });
}

async function persistDaemonModelSelection(
  services: SparkCliHostServices,
  modelControl: SparkDaemonModelAuthClient,
  selection: SparkActiveSelection,
): Promise<void> {
  await modelControl.setSessionModel(selection);
  // Session selection is intentionally scoped to the current session. The
  // daemon default is only a seed for sessions created after it changes.
  // Do not persist config.json here: in-memory enabledModels may be normalized
  // catalog defaults and must not overwrite an explicit user policy.
  services.config.activeModelId = sparkModelSelectionValue(selection);
  delete services.config.activeProvider;
  delete services.config.activeModel;
  synchronizeLocalModelSelection(services, selection);
}

async function persistThinkingLevel(
  services: SparkCliHostServices,
  thinkingLevel: SparkThinkingLevel,
): Promise<void> {
  services.config.activeThinkingLevel = thinkingLevel;
  await services.saveConfig?.(services.config);
}

function synchronizeLocalModelSelection(
  services: SparkCliHostServices,
  selection: SparkActiveSelection,
): void {
  try {
    services.providerRegistry.setActive(selection);
  } catch {
    // The daemon catalog is authoritative; a presentation adapter may have a narrower catalog.
  }
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function cycleThinkingLevel(current: SparkThinkingLevel | undefined): SparkThinkingLevel {
  const index = current ? THINKING_LEVELS.indexOf(current) : -1;
  return THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length]!;
}

function modelRefToSelection(
  model: { providerName: string; modelId: string } | undefined,
): SparkActiveSelection | undefined {
  return model ? { providerName: model.providerName, modelId: model.modelId } : undefined;
}

function createDelegatingSparkDaemonModelAuthClient(
  getCurrent: () => SparkDaemonModelAuthClient | undefined,
): SparkDaemonModelAuthClient {
  const current = (): SparkDaemonModelAuthClient => {
    const client = getCurrent();
    if (!client) throw new Error("No active Spark session is selected.");
    return client;
  };
  return {
    snapshot: () => current().snapshot(),
    setEnabledModels: (models, intent) => current().setEnabledModels(models, intent),
    setSessionModel: (model) => current().setSessionModel(model),
    setSessionThinkingLevel: (thinkingLevel) => current().setSessionThinkingLevel(thinkingLevel),
    setDefaultModel: (model) => current().setDefaultModel(model),
    setApiKey: (providerName, apiKey) => current().setApiKey(providerName, apiKey),
    logout: (providerName) => current().logout(providerName),
    startOAuth: (providerName) => current().startOAuth(providerName),
    oauthStatus: (flowId) => current().oauthStatus(flowId),
    respondOAuth: (flowId, promptId, value) => current().respondOAuth(flowId, promptId, value),
    cancelOAuth: (flowId) => current().cancelOAuth(flowId),
  };
}

function resolveSparkModelArgument(
  services: SparkCliHostServices,
  query: string,
): SparkActiveSelection {
  return resolveSparkModelSelectionById(services.providerRegistry, query);
}

function modelArgumentCompletions(
  services: SparkCliHostServices,
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  const normalized = prefix.trim().toLowerCase();
  return modelCompletionItems(services.modelSelector.getPickerState())
    .filter((item) =>
      [item.value, item.label, item.description ?? ""].some((text) =>
        text.toLowerCase().includes(normalized),
      ),
    )
    .slice(0, 25);
}

function modelCompletionItems(
  state: SparkModelPickerState,
): Array<{ value: string; label: string; description?: string }> {
  return state.items.map((item) => ({
    value: item.value,
    label: `${item.modelLabel}${item.active ? tuiCliStrings.activeModelSuffix : ""}`,
    description: item.description,
  }));
}

function createSparkNativeSlashCommands(
  services: SparkCliHostServices,
  daemonClient: SparkDaemonClientOptions,
  modelControl: SparkDaemonModelAuthClient,
  currentSessionId: string,
  workspaceId: string,
  ensureCurrentSession: () => Promise<void>,
  requestSessionSelector: () => void,
  requestNewSession: () => Promise<void>,
): SparkNativeSlashCommandMap {
  const daemonCommands = createSparkDaemonNativeCommands(daemonClient, {
    sessionId: currentSessionId,
    workspaceId,
  });
  const localControlCommands = createSparkNativeLocalControlSlashCommands();
  const piParityCommands = createSparkPiParitySlashCommands(
    services,
    modelControl,
    {
      currentSessionId,
      list: async (sessionId) => {
        await ensureCurrentSession();
        return (
          await requestSparkDaemonControl(
            "session.inbox",
            { sessionId, includeAcked: false },
            daemonClient,
          )
        ).messages;
      },
      read: async (sessionId, messageId) => {
        await ensureCurrentSession();
        return (
          await requestSparkDaemonControl(
            "session.mail.read",
            { sessionId, messageId },
            daemonClient,
          )
        ).message;
      },
      ack: async (sessionId, messageId) => {
        await ensureCurrentSession();
        return (
          await requestSparkDaemonControl(
            "session.mail.ack",
            { sessionId, messageId },
            daemonClient,
          )
        ).message;
      },
    },
    {
      currentSessionId,
      compact: async (input) => {
        await ensureCurrentSession();
        return await requestSparkDaemonControl("session.compact", input, daemonClient);
      },
      waitForTerminal: async (invocationId) =>
        await waitForInvocationTerminal(invocationId, daemonClient),
      snapshot: async (sessionId) => await clientGetManagedSessionSnapshot(sessionId, daemonClient),
    },
  );
  const sideThreadCommands = createSparkNativeSideThreadSlashCommands({
    parentSessionId: () => currentSessionId,
    client: {
      ensure: async (input) => {
        await ensureCurrentSession();
        return await requestSparkDaemonControl("side-thread.ensure", input, daemonClient);
      },
      snapshot: async (input) =>
        await requestSparkDaemonControl("side-thread.snapshot", input, daemonClient),
      submit: async (input) =>
        await requestSparkDaemonControl("side-thread.submit", input, daemonClient),
      reset: async (input) =>
        await requestSparkDaemonControl("side-thread.reset", input, daemonClient),
      configure: async (input) =>
        await requestSparkDaemonControl("side-thread.configure", input, daemonClient),
      handoff: async (input) =>
        await requestSparkDaemonControl("side-thread.handoff", input, daemonClient),
    },
  });
  const runtimeCommands = createSparkNativeRuntimeSlashCommands(services.runtime, {
    exclude: [
      ...NATIVE_SLASH_COMMAND_EXCLUSIONS,
      ...Object.keys(daemonCommands),
      ...Object.keys(localControlCommands),
      ...PI_PARITY_COMMAND_NAMES,
      ...Object.keys(sideThreadCommands),
    ],
    sendUserMessage: async (content, context) => {
      const prompt = content.trim();
      if (!prompt) return;
      await ensureCurrentSession();
      await context.session.submit(prompt);
    },
  });
  const sessionsCommand = runtimeCommands.sessions;
  if (sessionsCommand) {
    runtimeCommands.sessions = {
      ...sessionsCommand,
      description: "Open the session selector or run an explicit session subcommand",
      handler: async (args, context) => {
        if (args.trim()) {
          await sessionsCommand.handler(args, context);
          return;
        }
        requestSessionSelector();
        context.exit();
      },
    };
  }
  const statusCommand = daemonCommands.status;
  if (statusCommand) {
    daemonCommands.status = {
      ...statusCommand,
      description: "Show unified daemon, current session, work, and turn queue status",
      handler: async (_args, context) => {
        await ensureCurrentSession();
        const [daemonStatus, session] = await Promise.all([
          statusCommand.handler("", context),
          clientGetManagedSessionSnapshot(currentSessionId, daemonClient),
        ]);
        return formatNativeTuiStatus(
          typeof daemonStatus === "string" ? daemonStatus : "daemon: unknown",
          session,
          context.app.renderQueueInspection(),
        );
      },
    };
  }
  const newCommand = piParityCommands.new;
  if (newCommand) {
    piParityCommands.new = {
      ...newCommand,
      description: "Create and open a daemon-managed session in the current workspace",
      handler: async (_args, context) => {
        await requestNewSession();
        context.exit();
      },
    };
  }
  const promptTemplateCommands = createSparkPromptTemplateSlashCommands(services, {
    reservedNames: [
      ...NATIVE_SLASH_COMMAND_EXCLUSIONS,
      ...Object.keys(runtimeCommands),
      ...Object.keys(daemonCommands),
      ...Object.keys(localControlCommands),
      ...Object.keys(piParityCommands),
      ...Object.keys(sideThreadCommands),
    ],
  });
  return {
    ...runtimeCommands,
    ...daemonCommands,
    ...localControlCommands,
    ...piParityCommands,
    ...sideThreadCommands,
    ...promptTemplateCommands,
  };
}

function formatNativeTuiStatus(
  daemonStatus: string,
  session: SparkSessionView,
  queueStatus: string,
): string {
  const model = session.model
    ? `${session.model.providerName}/${session.model.modelId}`
    : "inherited";
  const pendingMailbox = (session.mailbox ?? []).filter((message) => !message.ackedAt).length;
  const lines = [
    daemonStatus,
    "",
    "session:",
    `id: ${session.sessionId}`,
    `status: ${session.status}`,
    `title: ${session.title ?? "untitled"}`,
    `cwd: ${session.cwd ?? "unknown"}`,
    `model: ${model}`,
    `thinking: ${session.thinkingLevel ?? "inherited"}`,
    `git-branch: ${session.gitBranch ?? "unknown"}`,
    `activity: messages=${session.messages.length} tools=${session.tools.length} runs=${session.runs.length} loops=${session.loops?.length ?? 0} tasks=${session.tasks.length}`,
    `records: artifacts=${session.artifacts.length} evidence=${session.evidence.length} mailbox=${pendingMailbox}/${session.mailbox?.length ?? 0}`,
    `daemon-pending-turns: ${session.pendingTurns?.length ?? 0}`,
  ];

  if (session.usage) {
    lines.push(
      `usage: input=${session.usage.inputTokens} output=${session.usage.outputTokens} cache-read=${session.usage.cacheReadTokens} cache-write=${session.usage.cacheWriteTokens} cost-usd=${session.usage.costUsd}`,
    );
  }
  if (session.work?.primary) lines.push(`primary-loop: ${session.work.primary.loopId}`);
  if (session.work?.goal) {
    lines.push(
      `goal: ${session.work.goal.status} ${session.work.goal.goalId} — ${session.work.goal.objective}`,
    );
  }
  if (session.work?.repro) {
    const repro = session.work.repro;
    lines.push(
      `repro: ${repro.status} ${repro.reproId} — ${repro.objective}`,
      `repro-stage: ${repro.stage.index + 1}/${repro.stage.total} ${repro.stage.name} phase=${repro.stage.phase}`,
      `repro-plan: ${repro.plan.completedSteps}/${repro.plan.totalSteps} stop=${repro.stopGuard.decision}`,
    );
  }
  if (session.activeLeafId) lines.push(`active-leaf: ${session.activeLeafId}`);
  if (session.createdAt) lines.push(`created-at: ${session.createdAt}`);
  if (session.updatedAt) lines.push(`updated-at: ${session.updatedAt}`);
  lines.push("", "turn-queue:", queueStatus);
  return lines.join("\n");
}

async function hostServiceOptionsFromRuntime(
  options: SparkCliRuntimeOptions | undefined,
): Promise<SparkCliHostServicesOptions> {
  if (!options) return {};
  const config = await configFromRuntimeOptions(options);
  return {
    ...(config ? { config } : {}),
    ...(options.sessionDir
      ? { sparkHome: options.sessionDir, sparkStateRoot: options.sessionDir }
      : {}),
    ...(explicitSparkSessionKey(options)
      ? { sessionManager: { getLeafId: () => explicitSparkSessionKey(options) } }
      : {}),
    ...(options.noPromptTemplates ? { noPromptTemplates: true } : {}),
  };
}

function explicitSparkSessionKey(options: SparkCliRuntimeOptions): string | undefined {
  const key = options.sparkSessionKey?.trim();
  if (key) return key;
  const sessionId = options.sessionId?.trim();
  return sessionId ? `session:${sessionId}` : undefined;
}

async function configFromRuntimeOptions(
  options: SparkCliRuntimeOptions,
): Promise<SparkConfig | undefined> {
  const needsConfig = Boolean(
    options.provider ||
    options.model ||
    options.thinking ||
    options.extensions?.length ||
    options.noExtensions ||
    options.skills?.length ||
    options.noSkills ||
    options.promptTemplates?.length ||
    options.noPromptTemplates ||
    options.themes?.length ||
    options.noThemes,
  );
  if (!needsConfig) return undefined;
  const config = await loadSparkConfig();
  if (options.provider && options.model) {
    config.activeModelId = `${options.provider}/${options.model}`;
    delete config.activeProvider;
    delete config.activeModel;
  } else if (options.model) {
    config.activeModelId = options.model;
    delete config.activeProvider;
    delete config.activeModel;
  } else if (options.provider) {
    config.activeProvider = options.provider;
  }
  if (options.thinking) config.activeThinkingLevel = options.thinking;
  if (options.noExtensions) config.extensions = [];
  if (options.extensions?.length)
    config.extensions = appendUnique(config.extensions, options.extensions);
  if (options.noSkills) config.skills = [];
  if (options.skills?.length) config.skills = appendUnique(config.skills ?? [], options.skills);
  if (options.noPromptTemplates) config.promptTemplates = [];
  if (options.promptTemplates?.length)
    config.promptTemplates = appendUnique(config.promptTemplates ?? [], options.promptTemplates);
  if (options.noThemes) config.themes = [];
  if (options.themes?.length) config.themes = appendUnique(config.themes ?? [], options.themes);
  return config;
}

function appendUnique(existing: string[], additions: readonly string[]): string[] {
  return [...new Set([...existing, ...additions])];
}

function formatSparkModelList(services: SparkCliHostServices, query: string | undefined): string {
  const normalized = query?.toLowerCase();
  const rows = services.modelSelector
    .getPickerState()
    .items.filter((item) =>
      normalized
        ? `${item.value} ${item.modelId} ${item.modelLabel} ${item.description}`
            .toLowerCase()
            .includes(normalized)
        : true,
    );
  if (rows.length === 0)
    return query ? tuiCliStrings.noModelsMatching(query) : tuiCliStrings.noModelsRegistered;
  return rows
    .map((row) => {
      const marker = row.active ? "*" : " ";
      return `${marker} ${row.value} — ${row.modelLabel} (${row.description})`;
    })
    .join("\n");
}

function printSparkJsonEventStream(
  prompt: string,
  sessionId: string,
  result: unknown,
  assistantText = tuiCliStrings.headlessAccepted,
): void {
  const timestamp = new Date().toISOString();
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: process.cwd() },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "queue_update", steering: [], followUp: [prompt] },
    {
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
      toolResults: [],
      result,
    },
    { type: "agent_end", messages: [] },
  ];
  for (const line of lines) console.log(JSON.stringify(line));
}

const WAIT_POLL_INTERVAL_MS = 500;
const WAIT_POLL_MAX_INTERVAL_MS = 5_000;
const WAIT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function waitForInvocationTerminal(
  invocationId: string,
  client: SparkDaemonClientOptions,
): Promise<SparkTurnResult> {
  const deadline = Date.now() + WAIT_DEFAULT_TIMEOUT_MS;
  let interval = WAIT_POLL_INTERVAL_MS;
  let failureCount = 0;

  while (Date.now() < deadline) {
    try {
      const status = await clientTurnStatus({ invocationId }, client, {
        ensureRunning: failureCount > 0,
      });
      failureCount = 0;
      if (
        status.status === "succeeded" ||
        status.status === "failed" ||
        status.status === "cancelled"
      ) {
        // Fetch the full result
        return await requestSparkDaemonControl("turn.result", { invocationId }, client);
      }
      // Still running/queued — poll again
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
      interval = Math.min(interval * 1.5, WAIT_POLL_MAX_INTERVAL_MS);
    } catch {
      failureCount += 1;
      if (failureCount > 10) {
        throw new Error(`Too many consecutive failures polling invocation ${invocationId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * failureCount, 5000)));
    }
  }

  // Timeout: try to get whatever status we can
  return {
    invocationId,
    status: "failed",
    error: {
      code: "timeout",
      message: "Timed out waiting for invocation to complete",
      retryable: true,
    },
  } as SparkTurnResult;
}

export interface SparkRpcState {
  lastInvocationId?: string;
}

async function runSparkRpcMode(
  daemonClient: SparkDaemonClientOptions,
  options: SparkCliRuntimeOptions | undefined,
): Promise<void> {
  writeRpc({
    type: "response",
    command: "ready",
    success: true,
    data: { protocol: "spark-rpc-jsonl", mode: "daemon" },
  });
  const state: SparkRpcState = {};
  let buffered = "";
  for await (const chunk of processStdin) {
    buffered += String(chunk);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (line.trim()) await handleSparkRpcLine(line, daemonClient, options, writeRpc, state);
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.trim())
    await handleSparkRpcLine(buffered.replace(/\r$/u, ""), daemonClient, options, writeRpc, state);
}

export async function handleSparkRpcLine(
  line: string,
  daemonClient: SparkDaemonClientOptions,
  options: SparkCliRuntimeOptions | undefined,
  writer: (value: Record<string, unknown>) => void = writeRpc,
  state: SparkRpcState = {},
): Promise<void> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    writer({ type: "response", command: "parse", success: false, error: errorMessage(error) });
    return;
  }
  const id = typeof request.id === "string" ? request.id : undefined;
  const command = typeof request.type === "string" ? request.type : "unknown";
  try {
    if (command === "prompt" || command === "steer" || command === "follow_up") {
      const message = typeof request.message === "string" ? request.message : "";
      if (!message) throw new Error(tuiCliStrings.rpcRequiresMessage(command));
      const sessionId =
        options?.sessionId ?? options?.session ?? `spark-rpc-${Date.now().toString(36)}`;
      const result = await handleSparkDaemonCliCommand(
        { action: "submit", json: true, sessionId, prompt: message },
        daemonClient,
      );
      const invocationId = invocationIdFromSubmitResult(result);
      if (invocationId) state.lastInvocationId = invocationId;
      writer({ id, type: "response", command, success: true, data: result });
      return;
    }
    if (command === "get_state") {
      const state = await handleSparkDaemonCliCommand(
        { action: "status", json: true },
        daemonClient,
      );
      writer({ id, type: "response", command, success: true, data: state });
      return;
    }
    if (command === "get_messages") {
      writer({
        id,
        type: "response",
        command,
        success: true,
        data: { messages: [] },
      });
      return;
    }
    if (command === "abort") {
      const invocationId = rpcAbortInvocationId(request) ?? state.lastInvocationId;
      if (!invocationId) {
        if (daemonClient.paths) {
          writer({
            id,
            type: "response",
            command,
            success: true,
            data: { queuedDaemonMode: true },
          });
          return;
        }
        writer({
          id,
          type: "response",
          command,
          success: false,
          error: "abort requires invocationId or a prior submitted turn",
        });
        return;
      }
      const result = await clientCancelTurn(
        {
          invocationId,
          reason: "Spark RPC abort requested by client.",
        },
        daemonClient,
      );
      if (state.lastInvocationId === invocationId) state.lastInvocationId = undefined;
      writer({
        id,
        type: "response",
        command,
        success: result.cancelRequested,
        data: result,
        ...(result.cancelRequested
          ? {}
          : { error: `Invocation ${invocationId} was not cancelled` }),
      });
      return;
    }
    if (command === "new_session") {
      writer({
        id,
        type: "response",
        command,
        success: true,
        data: { queuedDaemonMode: true },
      });
      return;
    }
    writer({
      id,
      type: "response",
      command,
      success: false,
      error: tuiCliStrings.unsupportedRpcCommand(command),
    });
  } catch (error) {
    writer({ id, type: "response", command, success: false, error: errorMessage(error) });
  }
}

function invocationIdFromSubmitResult(result: unknown): string | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const submit = record.result;
  if (!submit || typeof submit !== "object") return undefined;
  const submitRecord = submit as Record<string, unknown>;
  return typeof submitRecord.invocationId === "string" ? submitRecord.invocationId : undefined;
}

function rpcAbortInvocationId(request: Record<string, unknown>): string | undefined {
  const value = request.invocationId;
  if (typeof value === "string" && value.trim()) return value.trim();
  const nested = request.data ?? request.params;
  if (nested && typeof nested === "object") {
    return rpcAbortInvocationId(nested as Record<string, unknown>);
  }
  return undefined;
}

function writeRpc(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function stopSparkSessionHeartbeat(
  heartbeat: Awaited<ReturnType<typeof attachSparkWorkspaceSessionClient>> | undefined,
  report: (message: string) => void,
): Promise<void> {
  if (!heartbeat) return;
  try {
    await heartbeat.stop();
  } catch (error) {
    report(`Spark daemon session release failed; lease will expire by TTL: ${errorMessage(error)}`);
  }
}

async function readLeaseTransferAnswer(): Promise<"accept" | "reject" | void> {
  if (!processStdin.isTTY) return undefined;
  const rl = createInterface({ input: processStdin, output: processStdout });
  try {
    const line = (await rl.question("> ")).trim().toLowerCase();
    if (line === "y" || line === "yes" || line === "accept" || line === "transfer") return "accept";
    if (line === "n" || line === "no" || line === "reject" || line === "deny") return "reject";
    return undefined;
  } finally {
    rl.close();
  }
}

function printHelp(): void {
  console.log(tuiCliStrings.helpText);
}

async function createDefaultSparkCliHostServices(
  options?: SparkCliHostServicesOptions,
): Promise<SparkCliHostServices> {
  const { createSparkCliHostServices } = await import("./host/bootstrap.ts");
  return await createSparkCliHostServices(options);
}
