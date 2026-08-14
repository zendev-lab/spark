import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type { OAuthLoginCallbacks } from "@zendev-lab/spark-ai";
import { sparkTuiPiParityStrings } from "@zendev-lab/spark-i18n/cli";
import {
  SPARK_PROTOCOL_VERSION,
  sparkModelValue,
  type SparkAuthFlow,
  type SparkModelCatalogProvider,
  type SparkModelControlSnapshot,
  type SparkModelRef,
  type SparkSessionCompactRequest,
  type SparkSessionView,
  type SparkTurnResult,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import type { SparkSessionRecord } from "@zendev-lab/spark-host/session-store";

import type {
  SparkNativeMessage,
  SparkNativeSlashCommand,
  SparkNativeSlashCommandContext,
  SparkNativeSlashCommandMap,
} from "../native-tui.ts";
import {
  exportSparkSessionRecord,
  formatBranchRows,
  formatSessionList,
  formatSessionReplay,
  getSparkSessionLeafId,
  readSparkSessionExportFormat,
} from "../host/session-navigation.ts";
import {
  sparkSessionRecordToHtmlMessages,
  writeSparkTranscriptHtml,
  type SparkHtmlTranscriptMessage,
} from "../host/html-export.ts";
import { navigateSparkSessionBranchWithSummary } from "../host/compaction.ts";
import { listOAuthProviderSummaries } from "../host/auth.ts";
import { sessionMailStatus, type SparkSessionMailMessage } from "../host/session-mail-store.ts";
import type { SparkCliHostServices } from "../host/index.ts";
import type { SparkConfig } from "../host/config.ts";
import {
  daemonSnapshotToCatalogState,
  daemonSnapshotToPickerState,
  type SparkDaemonModelAuthClient,
} from "./model-control.ts";
import { runSparkEnabledModelsEditor } from "../tui/enabled-models-editor.ts";
import type { SparkEnabledModelCatalogState } from "../host/model-selector.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const STRINGS = sparkTuiPiParityStrings();

type SparkThinkingLevel = NonNullable<SparkConfig["activeThinkingLevel"]>;

export interface SparkSessionInboxClient {
  currentSessionId: string;
  list(sessionId: string): Promise<SparkSessionMailMessage[]>;
  read(sessionId: string, messageId: string): Promise<SparkSessionMailMessage>;
  ack(sessionId: string, messageId: string): Promise<SparkSessionMailMessage>;
}

export interface SparkSessionCompactClient {
  currentSessionId: string;
  compact(input: SparkSessionCompactRequest): Promise<SparkTurnSubmitResult>;
  waitForTerminal(invocationId: string): Promise<SparkTurnResult>;
  snapshot(sessionId: string): Promise<SparkSessionView>;
}

const PI_COMMANDS = [
  "settings",
  "enabled-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "inbox",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
] as const;

export const PI_PARITY_COMMAND_NAMES: readonly string[] = PI_COMMANDS;

export function createSparkPiParitySlashCommands(
  services: SparkCliHostServices,
  modelAuthClient?: SparkDaemonModelAuthClient,
  inboxClient?: SparkSessionInboxClient,
  compactClient?: SparkSessionCompactClient,
): SparkNativeSlashCommandMap {
  return withPiParityMetadata({
    settings: {
      description: STRINGS.descriptions.settings,
      argumentHint: "[set thinking <off|minimal|low|medium|high|xhigh>|set theme <id>]",
      getArgumentCompletions: (prefix) => settingsCompletions(prefix),
      handler: async (args) => handleSettingsCommand(services, args, modelAuthClient),
    },
    "enabled-models": {
      description: STRINGS.descriptions.enabledModels,
      argumentHint: "[inspect|add|remove|set]",
      handler: async (args, ctx) =>
        handleEnabledModelsCommand(services, args, ctx, modelAuthClient),
    },
    enabled: {
      description: STRINGS.descriptions.enabledModels,
      argumentHint: "[inspect|add|remove|set]",
      metadata: { deprecatedAliasFor: "/enabled-models" },
      handler: async (args, ctx) =>
        handleEnabledModelsCommand(services, args, ctx, modelAuthClient),
    },
    export: {
      description: STRINGS.descriptions.export,
      argumentHint: "[json|jsonl|text|html] [session-id|path] [output.html]",
      getArgumentCompletions: (prefix) => exportCompletions(prefix),
      handler: async (args, ctx) => handleExportCommand(services, args, ctx.session.messages),
    },
    import: {
      description: STRINGS.descriptions.import,
      argumentHint: "<jsonl-path>",
      handler: async (args) => handleImportCommand(services, args),
    },
    share: {
      description: STRINGS.descriptions.share,
      argumentHint: "[session-id|path] [output.html]",
      handler: async (args, ctx) => handleShareCommand(services, args, ctx.session.messages),
    },
    copy: {
      description: STRINGS.descriptions.copy,
      handler: (_args, ctx) =>
        lastAssistantMessage(ctx.session.messages) ?? STRINGS.noAssistantMessage,
    },
    name: {
      description: STRINGS.descriptions.name,
      argumentHint: "[name]",
      handler: (args, ctx) => handleNameCommand(ctx.session.messages, args),
    },
    inbox: {
      description: "List, read, or acknowledge durable Spark session mail",
      argumentHint: "[session-id] | read <message-id> [session-id] | ack <message-id> [session-id]",
      handler: async (args) => handleInboxCommand(args, inboxClient),
    },
    changelog: {
      description: STRINGS.descriptions.changelog,
      handler: () => STRINGS.changelog,
    },
    hotkeys: {
      description: STRINGS.descriptions.hotkeys,
      handler: () => renderHotkeys(services),
    },
    fork: {
      description: STRINGS.descriptions.fork,
      handler: async (_args, ctx) => forkVisibleTranscript(services, ctx.session.messages),
    },
    clone: {
      description: STRINGS.descriptions.clone,
      handler: async (_args, ctx) => cloneVisibleTranscript(services, ctx.session.messages),
    },
    tree: {
      description: STRINGS.descriptions.tree,
      argumentHint: "[session-id|path] [summarize <entry-id> [instructions]]",
      handler: async (args) => handleTreeCommand(services, args),
    },
    trust: {
      description: STRINGS.descriptions.trust,
      handler: () => STRINGS.trust(services.cwd),
    },
    login: {
      description: STRINGS.descriptions.login,
      argumentHint: "[provider] (API keys are prompted securely)",
      getArgumentCompletions: (prefix) => authProviderCompletions(services, prefix),
      handler: async (args, ctx) =>
        modelAuthClient
          ? handleDaemonLoginCommand(services, modelAuthClient, args, ctx)
          : handleLoginCommand(services, args, ctx),
    },
    logout: {
      description: STRINGS.descriptions.logout,
      argumentHint: "[provider]",
      getArgumentCompletions: (prefix) => storedCredentialCompletions(services, prefix),
      handler: async (args, ctx) =>
        modelAuthClient
          ? handleDaemonLogoutCommand(modelAuthClient, args, ctx)
          : handleLogoutCommand(services, args, ctx),
    },
    new: {
      description: STRINGS.descriptions.new,
      handler: (_args, ctx) => {
        ctx.session.clearTranscript(STRINGS.newTranscript);
      },
    },
    compact: {
      description: STRINGS.descriptions.compact,
      argumentHint: "[custom instructions]",
      handler: async (args, ctx) => handleCompactCommand(args, ctx, compactClient),
    },
    resume: {
      description: STRINGS.descriptions.resume,
      argumentHint: "[session-id|path]",
      handler: async (args) => handleResumeCommand(services, args),
    },
  });
}

function withPiParityMetadata(commands: SparkNativeSlashCommandMap): SparkNativeSlashCommandMap {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      {
        ...command,
        metadata: command.metadata ?? piParityCommandMetadata(name, command),
      } satisfies SparkNativeSlashCommand,
    ]),
  );
}

