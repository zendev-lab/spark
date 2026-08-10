import type { Snippet } from "svelte";

export type WorkbenchStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "blocked"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "approved"
  | "rejected";

export type WorkbenchDisplayValue =
  | string
  | number
  | boolean
  | null
  | readonly WorkbenchDisplayValue[]
  | { readonly [key: string]: WorkbenchDisplayValue };

export type WorkbenchErrorView = Readonly<{
  title: string;
  message: string;
  code?: string;
}>;

export type ToolView = Readonly<{
  id: string;
  name: string;
  status: WorkbenchStatus;
  summary?: string;
  input?: WorkbenchDisplayValue;
  output?: WorkbenchDisplayValue;
  error?: WorkbenchErrorView;
}>;

export type ConfirmationView = Readonly<{
  id: string;
  title: string;
  status: "pending" | "requested" | "resolved" | "approved" | "rejected" | "cancelled";
  description?: string;
  detail?: string;
}>;

export type PlanStepView = Readonly<{
  id: string;
  title: string;
  status: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  description?: string;
}>;

export type PlanView = Readonly<{
  id: string;
  title: string;
  status: WorkbenchStatus;
  description?: string;
  steps: readonly PlanStepView[];
}>;

export type TaskView = Readonly<{
  id: string;
  title: string;
  status: WorkbenchStatus;
  summary?: string;
  description?: string;
}>;

export type ArtifactView = Readonly<{
  id: string;
  title: string;
  kind?: string;
  status?: string;
  summary?: string;
  previewHref?: string;
}>;

export type CodeBlockView = Readonly<{
  code: string;
  language?: string;
  filename?: string;
  highlightLines?: readonly number[];
}>;

export type DiffLineKind = "context" | "addition" | "deletion" | "header";

export type DiffLineView = Readonly<{
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}>;

export type DiffViewModel = Readonly<{
  id: string;
  title: string;
  additions?: number;
  deletions?: number;
  lines: readonly DiffLineView[];
}>;

export type FileTreeEntryView = Readonly<{
  id: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
}>;

export type TerminalViewModel = Readonly<{
  id: string;
  title?: string;
  command?: string;
  output: string;
  status?: WorkbenchStatus;
}>;

export type TestResultView = Readonly<{
  id: string;
  name: string;
  status: "passed" | "failed" | "skipped" | "running";
  durationMs?: number;
  message?: string;
}>;

export type StackFrameView = Readonly<{
  id: string;
  functionName?: string;
  file?: string;
  line?: number;
  column?: number;
  source?: string;
}>;

export type CommitView = Readonly<{
  hash: string;
  title: string;
  author?: string;
  timestamp?: string;
  description?: string;
  href?: string;
}>;

export type WebPreviewView = Readonly<{
  id: string;
  title: string;
  description?: string;
  href?: string;
  screenshotHref?: string;
}>;

export type WorkbenchPanelProps = {
  id: string;
  title: string;
  status?: string;
  statusLabel?: string;
  summary?: string;
  defaultOpen?: boolean;
  nested?: boolean;
  children?: Snippet;
  details?: Snippet;
  actions?: Snippet;
};
