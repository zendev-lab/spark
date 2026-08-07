import type { GitChangeArtifactBody, GitChangeEntry } from "../artifact/index.ts";

export type GitChangeReviewState = "unpublished" | "draft" | "ready" | "mixed" | "terminal";

/**
 * Derive review readiness from the native PR snapshots already stored in a
 * git_change Artifact. This is a projection, never a second writable state.
 */
export function gitChangeReviewState(body: GitChangeArtifactBody): GitChangeReviewState {
  if (body.lifecycle === "terminal" || body.lifecycle === "cleaned") return "terminal";
  if (body.stack.entries.length === 0) return "unpublished";

  const nonTerminal = body.stack.entries.filter((entry) => !isTerminalEntry(entry));
  if (nonTerminal.length === 0) return "terminal";

  const published = nonTerminal.filter((entry) => entry.pullRequest !== undefined);
  if (published.length === 0) return "unpublished";
  if (published.length !== nonTerminal.length) return "mixed";

  const draftCount = published.filter((entry) => entry.pullRequest?.draft === true).length;
  const readyCount = published.filter((entry) => entry.pullRequest?.draft === false).length;
  if (draftCount === published.length) return "draft";
  if (readyCount === published.length) return "ready";
  return "mixed";
}

function isTerminalEntry(entry: GitChangeEntry): boolean {
  if (entry.isMerged) return true;
  const state = entry.pullRequest?.state.toLowerCase();
  return state === "merged" || state === "closed";
}