function piParityCommandMetadata(
  name: string,
  _command: SparkNativeSlashCommand,
): SparkNativeSlashCommand["metadata"] {
  const canonical = piParityCanonicalCliTarget(name);
  const providerAuthCommand = name === "login" || name === "logout";
  return {
    source: "extension",
    extensionId: "spark-pi-parity",
    plane: canonical.startsWith("spark daemon") ? "daemon" : "tui",
    resource:
      name === "fork" || name === "clone" || name === "tree"
        ? "session"
        : providerAuthCommand
          ? "auth"
          : name,
    verbs: [name],
    canonicalCliTarget: canonical,
  };
}

function piParityCanonicalCliTarget(name: string): string {
  switch (name) {
    case "inbox":
      return "spark daemon session inbox --session <session>";
    case "fork":
      return "spark daemon session fork --current";
    case "clone":
      return "spark daemon session clone --current";
    case "tree":
      return "spark daemon session tree <session>";
    case "resume":
      return "spark tui attach <session>";
    case "login":
      return "spark daemon auth login [provider]";
    case "logout":
      return "spark daemon auth logout <provider>";
    default:
      return `spark tui ${name}`;
  }
}

function settingsCompletions(prefix: string): Array<{ value: string; label: string }> {
  const options = [
    "set thinking off",
    "set thinking minimal",
    "set thinking low",
    "set thinking medium",
    "set thinking high",
    "set thinking xhigh",
    "set theme dark",
    "set theme light",
  ];
  return filterValues(options, prefix).map((value) => ({ value, label: value }));
}

function exportCompletions(prefix: string): Array<{ value: string; label: string }> {
  return filterValues(["json", "jsonl", "text", "html"], prefix).map((value) => ({
    value,
    label: value,
  }));
}

function authProviderCompletions(
  services: SparkCliHostServices,
  prefix: string,
): Array<{ value: string; label: string }> {
  return filterValues(
    [
      ...new Set([
        ...services.providerRegistry.listProviders().map((provider) => provider.name),
        ...listOAuthProviderSummaries().map((provider) => provider.id),
      ]),
    ],
    prefix,
  ).map((value) => ({ value, label: value }));
}

function storedCredentialCompletions(
  services: SparkCliHostServices,
  prefix: string,
): Array<{ value: string; label: string }> {
  return filterValues(services.authStore?.listProviders() ?? [], prefix).map((value) => ({
    value,
    label: value,
  }));
}

function filterValues(values: readonly string[], prefix: string): string[] {
  const normalized = prefix.trim().toLowerCase();
  return values.filter((value) => value.toLowerCase().startsWith(normalized));
}

async function handleSettingsCommand(
  services: SparkCliHostServices,
  args: string,
  modelAuthClient?: SparkDaemonModelAuthClient,
): Promise<string> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  if (tokens[0] === "set" && tokens[1] === "thinking") {
    const level = tokens[2];
    if (!isThinkingLevel(level)) {
      return STRINGS.settingsUsageThinking(THINKING_LEVELS);
    }
    if (modelAuthClient?.sessionId) {
      await modelAuthClient.setSessionThinkingLevel(level);
    } else {
      services.config.activeThinkingLevel = level;
      await services.saveConfig?.(services.config);
    }
    return STRINGS.thinkingLevelSet(level);
  }
  if (tokens[0] === "set" && tokens[1] === "theme") {
    const themeId = tokens[2];
    const themes = services.themeCatalog?.themes ?? [];
    if (!themeId || !themes.some((theme) => theme.id === themeId)) {
      return STRINGS.settingsUsageTheme(themes.map((theme) => theme.id));
    }
    services.config.activeTheme = themeId;
    await services.saveConfig?.(services.config);
    return STRINGS.themeSet(themeId);
  }

  const active = services.modelSelector.getActive();
  const lines = [
    `${STRINGS.settingsHeader}:`,
    `cwd: ${services.cwd}`,
    `active model: ${active ? `${active.providerName}/${active.modelId}` : "none"}`,
    `thinking level: ${services.config.activeThinkingLevel ?? "default"}`,
    `theme: ${services.theme?.id ?? services.config.activeTheme ?? "dark"}`,
    `extensions: ${services.config.extensions.length}`,
    `providers: ${services.providerRegistry.listProviders().length}`,
    `prompt templates: ${services.promptTemplates?.templates.length ?? 0}`,
  ];
  if (services.diagnostics.length) {
    lines.push("diagnostics:");
    for (const diagnostic of services.diagnostics)
      lines.push(`- ${diagnostic.type}: ${diagnostic.message}`);
  }
  return lines.join("\n");
}

