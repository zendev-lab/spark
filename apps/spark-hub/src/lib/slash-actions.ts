import type { HubMessages } from "@zendev-lab/spark-i18n/hub";
import {
  parseSparkSlashInput,
  resolveSparkSlashEditorInput,
  sparkSlashActionBarCatalog,
} from "@zendev-lab/spark-protocol/presentation";
import { type SparkActionBarView } from "@zendev-lab/spark-protocol/presentation";

export const hubOpenSearchEvent = "spark-hub:open-search";

export type HubActionScheduler = (callback: () => void) => unknown;
export type HubComposerSubmissionState = "idle" | "submitting" | "success" | "error";

export type HubComposerFeedbackTransition = Readonly<{
  state: HubComposerSubmissionState;
  clearFeedback: boolean;
}>;

export type HubSlashActionMessages = HubMessages["sessions"]["workbench"]["slashActions"];

export type HubSlashCommandSuggestion = Readonly<{
  id: string;
  command: string;
  canonicalCommand: string;
  title: string;
  description?: string;
}>;

export type HubDirectSessionCommand = "select" | "create";

export function hubComposerFeedbackAfterInput(
  state: HubComposerSubmissionState,
): HubComposerFeedbackTransition {
  if (state === "submitting") return { state, clearFeedback: false };
  return {
    state: state === "error" || state === "success" ? "idle" : state,
    clearFeedback: true,
  };
}

/**
 * Defer a dialog-opening action until the click that selected the slash action
 * has finished. Otherwise the dialog can observe that same click as an outside
 * interaction and immediately close itself.
 */
export function scheduleHubActionAfterCurrentEvent(
  action: () => void,
  schedule: HubActionScheduler = (callback) => requestAnimationFrame(callback),
): void {
  schedule(action);
}

/** Replace protocol fallback copy with the active Hub locale. */
export function localizeHubSlashActionBar(
  view: SparkActionBarView,
  messages: HubSlashActionMessages,
): SparkActionBarView {
  const { description: _description, ...rest } = view;
  const description = lookup(messages.descriptions, view.id);
  return {
    ...rest,
    title: lookup(messages.titles, view.id) ?? messages.fallbackTitle,
    ...(description ? { description } : {}),
    actions: view.actions.map(({ description: _actionDescription, ...action }) => ({
      ...action,
      label: lookup(messages.actions, action.id) ?? messages.fallbackAction,
    })),
  };
}

/** Build localized, de-duplicated suggestions for the current editor value. */
export function hubSlashSuggestionsForInput(
  input: string,
  messages: HubSlashActionMessages,
): readonly HubSlashCommandSuggestion[] {
  const resolution = resolveSparkSlashEditorInput(input);
  const catalogSuggestions =
    resolution.kind === "suggest"
      ? resolution.suggestions.map((suggestion) => {
          const view = localizeHubSlashActionBar(suggestion.descriptor.actionBar, messages);
          return {
            id: `${suggestion.canonicalCommand}:${suggestion.command}`,
            command: suggestion.command,
            canonicalCommand: suggestion.canonicalCommand,
            title: view.title,
            ...(view.description ? { description: view.description } : {}),
          };
        })
      : [];

  return [...catalogSuggestions, ...hubDirectSessionSuggestions(input, messages)];
}

/**
 * Session navigation is host-owned rather than an action-bar surface.
 * `/sessions` and bare `/resume` open the selector; `/new` opens creation.
 */
export function hubDirectSessionCommandForInput(
  input: string,
): HubDirectSessionCommand | undefined {
  const parsed = parseSparkSlashInput(input);
  if (!parsed || parsed.args) return undefined;
  if (parsed.command === "sessions" || parsed.command === "resume") return "select";
  if (parsed.command === "new") return "create";
  return undefined;
}

/** Match a known command name even when arguments are present. */
export function hubSlashCatalogActionBarForInput(input: string): SparkActionBarView | undefined {
  const parsed = parseSparkSlashInput(input);
  return parsed ? sparkSlashActionBarCatalog[parsed.command] : undefined;
}

export function hubSlashSubmissionError(
  input: string,
  messages: HubSlashActionMessages,
): string | null {
  const parsed = parseSparkSlashInput(input);
  if (!parsed) return null;
  const view = sparkSlashActionBarCatalog[parsed.command];
  if (!view) {
    return messages.unsupportedRejected.replace("{command}", parsed.command);
  }
  const title = localizeHubSlashActionBar(view, messages).title;
  return messages.serverRejected.replace("{title}", title);
}

function lookup(values: object, key: string): string | undefined {
  const candidate = (values as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function hubDirectSessionSuggestions(
  input: string,
  messages: HubSlashActionMessages,
): HubSlashCommandSuggestion[] {
  const match = /^\/([a-z0-9-]*)$/iu.exec(input.trim());
  if (!match || input.trim().startsWith("//")) return [];
  const query = (match[1] ?? "").toLowerCase();
  const candidates: Array<{ command: string; canonicalCommand: string }> = [];
  if (query === "") {
    candidates.push(
      { command: "sessions", canonicalCommand: "sessions" },
      { command: "new", canonicalCommand: "new" },
    );
  } else if ("sessions".startsWith(query)) {
    candidates.push({ command: "sessions", canonicalCommand: "sessions" });
  } else if ("resume".startsWith(query)) {
    candidates.push({ command: "resume", canonicalCommand: "sessions" });
  } else if ("new".startsWith(query)) {
    candidates.push({ command: "new", canonicalCommand: "new" });
  }
  if (candidates.some((candidate) => candidate.command === query)) return [];
  const title = lookup(messages.titles, "session") ?? messages.fallbackTitle;
  const description = lookup(messages.descriptions, "session");
  return candidates.map((candidate) => ({
    id: `${candidate.canonicalCommand}:${candidate.command}`,
    ...candidate,
    title,
    ...(description ? { description } : {}),
  }));
}
