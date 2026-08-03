import { createHash } from "node:crypto";

import { stableJson } from "./revision.ts";
import type {
  ObservationDisposition,
  ObservationRef,
  ProviderId,
  WorkspaceRevision,
} from "./types.ts";

export type PatchProposalRef = `patch-proposal:${string}`;

export interface PatchTextEdit {
  path: string;
  startOffset: number;
  endOffset: number;
  newText: string;
}

export interface PatchPrecondition {
  path: string;
  expectedVersion: "missing" | `sha256:${string}`;
}

export type PatchSelectionReason =
  | "unsafe"
  | "create_delete"
  | "multiple_candidates"
  | "cross_file_rename";

export type PatchSafety =
  | { kind: "safe" }
  | {
      kind: "requires_selection";
      reasons: readonly PatchSelectionReason[];
    };

export interface PatchProposal {
  schemaVersion: 1;
  ref: PatchProposalRef;
  baseRevision: WorkspaceRevision;
  provider: ProviderId;
  edits: readonly PatchTextEdit[];
  preconditions: readonly PatchPrecondition[];
  expectedResolution: readonly ObservationRef[];
  safety: PatchSafety;
  createdAt: string;
}

export interface PatchPromotion {
  proposalRef: PatchProposalRef;
  baseRevisionDigest: string;
  promotedRevision: WorkspaceRevision;
  verificationEvidenceRef?: `evidence:${string}`;
  verdict: "pass" | "fail" | "inconclusive" | "stale";
  appliedAt: string;
}

export interface ObservationDispositionRecord {
  observationRef: ObservationRef;
  revisionDigest: string;
  disposition: Exclude<ObservationDisposition, "open">;
  patchProposalRef?: PatchProposalRef;
  updatedAt: string;
}

export function createPatchProposal(
  input: Omit<PatchProposal, "schemaVersion" | "ref">,
): PatchProposal {
  assertPatchEdits(input.edits);
  const reasons =
    input.safety.kind === "requires_selection"
      ? [...new Set(input.safety.reasons)].sort()
      : undefined;
  if (input.safety.kind === "requires_selection" && reasons?.length === 0) {
    throw new Error("requires_selection patch safety needs at least one reason");
  }
  const normalized = {
    ...input,
    edits: [...input.edits],
    preconditions: [...input.preconditions],
    expectedResolution: [...input.expectedResolution],
    safety:
      input.safety.kind === "safe"
        ? input.safety
        : { kind: "requires_selection" as const, reasons: reasons! },
  };
  const digest = createHash("sha256").update(stableJson(normalized)).digest("hex");
  return {
    schemaVersion: 1,
    ref: `patch-proposal:${digest}`,
    ...normalized,
  };
}

export function assertPatchEdits(edits: readonly PatchTextEdit[]): void {
  if (edits.length === 0) throw new Error("patch proposal requires at least one edit");
  const byPath = new Map<string, PatchTextEdit[]>();
  for (const edit of edits) {
    if (!edit.path || edit.path.startsWith("/") || edit.path.split(/[\\/]/u).includes("..")) {
      throw new Error(`patch edit path must be workspace-relative: ${edit.path}`);
    }
    if (
      !Number.isSafeInteger(edit.startOffset) ||
      !Number.isSafeInteger(edit.endOffset) ||
      edit.startOffset < 0 ||
      edit.endOffset < edit.startOffset
    ) {
      throw new Error(`invalid patch edit offsets for ${edit.path}`);
    }
    const group = byPath.get(edit.path);
    if (group) group.push(edit);
    else byPath.set(edit.path, [edit]);
  }
  for (const [path, pathEdits] of byPath) {
    const ordered = [...pathEdits].sort((left, right) => left.startOffset - right.startOffset);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.startOffset < ordered[index - 1]!.endOffset) {
        throw new Error(`overlapping patch edits for ${path}`);
      }
    }
  }
}