function isThinkingLevel(value: string | undefined): value is SparkThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value ?? "");
}

async function handleEnabledModelsCommand(
  services: SparkCliHostServices,
  args: string,
  ctx: SparkNativeSlashCommandContext,
  modelAuthClient?: SparkDaemonModelAuthClient,
): Promise<string> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const action = tokens[0];
  if (action === "inspect" || action === "list") {
    return renderEnabledModels(services, modelAuthClient);
  }
  if (action === "add" || action === "remove" || action === "set") {
    const refs = tokens.slice(1);
    if (action !== "set" && refs.length === 0) {
      return STRINGS.enabledModelsMutationUsage;
    }
    return persistEnabledModels(
      services,
      modelAuthClient,
      mutateEnabledModelValues(
        await currentEnabledModelValues(services, modelAuthClient),
        action,
        refs,
      ),
    );
  }
  if (tokens.length > 0) return STRINGS.enabledModelsMutationUsage;

  const catalog = await loadEnabledModelCatalog(services, modelAuthClient);
  if (catalog.items.length === 0) return STRINGS.noModelsRegistered;
  const custom = ctx.app.custom;
  if (typeof custom !== "function") return renderEnabledModels(services, modelAuthClient);
  const selected = await runSparkEnabledModelsEditor({ custom }, catalog);
  if (!selected) return "";
  return persistEnabledModels(services, modelAuthClient, selected);
}

async function renderEnabledModels(
  services: SparkCliHostServices,
  modelAuthClient?: SparkDaemonModelAuthClient,
): Promise<string> {
  const items = (await loadEnabledModelCatalog(services, modelAuthClient)).items.filter(
    (item) => item.enabled,
  );
  if (items.length === 0) return STRINGS.noModelsRegistered;
  return items
    .map((model) => `${model.active ? "*" : " "} ${model.value} — ${model.description}`)
    .join("\n");
}

async function loadEnabledModelCatalog(
  services: SparkCliHostServices,
  modelAuthClient?: SparkDaemonModelAuthClient,
): Promise<SparkEnabledModelCatalogState> {
  if (modelAuthClient) return daemonSnapshotToCatalogState(await modelAuthClient.snapshot());
  const enabled = new Set(await currentEnabledModelValues(services));
  return {
    items: services.modelSelector.listCatalogItems().map((item) => ({
      ...item,
      enabled: enabled.has(item.value),
    })),
  };
}

async function currentEnabledModelValues(
  services: SparkCliHostServices,
  modelAuthClient?: SparkDaemonModelAuthClient,
): Promise<string[]> {
  if (modelAuthClient) {
    const snapshot = await modelAuthClient.snapshot();
    if (snapshot.enabledModels !== undefined) {
      return snapshot.enabledModels.map(sparkModelValue);
    }
    return snapshot.providers.flatMap((provider) =>
      provider.models.map((entry) => sparkModelValue(entry.model)),
    );
  }
  if (services.config.enabledModels !== undefined) return [...services.config.enabledModels];
  return services.modelSelector.listCatalogItems().map((item) => item.value);
}

function mutateEnabledModelValues(
  current: readonly string[],
  action: "add" | "remove" | "set",
  refs: readonly string[],
): string[] {
  if (action === "set") return uniqueModelValues(refs);
  const next = new Set(current);
  for (const ref of refs) {
    if (action === "add") next.add(ref);
    else next.delete(ref);
  }
  return [...next];
}

