import { createHash } from "node:crypto";

import {
  isRecallCandidateExpired,
  type RecallCandidate,
  type RecallScope,
} from "./recall-store.ts";

export interface RecallCandidateGcPlanItem {
  id: string;
  kind: RecallCandidate["kind"];
  updatedAt: string;
  expiresAt: string;
  reasonCode: "compaction_open_item" | "compaction_snapshot";
}

export interface RecallCandidateGcPlan {
  schemaVersion: 1;
  scope: RecallScope;
  olderThanDays: number;
  generatedAt: string;
  reasonSummary: string;
  digest: string;
  expiryBindings: Array<{ id: string; expiresAt: string | null }>;
  protectedIds: string[];
  items: RecallCandidateGcPlanItem[];
}

export function createRecallCandidateGcPlan(input: {
  candidates: readonly RecallCandidate[];
  scope: RecallScope;
  olderThanDays: number;
  now?: string;
  protectedRecordRefs?: readonly string[];
}): RecallCandidateGcPlan {
  const generatedAt = new Date(input.now ?? new Date().toISOString()).toISOString();
  const cutoff = Date.parse(generatedAt) - input.olderThanDays * 24 * 60 * 60 * 1_000;
  const expiryBindings = input.candidates
    .filter((candidate) => candidate.scope === input.scope)
    .map((candidate) => ({ id: candidate.id, expiresAt: candidate.expiresAt ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const protectedIds = [
    ...new Set([
      ...(input.protectedRecordRefs ?? []),
      ...input.candidates
        .filter(
          (candidate) =>
            candidate.scope === input.scope &&
            (candidate.kind === "explicit" ||
              !candidate.sourceSessionId ||
              candidate.status === "promoted"),
        )
        .map((candidate) => candidate.id),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const items = input.candidates.flatMap((candidate): RecallCandidateGcPlanItem[] => {
    if (
      candidate.scope !== input.scope ||
      candidate.status !== "candidate" ||
      candidate.kind === "explicit" ||
      !candidate.sourceSessionId ||
      !candidate.expiresAt ||
      !isRecallCandidateExpired(candidate, generatedAt) ||
      Date.parse(candidate.updatedAt) > cutoff
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        kind: candidate.kind,
        updatedAt: candidate.updatedAt,
        expiresAt: candidate.expiresAt,
        reasonCode: candidate.kind === "open_item" ? "compaction_open_item" : "compaction_snapshot",
      },
    ];
  });
  items.sort((left, right) => left.id.localeCompare(right.id));
  const reasonSummary =
    "session-scoped compaction candidates exceeded their recall TTL; explicit and promoted records remain protected";
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        scope: input.scope,
        olderThanDays: input.olderThanDays,
        protectedIds,
        expiryBindings,
        items,
      }),
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    scope: input.scope,
    olderThanDays: input.olderThanDays,
    generatedAt,
    reasonSummary,
    digest,
    expiryBindings,
    protectedIds,
    items,
  };
}
