export interface GitChangePreviewPullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
  headRef: string;
  baseRef: string;
  draft?: boolean;
  labels?: string[];
  checks?: Array<{ name: string; state: string }>;
  checksSummary?: string;
  checksVerdict?: "pass" | "fail" | "pending" | "inconclusive";
  mergeable?: boolean;
  mergeStateStatus?: string;
  bodyText?: string;
  diffSummary?: string;
}

export interface GitChangePreviewEntry {
  branch: string;
  base: string;
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  needsRebase: boolean;
  pullRequest?: GitChangePreviewPullRequest;
}

export interface GitChangePreviewModel {
  repository: {
    forge: string;
    repo: string;
    remote?: string;
    commonGitDir?: string;
  };
  trunk: string;
  lifecycle: string;
  worktree: {
    path?: string;
    branch?: string;
    ownership: string;
    status: string;
    error?: string;
  };
  stack: {
    authority: string;
    number?: number;
    currentBranch?: string;
    entries: GitChangePreviewEntry[];
    observedAt?: string;
  };
  cleanupBlockers?: string[];
}

export interface GitChangePreviewLabels {
  repository: string;
  trunk: string;
  lifecycle: string;
  stack: string;
  branch: string;
  base: string;
  current: string;
  merged: string;
  queued: string;
  needsRebase: string;
  draft: string;
  openPullRequest: string;
  checks: string;
  mergeable: string;
  conflict: string;
  description: string;
  diff: string;
  technicalDetails: string;
  worktree: string;
  ownership: string;
  cleanupBlockers: string;
}

export const defaultGitChangePreviewLabels: GitChangePreviewLabels = {
  repository: "Repository",
  trunk: "Trunk",
  lifecycle: "Lifecycle",
  stack: "Stack",
  branch: "Branch",
  base: "Base",
  current: "Current",
  merged: "Merged",
  queued: "Queued",
  needsRebase: "Needs rebase",
  draft: "Draft",
  openPullRequest: "Open pull request",
  checks: "Checks",
  mergeable: "Mergeable",
  conflict: "Conflict",
  description: "Description",
  diff: "Diff summary",
  technicalDetails: "Technical details",
  worktree: "Worktree",
  ownership: "Ownership",
  cleanupBlockers: "Cleanup blockers",
};