function uniqueModelValues(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

async function persistEnabledModels(
  services: SparkCliHostServices,
  modelAuthClient: SparkDaemonModelAuthClient | undefined,
  modelValues: readonly string[],
): Promise<string> {
  if (modelAuthClient) {
    const snapshot = await modelAuthClient.setEnabledModels(
      modelValues.map(parseEnabledModelValue),
    );
    if (services.config) services.config.enabledModels = [...modelValues];
    return formatEnabledModelsSaved((snapshot.enabledModels ?? []).map(sparkModelValue));
  }
  services.config.enabledModels = [...modelValues];
  if (services.saveConfig) await services.saveConfig(services.config);
  return formatEnabledModelsSaved(modelValues);
}

function parseEnabledModelValue(value: string): SparkModelRef {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`Select a valid provider/model: ${value}`);
  }
  return { providerName: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function formatEnabledModelsSaved(modelValues: readonly string[]): string {
  if (modelValues.length === 0) return STRINGS.enabledModelsSavedEmpty;
  return `${STRINGS.enabledModelsSaved}\n${modelValues.map((value) => `  ${value}`).join("\n")}`;
}

async function handleInboxCommand(
  args: string,
  client: SparkSessionInboxClient | undefined,
): Promise<string> {
  if (!client) return "Inbox requires a connected Spark daemon.";
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const action = tokens[0] === "read" || tokens[0] === "ack" ? tokens[0] : "list";
  if (action === "read" || action === "ack") {
    const messageId = tokens[1];
    const sessionId = tokens[2] ?? client.currentSessionId;
    if (!messageId || !sessionId) return `Usage: /inbox ${action} <message-id> [session-id]`;
    const message = await client[action](sessionId, messageId);
    return renderTuiInboxMessage(action, message);
  }
  const sessionId = tokens[0] ?? client.currentSessionId;
  if (!sessionId) return "Usage: /inbox [session-id]";
  const messages = await client.list(sessionId);
  return renderTuiInboxList(sessionId, messages);
}

function renderTuiInboxList(sessionId: string, messages: SparkSessionMailMessage[]): string {
  if (messages.length === 0) return `No pending Spark session mail for ${sessionId}.`;
  return messages
    .map(
      (message) =>
        `${message.id} ${sessionMailStatus(message)} from=${message.fromSessionId} ${previewMailBody(message.body)}`,
    )
    .join("\n");
}

function renderTuiInboxMessage(action: "read" | "ack", message: SparkSessionMailMessage): string {
  return [
    `${action === "ack" ? "Acknowledged" : "Read"} ${message.id}`,
    `to=${message.toSessionId}`,
    `from=${message.fromSessionId}`,
    `status=${sessionMailStatus(message)}`,
    "",
    message.body,
  ].join("\n");
}

function previewMailBody(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

async function handleExportCommand(
  services: SparkCliHostServices,
  args: string,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const first = tokens[0];
  const format =
    first === "json" || first === "jsonl" || first === "text" || first === "html"
      ? first
      : undefined;
  if (format === "html") {
    return await handleHtmlExportCommand(services, tokens.slice(1), messages, "export");
  }

  const sessionRef = format ? tokens[1] : first;
  if (sessionRef) {
    const record = await services.sessionStore.loadByRef(sessionRef);
    return exportSparkSessionRecord(record, {
      format: format ? readSparkSessionExportFormat(format) : "jsonl",
    });
  }
  if (format === "jsonl") return visibleTranscriptJsonl(services, messages);
  if (format === "text" || !format) return visibleTranscriptText(messages);
  return JSON.stringify(
    { version: 1, cwd: services.cwd, messages: exportableMessages(messages) },
    null,
    2,
  );
}

async function handleShareCommand(
  services: SparkCliHostServices,
  args: string,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const result = await handleHtmlExportCommand(
    services,
    args.trim().split(/\s+/u).filter(Boolean),
    messages,
    "share",
  );
  return [
    result.replace(/^Exported HTML:/u, "Share-safe HTML export:"),
    STRINGS.noExternalUpload,
  ].join("\n");
}

async function handleHtmlExportCommand(
  services: SparkCliHostServices,
  tokens: readonly string[],
  messages: readonly SparkNativeMessage[],
  kind: "export" | "share",
): Promise<string> {
  const target = parseHtmlExportTarget(tokens);
  if (target.sessionRef) {
    const record = await services.sessionStore.loadByRef(target.sessionRef);
    const result = await writeSparkTranscriptHtml(
      {
        title: `Spark session ${record.header.id}`,
        cwd: record.header.cwd,
        sessionId: record.header.id,
        messages: sparkSessionRecordToHtmlMessages(record),
        theme: services.theme,
      },
      {
        cwd: services.cwd,
        sparkHome: sparkHomeForExports(services),
        kind,
        outputPath: target.outputPath,
        filenameStem: `spark-${kind}-${record.header.id}`,
      },
    );
    return `Exported HTML: ${result.path}`;
  }

  const result = await writeSparkTranscriptHtml(
    {
      title: "Spark visible transcript",
      cwd: services.cwd,
      sessionId: `visible-${Date.now().toString(36)}`,
      messages: visibleTranscriptHtmlMessages(messages),
      theme: services.theme,
    },
    {
      cwd: services.cwd,
      sparkHome: sparkHomeForExports(services),
      kind,
      outputPath: target.outputPath,
      filenameStem: `spark-${kind}-visible-${Date.now().toString(36)}`,
    },
  );
  return `Exported HTML: ${result.path}`;
}

async function handleImportCommand(services: SparkCliHostServices, args: string): Promise<string> {
  const filePath = args.trim();
  if (!filePath) return STRINGS.importUsage;
  const record = await services.sessionStore.load(filePath);
  return `Imported Spark/Pi session ${record.header.id} from ${basename(filePath)}. Resume with /resume ${record.header.id} or inspect with /tree ${record.header.id}.`;
}

function handleNameCommand(messages: SparkNativeMessage[], args: string): string {
  const name = args.trim();
  const existing = [...messages].reverse().find((message) => message.customType === "session_name");
  if (!name) return existing ? `Session name: ${existing.text}` : "No Spark session name set.";
  messages.push({ role: "custom", customType: "session_name", text: name, display: false });
  return `Session name set: ${name}`;
}

function renderHotkeys(services: SparkCliHostServices): string {
  return services.keybindings
    .snapshot()
    .bindings.map((binding) => `${binding.key} — ${binding.id}: ${binding.description}`)
    .join("\n");
}

async function forkVisibleTranscript(
  services: SparkCliHostServices,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const record = services.sessionStore.createSession({ id: `fork-${randomUUID()}` });
  for (const message of exportableMessages(messages)) {
    services.sessionStore.appendMessage(record, {
      role: message.role,
      content: message.text,
      timestamp: Date.now(),
    });
  }
  await services.sessionStore.save(record);
  return `Forked visible transcript into Spark session ${record.header.id}`;
}

async function cloneVisibleTranscript(
  services: SparkCliHostServices,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const record = services.sessionStore.createSession({ id: `clone-${randomUUID()}` });
  for (const message of exportableMessages(messages)) {
    services.sessionStore.appendMessage(record, {
      role: message.role,
      content: message.text,
      timestamp: Date.now(),
    });
  }
  await services.sessionStore.save(record);
  return `Cloned visible transcript into Spark session ${record.header.id}`;
}

async function handleTreeCommand(services: SparkCliHostServices, args: string): Promise<string> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const sessionRef = tokens[0];
  if (!sessionRef) return formatSessionList(await services.sessionStore.list());
  const record = await services.sessionStore.loadByRef(sessionRef);
  if (tokens[1] === "summarize" || tokens[1] === "summary") {
    const targetId = tokens[2];
    if (!targetId)
      return "Usage: /tree <session-id|path> summarize <entry-id> [custom instructions]";
    const result = navigateSparkSessionBranchWithSummary(record, targetId, {
      summarize: true,
      customInstructions: tokens.slice(3).join(" ") || undefined,
    });
    await services.sessionStore.save(record);
    return [
      `Branch summary appended: ${result.summaryEntry?.id ?? "none"}`,
      `Active branch: ${result.activeLeafId ?? "root"}`,
      formatBranchRows(branchRowsForRecord(record)),
    ].join("\n");
  }
  return formatBranchRows(branchRowsForRecord(record));
}

async function handleCompactCommand(
  args: string,
  ctx: SparkNativeSlashCommandContext,
  client?: SparkSessionCompactClient,
): Promise<string> {
  if (!client) {
    throw new Error("Spark TUI compact command requires its same-version daemon client");
  }

  const customInstructions = args.trim() || undefined;
  const submitted = await client.compact({
    sessionId: client.currentSessionId,
    idempotencyKey: `tui:session.compact:${client.currentSessionId}:${randomUUID()}`,
    ...(customInstructions ? { customInstructions } : {}),
  });
  const terminal = await client.waitForTerminal(submitted.invocationId);
  if (terminal.status !== "succeeded") {
    const detail = terminal.error?.message ?? terminal.status;
    return `Session compaction failed for ${client.currentSessionId} (invocation ${submitted.invocationId}): ${detail}`;
  }
  const snapshot = await client.snapshot(client.currentSessionId);
  ctx.app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: snapshot,
  });
  return (
    terminal.assistantText ??
    `Compacted daemon-owned Spark session ${client.currentSessionId} (invocation ${submitted.invocationId}).`
  );
}

