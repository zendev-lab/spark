import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonFileAtomic } from "@zendev-lab/spark-core";

import { memoryContentDigest } from "./lifecycle.ts";
import { withFileMutationLock } from "./mutation-lock.ts";

export const RETRIEVAL_TELEMETRY_SCHEMA = "spark.memory.retrieval-telemetry/v1" as const;
export const RETRIEVAL_TELEMETRY_REPLAY_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000;
export type RetrievalTelemetryOutcome =
  | "retrieval"
  | "successful_use"
  | "negative_feedback"
  | "task_success";

export interface RetrievalTelemetryRecord {
  memoryRef: string;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  successfulUseCount: number;
  negativeFeedbackCount: number;
  lastOutcomeAt: string | null;
  idempotencyKey: string | null;
}

interface RetrievalTelemetryIdempotencyBinding {
  idempotencyKey: string;
  memoryRef: string;
  inputDigest: string;
  recordedAt: string;
  retainedUntil: string;
}

interface RetrievalTelemetrySnapshot {
  schema: typeof RETRIEVAL_TELEMETRY_SCHEMA;
  records: RetrievalTelemetryRecord[];
  idempotency: RetrievalTelemetryIdempotencyBinding[];
}

export interface RetrievalTelemetryStoreOptions {
  now?: () => string;
  maxRecords?: number;
  maxIdempotencyKeys?: number;
  replayHorizonMs?: number;
}

export class RetrievalTelemetryStore {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly options: RetrievalTelemetryStoreOptions;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: RetrievalTelemetryStoreOptions = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.options = options;
  }

  async record(input: {
    memoryRef: string;
    outcome: RetrievalTelemetryOutcome;
    idempotencyKey: string;
    at?: string;
  }): Promise<{ record: RetrievalTelemetryRecord; idempotent: boolean }> {
    const normalized = normalizeRecordInput(input, this.options.now?.());
    return this.enqueueMutation(async () =>
      withFileMutationLock(this.lockPath, async () => {
        const snapshot = await this.load();
        const recordedAt = normalizeTimestamp(
          this.options.now?.() ?? new Date().toISOString(),
          "recordedAt",
        );
        pruneExpiredIdempotency(snapshot, recordedAt);
        const inputDigest = memoryContentDigest(normalized);
        const prior = snapshot.idempotency.find(
          (binding) => binding.idempotencyKey === normalized.idempotencyKey,
        );
        if (prior) {
          if (prior.inputDigest !== inputDigest) {
            throw new Error("retrieval telemetry idempotency key is bound to different input");
          }
          const record = snapshot.records.find(
            (candidate) => candidate.memoryRef === normalized.memoryRef,
          );
          if (!record) {
            throw new Error("retrieval telemetry idempotency binding has no aggregate record");
          }
          return { record, idempotent: true };
        }

        const current =
          snapshot.records.find((candidate) => candidate.memoryRef === normalized.memoryRef) ??
          emptyTelemetryRecord(normalized.memoryRef);
        const updated = applyOutcome(current, normalized);
        const index = snapshot.records.findIndex(
          (candidate) => candidate.memoryRef === normalized.memoryRef,
        );
        if (index < 0) snapshot.records.push(updated);
        else snapshot.records[index] = updated;
        const replayHorizonMs = positiveInteger(
          this.options.replayHorizonMs ?? RETRIEVAL_TELEMETRY_REPLAY_HORIZON_MS,
          "replayHorizonMs",
        );
        snapshot.idempotency.push({
          idempotencyKey: normalized.idempotencyKey,
          memoryRef: normalized.memoryRef,
          inputDigest,
          recordedAt,
          retainedUntil: new Date(Date.parse(recordedAt) + replayHorizonMs).toISOString(),
        });
        enforceBounds(snapshot, this.options);
        await this.save(snapshot);
        return { record: updated, idempotent: false };
      }),
    );
  }

  async list(): Promise<RetrievalTelemetryRecord[]> {
    await this.mutationTail;
    return (await this.load()).records.toSorted((left, right) =>
      left.memoryRef.localeCompare(right.memoryRef),
    );
  }

  async reset(): Promise<{ removedRecords: number; removedIdempotencyKeys: number }> {
    return this.enqueueMutation(async () =>
      withFileMutationLock(this.lockPath, async () => {
        const snapshot = await this.load();
        const result = {
          removedRecords: snapshot.records.length,
          removedIdempotencyKeys: snapshot.idempotency.length,
        };
        await this.save(emptySnapshot());
        return result;
      }),
    );
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<RetrievalTelemetrySnapshot> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return parseSnapshot(parsed, this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySnapshot();
      throw error;
    }
  }

  private async save(snapshot: RetrievalTelemetrySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, snapshot);
  }
}

