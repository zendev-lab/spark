import type { ObservationRef, SourceRange } from "./types.ts";
import type { PatchProposalRef } from "./patch-proposal.ts";

export type LensStatusView = "summary" | "providers" | "queue" | "receipts";

export type LensInspectOperation =
  | "search"
  | "outline"
  | "enclosing"
  | "definition"
  | "declaration"
  | "type_definition"
  | "implementation"
  | "references"
  | "hover"
  | "signature"
  | "document_symbols"
  | "workspace_symbols"
  | "call_hierarchy"
  | "structural_search"
  | "ast"
  | "impact";

export type LensCheckKind = "preflight" | "diagnostics" | "lint" | "test" | "project" | "pr";

export type LensFixKind =
  | "quickfix"
  | "format"
  | "organize_imports"
  | "rename"
  | "structural_replace";

export type LensFixOperation = "propose" | "apply" | "reject";

export type LensTriageDisposition = "false_positive" | "defer" | "flagged" | "suppress";

export interface LensSourcePosition {
  line: number;
  character: number;
}

export type LensScope =
  | { kind: "file"; path: string }
  | { kind: "changed" }
  | { kind: "workspace" }
  | { kind: "git_change"; artifactRef: `artifact:${string}` };

export type LensVerificationTarget =
  | { kind: "workspace" }
  | { kind: "git_change"; artifactRef: `artifact:${string}` }
  | { kind: "task"; taskRef: `task:${string}` }
  | { kind: "goal"; goalRef: `goal:${string}` };

export type LensActionRequest =
  | {
      action: "status";
      view?: LensStatusView;
      artifactRef?: `artifact:${string}`;
    }
  | {
      action: "inspect";
      operation: LensInspectOperation;
      scope?: LensScope;
      path?: string;
      position?: LensSourcePosition;
      query?: string;
      pattern?: string;
      limit?: number;
    }
  | {
      action: "check";
      kind: LensCheckKind;
      scope: LensScope;
      refresh?: boolean;
      maxFindings?: number;
    }
  | {
      action: "fix";
      operation: "propose";
      kind: LensFixKind;
      observationRef?: ObservationRef;
      candidateRef?: string;
      path?: string;
      position?: LensSourcePosition;
      newName?: string;
    }
  | {
      action: "fix";
      operation: "apply";
      proposalRef: PatchProposalRef;
      selectionRef?: string;
    }
  | {
      action: "fix";
      operation: "reject";
      proposalRef: PatchProposalRef;
      reason?: string;
    }
  | {
      action: "triage";
      observationRef: ObservationRef;
      disposition: LensTriageDisposition;
      reason?: string;
    }
  | {
      action: "verify";
      target: LensVerificationTarget;
      refresh?: boolean;
    };

export interface LensReadLocator {
  path: string;
  artifactRef?: `artifact:${string}`;
  fileVersion?: `sha256:${string}`;
  revisionDigest: string;
  offset: number;
  limit: number;
  reason: string;
  symbol?: {
    name: string;
    kind: string;
    range: SourceRange;
  };
}

export type LensReadAnalysisMode = "auto" | "fresh" | "off";
export type LensReadRepairMode = "none" | "format" | "safe_fixes" | "format_and_safe_fixes";

export interface LensObservationSummary {
  ref: ObservationRef;
  severity: "blocker" | "error" | "warning" | "info";
  path: string;
  range?: SourceRange;
  code?: string;
  message: string;
  sources: readonly string[];
  snippet?: string;
  fixable: boolean;
  candidateRef?: string;
}

export interface LensReadAnnotation {
  fileVersion: `sha256:${string}`;
  revisionDigest: string;
  status: "complete" | "partial" | "pending" | "unsupported" | "stale";
  enclosing?: LensReadLocator;
  recommendedReads: readonly LensReadLocator[];
  diagnostics: {
    inRange: readonly LensObservationSummary[];
    elsewhere: { errors: number; warnings: number };
    authoritativeClean: boolean;
  };
  format: {
    status: "clean" | "changes_available" | "pending" | "unavailable";
    candidateRef?: string;
  };
  fixes: readonly {
    candidateRef: string;
    kind: LensFixKind;
    title: string;
    safe: boolean;
  }[];
  checkTicketRef?: `lens-check:${string}`;
}

export interface LensReadRepairReceipt {
  proposalRef: PatchProposalRef;
  providers: readonly string[];
  previousVersion: `sha256:${string}`;
  version: `sha256:${string}`;
  revisionDigest: string;
  verificationVerdict: "pass" | "fail" | "inconclusive" | "stale";
}

export interface LensWorkspaceChange {
  path: string;
  previousVersion: "missing" | `sha256:${string}`;
  version: `sha256:${string}`;
  changedRanges: readonly SourceRange[];
  source: "write" | "edit" | "read_repair" | "lens_patch";
}