function branchRowsForRecord(record: SparkSessionRecord) {
  return record.entries.length === 0
    ? []
    : record.entries.map((entry, index) => ({
        id: entry.id,
        depth: entry.parentId ? 1 : 0,
        active: entry.id === getSparkSessionLeafId(record),
        label: `${index + 1}. ${entry.type}${entry.type === "branch_summary" ? ` — ${entry.summary.slice(0, 80)}` : ""}`,
        description: entry.timestamp,
        entry,
      }));
}

async function handleResumeCommand(services: SparkCliHostServices, args: string): Promise<string> {
  const sessionRef = args.trim();
  if (!sessionRef) return formatSessionList(await services.sessionStore.list());
  const record = await services.sessionStore.loadByRef(sessionRef);
  return [
    `Resume target: ${record.header.id}`,
    formatSessionReplay(record),
    "Submit a new prompt to continue this Spark daemon session, or use /tree to inspect branches.",
  ].join("\n");
}

function visibleTranscriptText(messages: readonly SparkNativeMessage[]): string {
  const exportable = exportableMessages(messages);
  if (exportable.length === 0) return "No visible transcript messages yet.";
  return exportable.map((message) => `${message.role}> ${message.text}`).join("\n");
}

function visibleTranscriptJsonl(
  services: SparkCliHostServices,
  messages: readonly SparkNativeMessage[],
): string {
  const now = new Date().toISOString();
  const header = {
    type: "session",
    version: 3,
    id: `visible-${Date.now().toString(36)}`,
    timestamp: now,
    cwd: services.cwd,
  };
  const entries = exportableMessages(messages).map((message, index) => ({
    type: "message",
    id: `m${index + 1}`,
    parentId: index === 0 ? null : `m${index}`,
    timestamp: now,
    message: { role: message.role, content: message.text, timestamp: Date.now() },
  }));
  return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function exportableMessages(messages: readonly SparkNativeMessage[]): SparkNativeMessage[] {
  return messages.filter((message) => message.display !== false && message.text.trim().length > 0);
}

function visibleTranscriptHtmlMessages(
  messages: readonly SparkNativeMessage[],
): SparkHtmlTranscriptMessage[] {
  return exportableMessages(messages).map((message) => ({
    role: message.role,
    label: htmlMessageLabel(message),
    text: message.text,
    details: htmlMessageDetails(message),
  }));
}

function htmlMessageLabel(message: SparkNativeMessage): string {
  if (message.role === "tool") return `tool:${message.toolName ?? "tool"}`;
  if (message.role === "custom") return message.customType ?? "custom";
  return message.role;
}

function htmlMessageDetails(message: SparkNativeMessage): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {};
  if (message.toolCallId) details.toolCallId = message.toolCallId;
  if (message.toolStatus) details.status = message.toolStatus;
  if (message.details && typeof message.details === "object") details.details = message.details;
  return Object.keys(details).length ? details : undefined;
}

function parseHtmlExportTarget(tokens: readonly string[]): {
  sessionRef?: string;
  outputPath?: string;
} {
  const [first, second] = tokens;
  if (!first) return {};
  if (isHtmlPath(first)) return { outputPath: first };
  return { sessionRef: first, ...(second ? { outputPath: second } : {}) };
}

function isHtmlPath(value: string): boolean {
  return value.toLowerCase().endsWith(".html") || value.toLowerCase().endsWith(".htm");
}

function sparkHomeForExports(services: SparkCliHostServices): string | undefined {
  const root = services.sessionStore.sessionsRoot;
  return basename(root) === "sessions" ? dirname(root) : undefined;
}

function lastAssistantMessage(messages: readonly SparkNativeMessage[]): string | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant")?.text;
}

