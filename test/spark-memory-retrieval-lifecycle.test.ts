import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, vi } from "vitest";

import type { ToolConfig } from "@zendev-lab/spark-core";
import { createSparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-host/memory-direct-intent";
import { SparkMemoryStore } from "@zendev-lab/spark-memory";
import sparkMemoryExtension from "@zendev-lab/spark-memory/extension";
import { createRecallCandidateGcPlan } from "@zendev-lab/spark-memory/candidate-lifecycle";
import { createLegacyMemoryFixturePermit } from "@zendev-lab/spark-memory/legacy-fixture";
import { RetrievalTelemetryStore } from "@zendev-lab/spark-memory/retrieval-telemetry";
import {
  RECALL_SESSION_CANDIDATE_TTL_MS,
  RecallStore,
  type RecallCandidate,
} from "@zendev-lab/spark-memory/recall";

const START = "2026-08-03T00:00:00.000Z";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

test("replay fences fail closed at capacity and prune only after the configured horizon", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-retrieval-replay-horizon-"));
  let now = START;
  try {
    const store = new RetrievalTelemetryStore(join(root, "telemetry.json"), {
      now: () => now,
      maxIdempotencyKeys: 1,
      replayHorizonMs: 1_000,
    });
    const first = {
      memoryRef: "memory:horizon",
      outcome: "retrieval" as const,
      idempotencyKey: "horizon:first",
      at: START,
    };
    await store.record(first);
    await assert.rejects(
      store.record({ ...first, idempotencyKey: "horizon:second" }),
      /capacity is exhausted inside the replay horizon/u,
    );
    assert.equal((await store.list())[0]?.retrievalCount, 1);
    assert.equal((await store.record(first)).idempotent, true);

    now = new Date(Date.parse(START) + 1_001).toISOString();
    await store.record({ ...first, idempotencyKey: "horizon:second", at: now });
    assert.equal((await store.list())[0]?.retrievalCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feedback tool accepts only host-verified current-turn receipts and exposes no writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-retrieval-feedback-tool-"));
  try {
    let tool: ToolConfig | undefined;
    const record = vi.fn(async () => ({
      record: {
        memoryRef: "memory:ranked",
        retrievalCount: 0,
        lastRetrievedAt: null,
        successfulUseCount: 1,
        negativeFeedbackCount: 0,
        lastOutcomeAt: START,
        idempotencyKey: "feedback:test",
      },
      idempotent: false,
    }));
    sparkMemoryExtension(
      {
        getAllTools: () => [],
        registerTool(config) {
          if (config.name === "memory") tool = config;
        },
      },
      {
        createRetrievalTelemetryStore: () => ({
          record,
          list: async () => [],
          reset: async () => ({ removedRecords: 0, removedIdempotencyKeys: 0 }),
        }),
      },
    );
    assert.ok(tool);
    const issue = async () => {
      const authority = createSparkMemoryDirectIntentTurnAuthority();
      const receipt = await authority.issueFeedback({
        surface: "tui",
        workspaceId: root,
        sessionId: "session:feedback",
        turnId: "turn:feedback",
        messageId: "message:feedback",
        prompt: "memory feedback positive memory:ranked",
      });
      return { authority, receipt: receipt! };
    };
    const execute = async (
      receipt: unknown,
      authority?: ReturnType<typeof createSparkMemoryDirectIntentTurnAuthority>,
    ) =>
      await tool!.execute(
        "call-feedback",
        { action: "feedback", ref: "memory:ranked", outcome: "positive" },
        new AbortController().signal,
        () => {},
        {
          cwd: root,
          memoryFeedback: receipt,
          ...(authority
            ? {
                verifyMemoryFeedback: (value: unknown) => authority.verifyCurrentFeedback(value),
                commitMemoryFeedback: (value: unknown) => authority.commitCurrentFeedback(value),
                releaseMemoryFeedback: (value: unknown) => authority.releaseCurrentFeedback(value),
              }
            : {}),
        },
      );

    const trusted = await issue();
    const accepted = await execute(trusted.receipt, trusted.authority);
    assert.equal(accepted.details?.trusted, true);
    assert.equal(record.mock.calls.length, 1);

    const recoverable = await issue();
    record.mockRejectedValueOnce(new Error("telemetry temporarily unavailable"));
    await assert.rejects(
      execute(recoverable.receipt, recoverable.authority),
      /temporarily unavailable/u,
    );
    const retried = await execute(recoverable.receipt, recoverable.authority);
    assert.equal(retried.details?.trusted, true);
    assert.equal(record.mock.calls.length, 3);

    const concurrent = await issue();
    const raced = await Promise.all([
      execute(concurrent.receipt, concurrent.authority),
      execute(concurrent.receipt, concurrent.authority),
    ]);
    assert.equal(raced.filter((response) => response.details?.trusted === true).length, 1);
    assert.equal(
      raced.filter((response) => response.details?.code === "MEMORY_FEEDBACK_REPLAYED").length,
      1,
    );
    assert.equal(record.mock.calls.length, 4);
    record.mockClear();

    const invalidCases: Array<{
      code: string;
      authority?: ReturnType<typeof createSparkMemoryDirectIntentTurnAuthority>;
      receipt?: unknown;
      verify?: undefined;
      mutate?: Record<string, string>;
      replay?: boolean;
    }> = [
      {
        code: "MEMORY_FEEDBACK_AMBIGUOUS",
        receipt: undefined,
        verify: undefined,
      },
      {
        code: "MEMORY_FEEDBACK_STALE_MESSAGE",
        ...(await issue()),
        mutate: { messageId: "message:stale" },
      },
      {
        code: "MEMORY_FEEDBACK_CROSS_TURN",
        ...(await issue()),
        mutate: { turnId: "turn:other" },
      },
      {
        code: "MEMORY_FEEDBACK_PROPOSAL_DRIFT",
        ...(await issue()),
        mutate: { memoryRef: "memory:drift" },
      },
      {
        code: "MEMORY_FEEDBACK_REPLAYED",
        ...(await issue()),
        replay: true,
      },
    ];
    for (const vector of invalidCases) {
      const authority = "authority" in vector ? vector.authority : undefined;
      const baseReceipt = "receipt" in vector ? vector.receipt : undefined;
      if (vector.replay && authority) await authority.verifyCurrentFeedback(baseReceipt);
      const candidate = vector.mutate
        ? { ...(baseReceipt as object), ...vector.mutate }
        : baseReceipt;
      const response = await execute(candidate, authority);
      assert.equal(response.details?.code, vector.code);
      assert.equal(response.details?.trusted, false);
    }
    assert.equal(record.mock.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixed query corpus reports capped ranking deltas without lifecycle interference", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-retrieval-ranking-"));
  try {
    const memoryPath = join(root, ".spark", "memory", "memory.json");
    const telemetry = new RetrievalTelemetryStore(
      join(root, ".spark", "memory", "retrieval-telemetry.json"),
    );
    const memory = new SparkMemoryStore(memoryPath, {
      legacyFixturePermit: createLegacyMemoryFixturePermit(),
      retrievalTelemetryStore: telemetry,
      now: () => START,
      successfulUseBonusCap: 0.6,
    });
    const corpus = [] as Array<{ query: string; expected: string; distractor: string }>;
    for (const stem of ["alpha", "beta"]) {
      const expected = await memory.remember({
        scope: "workspace",
        category: "insight",
        text: `${stem} delivery canonical`,
        reason: "Fixed corpus expected result.",
        evidenceRefs: [],
        tags: [],
      });
      const distractor = await memory.remember({
        scope: "workspace",
        category: "insight",
        text: `${stem} delivery distractor`,
        reason: "Fixed corpus distractor.",
        evidenceRefs: [],
        tags: ["pinned"],
      });
      corpus.push({ query: `${stem} delivery`, expected: expected.id, distractor: distractor.id });
    }
    const durableBefore = await readFile(memoryPath);
    const lifecycleBefore = new Map(
      (await memory.list({ includeForgotten: true, includeSuperseded: true })).map((entry) => [
        entry.id,
        structuredClone(entry.lifecycle),
      ]),
    );
    const baseline = await Promise.all(corpus.map(({ query }) => memory.search(query)));
    for (const { expected, distractor } of corpus) {
      for (let index = 0; index < 20; index += 1) {
        await telemetry.record({
          memoryRef: expected,
          outcome: "successful_use",
          idempotencyKey: `rank:${expected}:success:${index}`,
        });
        await telemetry.record({
          memoryRef: distractor,
          outcome: "negative_feedback",
          idempotencyKey: `rank:${distractor}:negative:${index}`,
        });
      }
    }
    const ranked = await Promise.all(corpus.map(({ query }) => memory.search(query)));
    const beforeHits = baseline.filter(
      (results, index) => results[0]?.entry.id === corpus[index]?.expected,
    ).length;
    const afterHits = ranked.filter(
      (results, index) => results[0]?.entry.id === corpus[index]?.expected,
    ).length;
    assert.equal(beforeHits, 0);
    assert.equal(afterHits, corpus.length);
    for (const results of ranked) {
      assert.equal(
        results.every((result) => result.scoreBreakdown.successfulUseBonus <= 0.6),
        true,
      );
      assert.equal(
        results.every((result) => result.score === result.scoreBreakdown.lexical),
        true,
      );
    }
    const lifecycleAfter = new Map(
      (await memory.list({ includeForgotten: true, includeSuperseded: true })).map((entry) => [
        entry.id,
        entry.lifecycle,
      ]),
    );
    assert.deepEqual(lifecycleAfter, lifecycleBefore);
    assert.equal(sha256(await readFile(memoryPath)), sha256(durableBefore));
    const benchmark = {
      corpusSize: corpus.length,
      hitRateBefore: beforeHits / corpus.length,
      hitRateAfter: afterHits / corpus.length,
      rankingDelta: afterHits - beforeHits,
      results: ranked.map((results, index) => ({
        query: corpus[index]!.query,
        top: results.slice(0, 2).map((result) => ({
          memoryRef: result.entry.id,
          scoreBreakdown: result.scoreBreakdown,
        })),
      })),
    };
    assert.ok(JSON.stringify(benchmark).length < 10_000);
    console.log(`SPARK_MEMORY_RETRIEVAL_BENCHMARK ${JSON.stringify(benchmark)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated telemetry serializes 100 updates, deduplicates retries, and resets without durable writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-retrieval-telemetry-"));
  try {
    const durablePath = join(root, ".spark", "memory", "memory.json");
    const durableBytes = Buffer.from('{"version":2,"entries":[]}\n');
    await mkdir(join(root, ".spark", "memory"), { recursive: true });
    await writeFile(durablePath, durableBytes);
    const store = new RetrievalTelemetryStore(
      join(root, ".spark", "memory", "retrieval-telemetry.json"),
      { now: () => START },
    );
    const updates = Array.from({ length: 100 }, (_, index) => ({
      memoryRef: "memory:ranked",
      outcome:
        index < 60
          ? ("retrieval" as const)
          : index < 85
            ? ("successful_use" as const)
            : ("negative_feedback" as const),
      idempotencyKey: `telemetry:${index}`,
      at: new Date(Date.parse(START) + index).toISOString(),
    }));
    const results = await Promise.all(updates.map((update) => store.record(update)));
    assert.equal(results.filter((result) => result.idempotent).length, 0);
    const [record] = await store.list();
    assert.equal(record?.retrievalCount, 60);
    assert.equal(record?.successfulUseCount, 25);
    assert.equal(record?.negativeFeedbackCount, 15);
    assert.equal(record?.idempotencyKey, "telemetry:99");
    await store.record({
      memoryRef: "memory:ranked",
      outcome: "task_success",
      idempotencyKey: "telemetry:task-success",
      at: new Date(Date.parse(START) + 100).toISOString(),
    });

    const retries = await Promise.all(updates.map((update) => store.record(update)));
    assert.equal(
      retries.every((result) => result.idempotent),
      true,
    );
    assert.deepEqual(await store.list(), [
      {
        ...record,
        successfulUseCount: 26,
        lastOutcomeAt: new Date(Date.parse(START) + 100).toISOString(),
        idempotencyKey: "telemetry:task-success",
      },
    ]);
    await assert.rejects(
      store.record({ ...updates[0]!, outcome: "successful_use" }),
      /different input/u,
    );
    assert.equal(sha256(await readFile(durablePath)), sha256(durableBytes));

    assert.deepEqual(await store.reset(), {
      removedRecords: 1,
      removedIdempotencyKeys: 101,
    });
    assert.deepEqual(await store.list(), []);
    assert.equal(sha256(await readFile(durablePath)), sha256(durableBytes));
    assert.equal("remember" in store, false);
    assert.equal("forget" in store, false);
    assert.equal("supersede" in store, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session-scoped candidate expiry is visibility-only at the exact fake-clock boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-candidate-ttl-"));
  let now = START;
  try {
    const filePath = join(root, ".spark", "memory", "recall-candidates.json");
    const store = new RecallStore(filePath, {
      legacyFixturePermit: createLegacyMemoryFixturePermit(),
      now: () => now,
    });
    const explicit = await store.record({
      scope: "workspace",
      text: "Explicit candidate remains visible.",
      reason: "Explicit user candidate.",
      kind: "explicit",
    });
    const compacted = await store.record({
      scope: "workspace",
      text: "Compaction candidate expires.",
      reason: "Session-scoped compaction candidate.",
      kind: "stable_fact",
      sourceSessionId: "session:ttl",
    });
    assert.equal(explicit.expiresAt, undefined);
    assert.equal(
      compacted.expiresAt,
      new Date(Date.parse(START) + RECALL_SESSION_CANDIDATE_TTL_MS).toISOString(),
    );
    const durableMemoryPath = join(root, ".spark", "memory", "memory.json");
    const durableMemory = new SparkMemoryStore(durableMemoryPath, {
      legacyFixturePermit: createLegacyMemoryFixturePermit(),
      now: () => START,
    });
    const promoted = await durableMemory.remember({
      scope: "workspace",
      category: "insight",
      text: "Promoted candidate target remains immutable under retrieval signals.",
      reason: "TTL non-interference fixture.",
      evidenceRefs: [],
      tags: ["promoted-candidate"],
    });
    const promotedBytesBefore = await readFile(durableMemoryPath);
    const promotedLifecycleBefore = structuredClone(promoted.lifecycle);
    const durableBefore = await readFile(filePath);
    const lifecycleBefore = structuredClone(compacted.lifecycle);
    const telemetry = new RetrievalTelemetryStore(
      join(root, ".spark", "memory", "retrieval-telemetry.json"),
    );
    for (const [outcome, idempotencyKey] of [
      ["retrieval", "ttl:retrieval"],
      ["successful_use", "ttl:positive"],
      ["negative_feedback", "ttl:negative"],
      ["task_success", "ttl:task-success"],
    ] as const) {
      await telemetry.record({ memoryRef: promoted.id, outcome, idempotencyKey, at: START });
    }

    now = new Date(Date.parse(compacted.expiresAt!) - 1).toISOString();
    assert.deepEqual(
      (await store.search("Compaction")).map((candidate) => candidate.id),
      [compacted.id],
    );
    now = compacted.expiresAt!;
    assert.deepEqual(await store.search("Compaction"), []);
    assert.deepEqual(
      (await store.list()).map((candidate) => candidate.id).sort(),
      [compacted.id, explicit.id].sort(),
    );

    const auditCandidate = (await store.list()).find((candidate) => candidate.id === compacted.id)!;
    assert.deepEqual(auditCandidate.lifecycle, lifecycleBefore);
    assert.deepEqual(auditCandidate.lifecycle.revision, lifecycleBefore.revision);
    assert.equal(auditCandidate.lifecycle.expiry.purgeAfter, lifecycleBefore.expiry.purgeAfter);
    assert.equal(auditCandidate.expiresAt, compacted.expiresAt);
    const promotedAfter = (await durableMemory.list()).find((entry) => entry.id === promoted.id)!;
    assert.deepEqual(promotedAfter.lifecycle.revision, promotedLifecycleBefore.revision);
    assert.equal(
      promotedAfter.lifecycle.expiry.purgeAfter,
      promotedLifecycleBefore.expiry.purgeAfter,
    );
    assert.equal(sha256(await readFile(durableMemoryPath)), sha256(promotedBytesBefore));
    assert.equal(sha256(await readFile(filePath)), sha256(durableBefore));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate GC property matrix never includes protected records", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-candidate-gc-"));
  try {
    const filePath = join(root, "recall-candidates.json");
    const store = new RecallStore(filePath, {
      legacyFixturePermit: createLegacyMemoryFixturePermit(),
      now: () => START,
      sessionCandidateTtlMs: 0,
    });
    const template = await store.record({
      scope: "workspace",
      text: "Template candidate.",
      reason: "Property test template.",
      kind: "stable_fact",
      sourceSessionId: "session:property",
    });
    const now = "2026-08-10T00:00:00.000Z";
    const candidates: RecallCandidate[] = [];
    for (const kind of ["explicit", "stable_fact", "open_item"] as const) {
      for (const sourceSessionId of [undefined, "session:property"] as const) {
        for (const ageDays of [0, 7, 30]) {
          for (const useCount of [0, 1, 100]) {
            for (const status of ["candidate", "promoted"] as const) {
              const createdAt = new Date(
                Date.parse(now) - ageDays * 24 * 60 * 60 * 1_000,
              ).toISOString();
              candidates.push({
                ...template,
                id: `recall:${kind}:${sourceSessionId ?? "explicit"}:${ageDays}:${useCount}:${status}`,
                kind,
                status,
                createdAt,
                updatedAt: createdAt,
                ...(sourceSessionId ? { sourceSessionId, expiresAt: createdAt } : {}),
                ...(status === "promoted" ? { promotedTo: `memory:${kind}:${ageDays}` } : {}),
              });
            }
          }
        }
      }
    }
    const protectedRecordRefs = ["preference", "convention", "correction"].flatMap((category) =>
      [0, 7, 30].flatMap((ageDays) =>
        [0, 1, 100].map((useCount) => `memory:${category}:${ageDays}:${useCount}`),
      ),
    );
    const plan = createRecallCandidateGcPlan({
      candidates,
      scope: "workspace",
      olderThanDays: 7,
      now,
      protectedRecordRefs,
    });
    const eligible = new Set(plan.items.map((item) => item.id));
    for (const candidate of candidates) {
      const protectedCandidate =
        candidate.kind === "explicit" ||
        !candidate.sourceSessionId ||
        candidate.status === "promoted";
      if (protectedCandidate) assert.equal(eligible.has(candidate.id), false, candidate.id);
    }
    for (const recordRef of protectedRecordRefs) {
      assert.equal(plan.protectedIds.includes(recordRef), true);
      assert.equal(eligible.has(recordRef), false);
    }
    assert.equal(
      plan.items.every(
        (item) =>
          item.kind !== "explicit" &&
          Boolean(item.expiresAt) &&
          !plan.protectedIds.includes(item.id),
      ),
      true,
    );
    const changedExpiry = createRecallCandidateGcPlan({
      candidates: candidates.map((candidate, index) =>
        index === 0 ? { ...candidate, expiresAt: now } : candidate,
      ),
      scope: "workspace",
      olderThanDays: 7,
      now,
      protectedRecordRefs,
    });
    assert.notEqual(changedExpiry.digest, plan.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