export function defaultRetrievalTelemetryStore(cwd: string): RetrievalTelemetryStore {
  return new RetrievalTelemetryStore(join(cwd, ".spark", "memory", "retrieval-telemetry.json"));
}

function emptySnapshot(): RetrievalTelemetrySnapshot {
  return { schema: RETRIEVAL_TELEMETRY_SCHEMA, records: [], idempotency: [] };
}

function emptyTelemetryRecord(memoryRef: string): RetrievalTelemetryRecord {
  return {
    memoryRef,
    retrievalCount: 0,
    lastRetrievedAt: null,
    successfulUseCount: 0,
    negativeFeedbackCount: 0,
    lastOutcomeAt: null,
    idempotencyKey: null,
  };
}

function normalizeRecordInput(
  input: {
    memoryRef: string;
    outcome: RetrievalTelemetryOutcome;
    idempotencyKey: string;
    at?: string;
  },
  defaultNow?: string,
) {
  const memoryRef = normalizeRef(input.memoryRef, "memoryRef");
  if (!/^(?:memory|recall|learning[-:])/u.test(memoryRef)) {
    throw new Error("retrieval telemetry memoryRef must identify Memory content");
  }
  if (
    !(["retrieval", "successful_use", "negative_feedback", "task_success"] as const).includes(
      input.outcome,
    )
  ) {
    throw new Error("retrieval telemetry outcome is invalid");
  }
  const idempotencyKey = normalizeRef(input.idempotencyKey, "idempotencyKey");
  const at = normalizeTimestamp(input.at ?? defaultNow ?? new Date().toISOString(), "at");
  return { memoryRef, outcome: input.outcome, idempotencyKey, at };
}

function applyOutcome(
  current: RetrievalTelemetryRecord,
  input: ReturnType<typeof normalizeRecordInput>,
): RetrievalTelemetryRecord {
  const latestOutcome = !current.lastOutcomeAt || input.at >= current.lastOutcomeAt;
  const latestRetrieval =
    input.outcome === "retrieval" &&
    (!current.lastRetrievedAt || input.at >= current.lastRetrievedAt);
  return {
    ...current,
    retrievalCount: current.retrievalCount + (input.outcome === "retrieval" ? 1 : 0),
    lastRetrievedAt: latestRetrieval ? input.at : current.lastRetrievedAt,
    successfulUseCount:
      current.successfulUseCount +
      (input.outcome === "successful_use" || input.outcome === "task_success" ? 1 : 0),
    negativeFeedbackCount:
      current.negativeFeedbackCount + (input.outcome === "negative_feedback" ? 1 : 0),
    lastOutcomeAt: latestOutcome ? input.at : current.lastOutcomeAt,
    idempotencyKey: latestOutcome ? input.idempotencyKey : current.idempotencyKey,
  };
}