async function handleDaemonLoginCommand(
  services: SparkCliHostServices,
  client: SparkDaemonModelAuthClient,
  args: string,
  ctx: SparkNativeSlashCommandContext,
): Promise<string> {
  const snapshot = await client.snapshot();
  const explicitProviderId = args.trim();
  const loginProviders = daemonLoginProviders(snapshot);
  const providerId = explicitProviderId || (await selectDaemonAuthProvider(snapshot, ctx, "login"));
  if (!providerId) {
    if (snapshot.providers.length === 0)
      return "No Spark providers are registered with the daemon.";
    if (loginProviders.length === 0) return "No Spark providers require login.";
    return "Login cancelled; no credential was stored.";
  }

  const provider = findDaemonAuthProvider(snapshot, providerId);
  if (!provider) {
    return [
      `Unknown Spark provider: ${providerId}`,
      `Known providers: ${snapshot.providers.map((entry) => entry.providerName).join(", ") || "none"}`,
    ].join("\n");
  }

  if (provider.auth.kind === "none") {
    return `Provider ${provider.label} does not require login.`;
  }
  if (provider.auth.source === "environment" || provider.auth.source === "literal") {
    return `Provider ${provider.label} already uses ${provider.auth.source} authentication; update that source instead of the Spark daemon credential store.`;
  }
  if (provider.auth.kind === "api_key") {
    const apiKey = await services.runtime
      .makeContext()
      .ui?.secret?.(`Enter API key for ${provider.label}`);
    if (apiKey === undefined)
      return `Login cancelled for ${provider.label}; no credential was stored.`;
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) return `API key for ${provider.label} must be non-empty.`;
    await client.setApiKey(provider.providerName, normalizedApiKey);
    return `Stored API key for ${provider.label} in the Spark daemon credential store.`;
  }

  const oauthProviderId = provider.auth.reference ?? provider.providerName;
  let flow: SparkAuthFlow | undefined;
  try {
    flow = await client.startOAuth(oauthProviderId);
    return await driveDaemonOAuthFlow(services, client, provider, flow, ctx);
  } catch (error) {
    if (flow && !isTerminalOAuthFlow(flow)) {
      try {
        await client.cancelOAuth(flow.id);
      } catch {
        // The daemon may already have completed or expired the flow.
      }
    }
    return `OAuth login failed for ${provider.label}: ${safeAuthError(error)}`;
  }
}

async function handleDaemonLogoutCommand(
  client: SparkDaemonModelAuthClient,
  args: string,
  ctx: SparkNativeSlashCommandContext,
): Promise<string> {
  const snapshot = await client.snapshot();
  const configured = daemonManagedCredentialProviders(snapshot);
  const providerId = args.trim() || (await selectDaemonAuthProvider(snapshot, ctx, "logout"));
  if (!providerId) {
    return configured.length === 0
      ? "No daemon-managed credentials are configured."
      : "Logout cancelled; no credential was removed.";
  }

  const provider = findDaemonAuthProvider(snapshot, providerId);
  if (!provider) {
    return `Unknown Spark provider: ${providerId}`;
  }
  if (provider.auth.kind === "none") {
    return `Provider ${provider.label} does not use a daemon-managed credential.`;
  }
  if (provider.auth.source === "environment" || provider.auth.source === "literal") {
    return `Provider ${provider.label} uses ${provider.auth.source} authentication; remove it from that source instead of the Spark daemon credential store.`;
  }

  const credentialId = daemonCredentialId(provider);
  const removed = await client.logout(credentialId);
  return removed
    ? `Removed stored Spark credential: ${credentialId}`
    : `No stored Spark credential found for: ${credentialId}`;
}

interface DaemonOAuthProgressState {
  authorizationUrl?: string;
  deviceCode?: string;
  progressCount: number;
}

async function driveDaemonOAuthFlow(
  services: SparkCliHostServices,
  client: SparkDaemonModelAuthClient,
  provider: SparkModelCatalogProvider,
  initialFlow: SparkAuthFlow,
  ctx: SparkNativeSlashCommandContext,
): Promise<string> {
  const seen: DaemonOAuthProgressState = { progressCount: 0 };
  let flow = initialFlow;
  while (true) {
    publishDaemonOAuthProgress(flow, seen, ctx);
    if (flow.status === "succeeded") return `Logged in OAuth provider: ${provider.label}`;
    if (flow.status === "failed") {
      return `OAuth login failed for ${provider.label}: ${safeAuthError(flow.error ?? "unknown error")}`;
    }
    if (flow.status === "cancelled") return `OAuth login cancelled for ${provider.label}.`;

    if (flow.prompt) {
      const value = await collectDaemonOAuthPrompt(services, flow.prompt);
      if (value === undefined) {
        flow = await client.cancelOAuth(flow.id);
        publishDaemonOAuthProgress(flow, seen, ctx);
        return `OAuth login cancelled for ${provider.label}.`;
      }
      flow = await client.respondOAuth(flow.id, flow.prompt.id, value);
      continue;
    }

    await waitForDaemonOAuthPoll(flow);
    flow = await client.oauthStatus(flow.id);
  }
}

