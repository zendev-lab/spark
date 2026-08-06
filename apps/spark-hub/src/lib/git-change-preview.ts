import { isArtifactBody, type GitChangeArtifactBody } from "@zendev-lab/spark-artifacts";
import type { GitChangePreviewModel } from "@zendev-lab/spark-ui/git-change";

export function gitChangePreviewFromContentRef(
  artifactKind: unknown,
  value: unknown,
): GitChangePreviewModel | null {
  if (artifactKind !== "git_change" && artifactKind !== "pr") return null;
  const contentRef = isRecord(value) ? value : null;
  const body = contentRef && isRecord(contentRef.inlineJson) ? contentRef.inlineJson : contentRef;
  if (!body) return null;
  if (isArtifactBody(body) && body.kind === "git_change") return fromCanonicalGitChange(body);
  return legacyPrPreview(body);
}

function fromCanonicalGitChange(body: GitChangeArtifactBody): GitChangePreviewModel {
  return {
    repository: body.repository,
    trunk: body.trunk,
    lifecycle: body.lifecycle,
    worktree: body.worktree,
    stack: body.stack,
    cleanupBlockers: body.cleanupBlockers,
  };
}

/**
 * Old PR rows are normalized only at the Hub projection edge so an
 * existing stable Artifact URL renders while the daemon republishes it as a
 * canonical git_change. This is not an Artifact writer or Spark UI protocol.
 */
function legacyPrPreview(body: Record<string, unknown>): GitChangePreviewModel | null {
  if (
    body.schemaVersion !== 1 ||
    body.kind !== "pr" ||
    !isString(body.repo) ||
    !isString(body.baseRef) ||
    !isString(body.headRef) ||
    !isString(body.url) ||
    !isString(body.state) ||
    !isString(body.title) ||
    !isPositiveInteger(body.number)
  ) {
    return null;
  }
  const state = body.state.toLowerCase();
  const merged = state === "merged";
  const closed = state === "closed";
  const removed = body.worktreeStatus === "removed";
  const worktreePath = optionalString(body.worktreePath);
  return {
    repository: {
      forge: optionalString(body.forge) ?? "github",
      repo: body.repo,
    },
    trunk: body.baseRef,
    lifecycle: removed ? "cleaned" : merged || closed ? "terminal" : "published",
    worktree: {
      path: worktreePath,
      branch: optionalString(body.worktreeBranch) ?? body.headRef,
      ownership: "external",
      status: removed
        ? "cleaned"
        : worktreePath && body.worktreeStatus === "attached"
          ? "attached"
          : "missing",
      error: optionalString(body.worktreeError),
    },
    stack: {
      authority: "legacy-unbound",
      currentBranch: body.headRef,
      observedAt: optionalString(body.syncedAt),
      entries: [
        {
          branch: body.headRef,
          base: body.baseRef,
          isCurrent: true,
          isMerged: merged,
          isQueued: false,
          needsRebase: false,
          pullRequest: {
            number: body.number,
            url: body.url,
            state: body.state,
            title: body.title,
            headRef: body.headRef,
            baseRef: body.baseRef,
            draft: typeof body.draft === "boolean" ? body.draft : undefined,
            labels: optionalStringArray(body.labels),
            checksSummary: optionalString(body.checksSummary),
            bodyText: optionalString(body.bodyText),
            diffSummary: optionalString(body.diffSummary),
          },
        },
      ],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(isString) ? value : undefined;
}
