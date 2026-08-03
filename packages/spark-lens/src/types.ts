export type ProviderId = string & { readonly __providerId: unique symbol };
export type ProviderVersion = string & { readonly __providerVersion: unique symbol };
export type ObservationRef = `observation:${string}`;

export type LensCapability =
  | "diagnostics"
  | "verify"
  | "health"
  | "search"
  | "outline"
  | "navigate"
  | "structural_search"
  | "impact"
  | "format"
  | "rename"
  | "completion"
  | "code_action"
  | "test";

export type LensTrigger = "change" | "save" | "turn_end" | "quiet" | "manual";

export interface ProviderCapability {
  capability: LensCapability;
  quality: "experimental" | "stable" | "authoritative";
  latency: "interactive" | "medium" | "heavy";
  supportsIncremental: boolean;
  mutation: "none" | "proposal";
}

export interface LensProviderSpec {
  id: ProviderId;
  kind: "lsp" | "compiler" | "linter" | "formatter" | "parser" | "test" | "indexer";
  languages: readonly string[];
  capabilities: readonly ProviderCapability[];
}

export interface WorkspaceRevision {
  schemaVersion: 1;
  workspaceRoot: string;
  headOid: string | null;
  trackedDiffDigest: string;
  stagedDiffDigest: string;
  untrackedContentDigest: string;
  profileDigest: string;
  digest: string;
  observedAt: string;
}

export interface ProviderRequest<TInput = unknown> {
  capability: LensCapability;
  input: TInput;
  revision: WorkspaceRevision;
}

export interface LensProviderSession {
  readonly providerId: ProviderId;
  readonly providerVersion: ProviderVersion;
  readonly workspaceRoot: string;
  request(request: ProviderRequest, signal: AbortSignal): Promise<unknown>;
  health(): Promise<ProviderHealth>;
  close(): Promise<void>;
}

export interface LensProvider {
  readonly spec: LensProviderSpec;
  open(workspace: LensWorkspaceContext, signal: AbortSignal): Promise<LensProviderSession>;
}

export interface LensWorkspaceContext {
  /** Canonical root of the isolated Git worktree. */
  worktreeRoot: string;
  /** Project root used to initialize the provider. */
  projectRoot: string;
  workspaceRoot: string;
  profileDigest: string;
  /** Digest of the effective provider configuration, excluding secrets. */
  configDigest: string;
}

export type ProviderResultStatus = "ok" | "error" | "timeout" | "cancelled" | "silent";

export interface ProviderResult<T = unknown> {
  providerId: ProviderId;
  providerVersion: ProviderVersion;
  capability: LensCapability;
  revisionDigest: string;
  status: ProviderResultStatus;
  producedAt: string;
  durationMs: number;
  value?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unavailable";
  checkedAt: string;
  message?: string;
}

export type ObservationSeverity = "blocker" | "error" | "warning" | "info";
export type ObservationDisposition =
  | "open"
  | "false_positive"
  | "deferred"
  | "flagged"
  | "suppressed";

export interface SourceRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface ProviderObservation {
  providerId: ProviderId;
  providerVersion: ProviderVersion;
  code?: string;
  message: string;
  durationMs: number;
}

export interface Observation {
  ref: ObservationRef;
  revisionDigest: string;
  capability: LensCapability;
  subject: {
    path?: string;
    range?: SourceRange;
    symbol?: string;
  };
  category: "syntax" | "type" | "lint" | "correctness" | "security" | "test" | "impact";
  severity: ObservationSeverity;
  summary: string;
  disposition: ObservationDisposition;
  agreement: "single_source" | "corroborated" | "conflicting";
  observations: readonly ProviderObservation[];
}

export type LensVerdict = "pass" | "fail" | "inconclusive" | "stale";
