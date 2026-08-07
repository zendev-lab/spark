import { defaultEvidenceStore, type EvidenceRecord } from "@zendev-lab/spark-artifacts";
import type { AskRef, EvidenceRef, JsonValue } from "@zendev-lab/spark-core";
import type { SparkEvidenceAnswerEvent } from "@zendev-lab/spark-protocol";
import type { SparkDaemonHumanWaitRecord } from "./human-waits.ts";
import type { SparkLoopStore } from "../store/loops.ts";

interface PersistedHumanAnswerEventSource {
  listEvidenceAnswerEvents(): SparkEvidenceAnswerEvent[];
  get(humanRequestId: string): SparkDaemonHumanWaitRecord | null | undefined;
}

export interface HumanAnswerEvidenceProjection {
  record: EvidenceRecord<JsonValue>;
  created: boolean;
}

export interface HumanAnswerEvidenceReconciliationResult {
  projected: number;
  existing: number;
  skipped: number;
  failed: number;
}

export function humanAnswerEvidenceRef(event: SparkEvidenceAnswerEvent): EvidenceRef {
  return `evidence:${event.answerEventId}` as EvidenceRef;
}

/**
 * Idempotently projects one daemon-committed direct-user AnswerEvent into the
 * workspace Evidence store. The AnswerEvent remains canonical input; this
 * record is the typed candidate consumed by Goal/Repro owner reconciliation.
 */
export async function projectHumanAnswerEventEvidence(
  cwd: string,
  event: SparkEvidenceAnswerEvent,
): Promise<EvidenceRecord<JsonValue>> {
  return (await ensureHumanAnswerEventEvidence(cwd, event)).record;
}

export async function ensureHumanAnswerEventEvidence(
  cwd: string,
  event: SparkEvidenceAnswerEvent,
): Promise<HumanAnswerEvidenceProjection> {
  const store = defaultEvidenceStore(cwd);
  const ref = humanAnswerEvidenceRef(event);
  const body = JSON.parse(JSON.stringify(event)) as JsonValue;
  const existing = await store.tryGet<JsonValue>(ref);
  if (existing) {
    const canonicalLink = existing.links.some(
      (link) => link.to === event.binding.askRef && link.relation === "answer-to",
    );
    if (
      JSON.stringify(existing.body) !== JSON.stringify(body) ||
      existing.provenance.producer !== "ask" ||
      !canonicalLink
    ) {
      throw new Error(`AnswerEvent Evidence ref conflict: ${ref}`);
    }
    return { record: existing, created: false };
  }
  const record = await store.put({
    ref,
    kind: "record",
    title: `Direct user answer for ${event.binding.askRef}`,
    format: "json",
    body,
    provenance: { producer: "ask" },
    links: [{ to: event.binding.askRef as AskRef, relation: "answer-to" }],
  });
  return { record, created: true };
}

export function wakeHumanAnswerEvidenceOwner(
  loopStore: SparkLoopStore,
  event: SparkEvidenceAnswerEvent,
) {
  const { binding } = event;
  const wakeable = new Set(["retry_wait", "dormant", "blocked"]);
  return loopStore
    .list({ ownerSessionId: binding.ownerSessionId })
    .filter((loop) => {
      if (!wakeable.has(loop.status)) return false;
      return binding.modeScope === "repro"
        ? loop.binding.reproId === binding.goalOrReproId
        : loop.binding.goalId === binding.goalOrReproId;
    })
    .map((loop) =>
      loopStore.wake(loop.loopId, {
        reason: `direct-user AnswerEvent accepted for ${binding.ownerStepOrUnresolvedId}`,
      }),
    );
}

/** Reproject every durable AnswerEvent after daemon restart without duplicating Evidence. */
export async function reconcileHumanAnswerEventEvidence(
  source: PersistedHumanAnswerEventSource,
  resolveWorkspacePath: (wait: SparkDaemonHumanWaitRecord) => string | undefined,
  onError: (error: unknown, event: SparkEvidenceAnswerEvent) => void = () => undefined,
  onProjected: (
    event: SparkEvidenceAnswerEvent,
    wait: SparkDaemonHumanWaitRecord,
  ) => void | Promise<void> = () => undefined,
): Promise<HumanAnswerEvidenceReconciliationResult> {
  const result: HumanAnswerEvidenceReconciliationResult = {
    projected: 0,
    existing: 0,
    skipped: 0,
    failed: 0,
  };
  for (const event of source.listEvidenceAnswerEvents()) {
    const wait = source.get(event.humanRequestId);
    if (!wait) {
      result.skipped += 1;
      continue;
    }
    const cwd = resolveWorkspacePath(wait);
    if (!cwd) {
      result.skipped += 1;
      continue;
    }
    try {
      const projection = await ensureHumanAnswerEventEvidence(cwd, event);
      if (projection.created) {
        result.projected += 1;
        await Promise.resolve(onProjected(event, wait));
      } else {
        result.existing += 1;
      }
    } catch (error) {
      result.failed += 1;
      onError(error, event);
    }
  }
  return result;
}
