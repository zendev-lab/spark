import type { HubMessages } from "@zendev-lab/spark-i18n/hub";
import {
  parseSparkSlashInput,
  resolveSparkSlashEditorInput,
  sparkSlashActionBarCatalog,
  type SparkActionBarView,
} from "@zendev-lab/spark-protocol";

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
  if (resolution.kind !== "suggest") return [];

  return resolution.suggestions.map((suggestion) => {
    const view = localizeHubSlashActionBar(suggestion.descriptor.actionBar, messages);
    return {
      id: `${suggestion.canonicalCommand}:${suggestion.command}`,
      command: suggestion.command,
      canonicalCommand: suggestion.canonicalCommand,
      title: view.title,
      ...(view.description ? { description: view.description } : {}),
    };
  });
}

/**
 * The session picker is a navigation surface, so its two explicit spellings
 * should open it directly on Enter instead of requiring a second action-bar
 * click. Other session aliases keep their distinct action-bar semantics.
 */
export function hubSessionSelectionShortcutForInput(input: string): boolean {
  const resolution = resolveSparkSlashEditorInput(input);
  return (
    resolution.kind === "exact" &&
    resolution.descriptor.name === "session" &&
    (resolution.command === "session" || resolution.command === "sessions")
  );
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