function enforceBounds(
  snapshot: RetrievalTelemetrySnapshot,
  options: RetrievalTelemetryStoreOptions,
): void {
  const maxRecords = positiveInteger(options.maxRecords ?? 10_000, "maxRecords");
  const maxIdempotencyKeys = positiveInteger(
    options.maxIdempotencyKeys ?? 50_000,
    "maxIdempotencyKeys",
  );
  if (snapshot.records.length > maxRecords) {
    const protectedRefs = new Set(snapshot.idempotency.map((binding) => binding.memoryRef));
    const removable = snapshot.records
      .filter((record) => !protectedRefs.has(record.memoryRef))
      .toSorted((left, right) =>
        (left.lastOutcomeAt ?? "").localeCompare(right.lastOutcomeAt ?? ""),
      );
    const removeCount = snapshot.records.length - maxRecords;
    if (removable.length < removeCount) {
      throw new Error("retrieval telemetry capacity is exhausted inside the replay horizon");
    }
    const removedRefs = new Set(removable.slice(0, removeCount).map((record) => record.memoryRef));
    snapshot.records = snapshot.records.filter((record) => !removedRefs.has(record.memoryRef));
  }
  if (snapshot.idempotency.length > maxIdempotencyKeys) {
    throw new Error(
      "retrieval telemetry idempotency capacity is exhausted inside the replay horizon",
    );
  }
}

function pruneExpiredIdempotency(snapshot: RetrievalTelemetrySnapshot, now: string): void {
  const nowMs = Date.parse(now);
  snapshot.idempotency = snapshot.idempotency.filter(
    (binding) => Date.parse(binding.retainedUntil) > nowMs,
  );
}

function parseSnapshot(value: unknown, filePath: string): RetrievalTelemetrySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid retrieval telemetry store ${filePath}: root must be an object`);
  }
  const snapshot = value as Partial<RetrievalTelemetrySnapshot>;
  if (
    snapshot.schema !== RETRIEVAL_TELEMETRY_SCHEMA ||
    !Array.isArray(snapshot.records) ||
    !Array.isArray(snapshot.idempotency)
  ) {
    throw new Error(`invalid retrieval telemetry store ${filePath}: schema mismatch`);
  }
  for (const record of snapshot.records) validateTelemetryRecord(record, filePath);
  for (const binding of snapshot.idempotency) {
    normalizeRef(binding.idempotencyKey, "idempotencyKey");
    normalizeRef(binding.memoryRef, "memoryRef");
    normalizeTimestamp(binding.recordedAt, "recordedAt");
    normalizeTimestamp(binding.retainedUntil, "retainedUntil");
    if (Date.parse(binding.retainedUntil) <= Date.parse(binding.recordedAt)) {
      throw new Error(`invalid retrieval telemetry store ${filePath}: replay horizon is invalid`);
    }
    if (!/^[\da-f]{64}$/u.test(binding.inputDigest)) {
      throw new Error(`invalid retrieval telemetry store ${filePath}: inputDigest is invalid`);
    }
  }
  return snapshot as RetrievalTelemetrySnapshot;
}

function validateTelemetryRecord(record: RetrievalTelemetryRecord, filePath: string): void {
  normalizeRef(record.memoryRef, "memoryRef");
  for (const field of ["retrievalCount", "successfulUseCount", "negativeFeedbackCount"] as const) {
    if (!Number.isInteger(record[field]) || record[field] < 0) {
      throw new Error(`invalid retrieval telemetry store ${filePath}: ${field} is invalid`);
    }
  }
  for (const value of [record.lastRetrievedAt, record.lastOutcomeAt]) {
    if (value !== null) normalizeTimestamp(value, "telemetry timestamp");
  }
  if (record.idempotencyKey !== null) normalizeRef(record.idempotencyKey, "idempotencyKey");
}

function normalizeRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /\s/u.test(value)) {
    throw new Error(`retrieval telemetry ${label} must be a non-empty ref`);
  }
  return value.trim();
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`retrieval telemetry ${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`retrieval telemetry ${label} must be a positive integer`);
  }
  return value;
}