function publishDaemonOAuthProgress(
  flow: SparkAuthFlow,
  seen: DaemonOAuthProgressState,
  ctx: SparkNativeSlashCommandContext,
): void {
  if (flow.authorization && flow.authorization.url !== seen.authorizationUrl) {
    seen.authorizationUrl = flow.authorization.url;
    ctx.session.addSystemMessage(
      [
        `Open OAuth authorization URL: ${flow.authorization.url}`,
        flow.authorization.instructions
          ? `Instructions: ${flow.authorization.instructions}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (flow.deviceCode && flow.deviceCode.userCode !== seen.deviceCode) {
    seen.deviceCode = flow.deviceCode.userCode;
    ctx.session.addSystemMessage(
      [
        `OAuth device code: ${flow.deviceCode.userCode}`,
        `Verification URL: ${flow.deviceCode.verificationUri}`,
        flow.deviceCode.expiresInSeconds
          ? `Expires in: ${flow.deviceCode.expiresInSeconds}s`
          : undefined,
        flow.deviceCode.intervalSeconds
          ? `Polling interval: ${flow.deviceCode.intervalSeconds}s`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  for (const message of flow.progress.slice(seen.progressCount)) {
    ctx.session.addSystemMessage(`OAuth: ${message}`);
  }
  seen.progressCount = flow.progress.length;
}

async function collectDaemonOAuthPrompt(
  services: SparkCliHostServices,
  prompt: NonNullable<SparkAuthFlow["prompt"]>,
): Promise<string | undefined> {
  const ui = services.runtime.makeContext().ui;
  if (prompt.kind === "select") {
    const choices = prompt.options.map((option) =>
      option.label === option.id ? option.label : `${option.label} (${option.id})`,
    );
    const selected = await ui?.select?.(prompt.message, choices);
    const selectedIndex = selected === undefined ? -1 : choices.indexOf(selected);
    return selectedIndex < 0 ? undefined : prompt.options[selectedIndex]?.id;
  }
  const value = await ui?.input?.(prompt.message, prompt.placeholder);
  if (value !== undefined) return value;
  return prompt.allowEmpty ? "" : undefined;
}

async function waitForDaemonOAuthPoll(flow: SparkAuthFlow): Promise<void> {
  const requestedMs = (flow.deviceCode?.intervalSeconds ?? 0.5) * 1_000;
  const delayMs = Math.max(250, Math.min(2_000, requestedMs));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function selectDaemonAuthProvider(
  snapshot: SparkModelControlSnapshot,
  ctx: SparkNativeSlashCommandContext,
  mode: "login" | "logout",
): Promise<string | undefined> {
  const providers =
    mode === "logout" ? daemonManagedCredentialProviders(snapshot) : daemonLoginProviders(snapshot);
  if (providers.length === 0) return undefined;
  const labels = providers.map(formatDaemonAuthProviderOption);
  const selected = await ctx.app.select(
    mode === "login" ? "Select provider to log in" : "Select credential to remove",
    labels,
  );
  const index = selected === undefined ? -1 : labels.indexOf(selected);
  return index < 0 ? undefined : providers[index]?.providerName;
}

function formatDaemonAuthProviderOption(provider: SparkModelCatalogProvider): string {
  const details = [
    provider.auth.kind.replace("_", " "),
    provider.auth.configured ? "configured" : "missing",
    provider.auth.source ? `source=${provider.auth.source}` : undefined,
  ].filter(Boolean);
  return `${provider.label} (${provider.providerName}) — ${details.join(" · ")}`;
}

function findDaemonAuthProvider(
  snapshot: SparkModelControlSnapshot,
  providerId: string,
): SparkModelCatalogProvider | undefined {
  const normalized = providerId.toLocaleLowerCase();
  return snapshot.providers.find(
    (provider) =>
      provider.providerName.toLocaleLowerCase() === normalized ||
      provider.auth.reference?.toLocaleLowerCase() === normalized,
  );
}

function daemonCredentialId(provider: SparkModelCatalogProvider): string {
  return provider.auth.kind === "oauth"
    ? (provider.auth.reference ?? provider.providerName)
    : provider.providerName;
}

function daemonLoginProviders(snapshot: SparkModelControlSnapshot): SparkModelCatalogProvider[] {
  return snapshot.providers.filter((provider) => provider.auth.kind !== "none");
}

function daemonManagedCredentialProviders(
  snapshot: SparkModelControlSnapshot,
): SparkModelCatalogProvider[] {
  return snapshot.providers.filter(
    (provider) =>
      provider.auth.configured &&
      provider.auth.kind !== "none" &&
      provider.auth.source !== "environment" &&
      provider.auth.source !== "literal",
  );
}

function isTerminalOAuthFlow(flow: SparkAuthFlow): boolean {
  return ["succeeded", "failed", "cancelled"].includes(flow.status);
}

function safeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(token|secret|api[_ -]?key)(\s*[:=]\s*)\S+/giu, "$1$2[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

async function handleLoginCommand(
  services: SparkCliHostServices,
  args: string,
  ctx: SparkNativeSlashCommandContext,
): Promise<string> {
  if (!services.authStore) return STRINGS.authStoreUnavailable;
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  if (tokens[0] === "api-key" || tokens[0] === "key") {
    return await handleApiKeyLoginCommand(services, tokens.slice(1));
  }
  const explicitProviderRef = tokens.length > 0 ? tokens.join(" ") : undefined;
  const selected = explicitProviderRef
    ? resolveExplicitLocalAuthProvider(services, explicitProviderRef)
    : await selectLocalAuthProvider(services, ctx);
  if (!selected) {
    if (explicitProviderRef) {
      const supported = listOAuthProviderSummaries();
      return [
        `Unknown provider: ${explicitProviderRef}`,
        `Supported OAuth providers: ${supported.map((provider) => provider.id).join(", ") || "none"}`,
        renderProviderSummary(services),
      ].join("\n");
    }
    return "Login cancelled; no credential was stored.";
  }
  const { providerId } = selected;
  if (selected.kind === "none") return `Provider ${providerId} does not require login.`;
  if (selected.kind === "literal") {
    return `Provider ${providerId} uses literal authentication from configuration; update that configuration instead of the Spark auth store.`;
  }
  if (selected.kind === "api_key") {
    const apiKey = await ctx.app.secret(`Enter API key for ${providerId}`);
    if (apiKey === undefined) return `Login cancelled for ${providerId}; no credential was stored.`;
    const normalized = apiKey.trim();
    if (!normalized) return `API key for ${providerId} must be non-empty.`;
    return await handleApiKeyLoginCommand(services, [providerId, normalized]);
  }

  const supported = listOAuthProviderSummaries();
  if (!supported.some((provider) => provider.id === providerId)) {
    return [
      `Unknown OAuth provider: ${providerId}`,
      `Supported OAuth providers: ${supported.map((provider) => provider.id).join(", ") || "none"}`,
      renderProviderSummary(services),
    ].join("\n");
  }

  const progress: string[] = [];
  const callbacks = createOAuthLoginCallbacks(services, ctx, progress);
  await services.authStore.loginOAuth(providerId, callbacks);
  return [`Logged in OAuth provider: ${providerId}`, ...progress].join("\n");
}

async function handleApiKeyLoginCommand(
  services: SparkCliHostServices,
  args: readonly string[],
): Promise<string> {
  if (!services.authStore) return STRINGS.authStoreUnavailable;
  const [providerId, apiKey] = args;
  if (!providerId || !apiKey) {
    return "Usage: /login api-key <provider> <key>";
  }
  const provider = services.providerRegistry.getProvider(providerId);
  if (!provider) {
    return [`Unknown Spark provider: ${providerId}`, renderProviderSummary(services)].join("\n");
  }
  await services.authStore.set(providerId, {
    type: "api_key",
    provider: providerId,
    apiKey,
    updatedAt: new Date().toISOString(),
  });
  const status = services.authResolver?.status(provider);
  const ref = status?.ref ? ` (${status.kind}:${status.ref})` : "";
  return `Stored API key for Spark provider: ${providerId}${ref}.`;
}

async function handleLogoutCommand(
  services: SparkCliHostServices,
  args: string,
  ctx: SparkNativeSlashCommandContext,
): Promise<string> {
  if (!services.authStore) return STRINGS.authStoreUnavailable;
  const stored = services.authStore.listProviders();
  const providerId = args.trim() || (await ctx.app.select("Select credential to remove", stored));
  if (!providerId) {
    return stored.length === 0
      ? "No stored Spark credentials are configured."
      : "Logout cancelled; no credential was removed.";
  }

  const provider = services.providerRegistry.getProvider(providerId);
  const status = provider && services.authResolver?.status(provider);
  if (status && status.kind !== "oauth" && !services.authStore.has(providerId)) {
    return `Provider ${providerId} uses ${status.kind} auth${status.ref ? ` (${status.ref})` : ""}; remove it from its environment/config source instead of Spark auth.json.`;
  }

  const removed = await services.authStore.remove(providerId);
  return removed ? STRINGS.removedCredential(providerId) : STRINGS.noCredential(providerId);
}

function createOAuthLoginCallbacks(
  services: SparkCliHostServices,
  ctx: SparkNativeSlashCommandContext,
  progress: string[],
): OAuthLoginCallbacks {
  const push = (message: string) => {
    progress.push(message);
    ctx.session.addSystemMessage(message);
  };
  return {
    onAuth: (info) => {
      push(
        [
          `Open OAuth authorization URL: ${info.url}`,
          info.instructions ? `Instructions: ${info.instructions}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
    onDeviceCode: (info) => {
      push(
        [
          `OAuth device code: ${info.userCode}`,
          `Verification URL: ${info.verificationUri}`,
          info.expiresInSeconds ? `Expires in: ${info.expiresInSeconds}s` : undefined,
          info.intervalSeconds ? `Polling interval: ${info.intervalSeconds}s` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
    onProgress: (message) => push(`OAuth: ${message}`),
    onPrompt: async (prompt) => {
      const value = await services.runtime
        .makeContext()
        .ui?.input?.(prompt.message, prompt.placeholder);
      if (value !== undefined) return value;
      if (prompt.allowEmpty) return "";
      throw new Error(`OAuth provider requested interactive input: ${prompt.message}`);
    },
    onManualCodeInput: async () => {
      const value = await services.runtime
        .makeContext()
        .ui?.input?.("Enter OAuth callback code", undefined);
      if (value !== undefined) return value;
      throw new Error("OAuth provider requested manual code input, but this UI cannot collect it.");
    },
    onSelect: async (prompt) => {
      const selected = await services.runtime.makeContext().ui?.select?.(
        prompt.message,
        prompt.options.map((option) => option.id),
      );
      return selected ?? prompt.options[0]?.id;
    },
  };
}

function resolveExplicitLocalAuthProvider(
  services: SparkCliHostServices,
  providerRef: string,
): LocalAuthProviderSelection | undefined {
  const normalized = providerRef.toLocaleLowerCase();
  const oauth = listOAuthProviderSummaries().find(
    (provider) =>
      provider.id.toLocaleLowerCase() === normalized ||
      provider.name.toLocaleLowerCase() === normalized,
  );
  if (oauth) return { providerId: oauth.id, kind: "oauth" };
  const provider = services.providerRegistry
    .listProviders()
    .find((entry) => entry.name.toLocaleLowerCase() === normalized);
  if (!provider) return undefined;
  const status = services.authResolver?.status(provider);
  if (status?.kind === "oauth" && status.ref) {
    return { providerId: status.ref, kind: "oauth" };
  }
  if (status?.kind === "none" || status?.kind === "literal") {
    return { providerId: provider.name, kind: status.kind };
  }
  return { providerId: provider.name, kind: "api_key" };
}

interface LocalAuthProviderSelection {
  providerId: string;
  kind: "oauth" | "api_key" | "none" | "literal";
}

async function selectLocalAuthProvider(
  services: SparkCliHostServices,
  ctx: SparkNativeSlashCommandContext,
): Promise<LocalAuthProviderSelection | undefined> {
  const oauthProviders = listOAuthProviderSummaries();
  const records: Array<{
    label: string;
    value: LocalAuthProviderSelection;
  }> = oauthProviders.map((provider) => ({
    label: `${provider.name} (${provider.id}) — oauth`,
    value: { providerId: provider.id, kind: "oauth" },
  }));
  for (const provider of services.providerRegistry.listProviders()) {
    const status = services.authResolver?.status(provider);
    if (status?.kind === "oauth" && status.ref) {
      records.push({
        label: `${provider.name} — oauth:${status.ref} · ${status.configured ? "configured" : "missing"}`,
        value: { providerId: status.ref, kind: "oauth" },
      });
      continue;
    }
    if (status?.kind === "none" || status?.kind === "literal") continue;
    if (oauthProviders.some((oauth) => oauth.id === provider.name)) continue;
    records.push({
      label: `${provider.name} — ${status?.kind ?? "api key"} · ${status?.configured ? "configured" : "missing"}`,
      value: { providerId: provider.name, kind: "api_key" },
    });
  }
  const selected = await ctx.app.select(
    "Select provider to log in",
    records.map((record) => record.label),
  );
  if (!selected) return undefined;
  return records.find((record) => record.label === selected)?.value;
}

function renderProviderSummary(services: SparkCliHostServices): string {
  const providers = services.providerRegistry.listProviders();
  if (providers.length === 0) return "No providers registered.";
  const rendered = providers.map((provider) => {
    const status = services.authResolver?.status(provider);
    const auth = status
      ? `${status.kind}${status.ref ? `:${status.ref}` : ""}=${status.configured ? "configured" : "missing"}`
      : "auth=unknown";
    return `${provider.name} (${auth})`;
  });
  return `Registered providers: ${rendered.join(", ")}`;
}
