import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  createMemoryLifecycle,
  defaultRecallStore,
  defaultSparkMemoryStore,
  type RecallCandidate,
} from "./index.ts";
import {
  extractSparkCompactionCandidates,
  runSparkCompactionCandidatePipeline,
} from "./compaction-candidates.ts";
import sparkMemoryExtension from "./extension.ts";
import type {
  SparkCompactionCandidatePipelineOptions,
  SparkCompactionCandidatePipelineResult,
} from "./compaction-candidates.ts";
import type { ToolConfig } from "@zendev-lab/spark-core";

const structuredSummary = {
  mode: "smart",
  model: "provider/compact-model",
  structured: {
    version: 1,
    objective: "Complete Compact V2",
    completed: [],
    preservedFacts: [
      "Package manager is pnpm.",
      "Validated durable delivery (evidence:delivery-proof).",
    ],
    decisions: ["Keep git as the original binary."],
    changedFiles: [
      {
        path: "packages/spark-memory/src/extension.ts",
        change: "wired post-compact candidates",
        evidenceRefs: ["evidence:changed-file-proof"],
      },
    ],
    commands: [],
    unresolved: ["Run the final full gate."],
    inProgress: ["Document Compact V2."],
    failures: [
      {
        summary: "Daemon socket unavailable",
        cause: "process stopped",
        nextStep: "restart after build",
        evidenceRefs: ["evidence:daemon-proof"],
      },
    ],
    memoryRefs: ["evidence:unrelated-global-ref"],
  },
};

test("Smart compact extraction keeps only evidence-linked durable claims", () => {
  const candidates = extractSparkCompactionCandidates(structuredSummary, {
    sessionId: "session:compact",
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, "stable_fact");
  assert.equal(candidates[0]?.text, "Validated durable delivery (evidence:delivery-proof).");
  assert.deepEqual(candidates[0]?.evidenceRefs, ["evidence:delivery-proof"]);
  assert.equal(candidates[0]?.sourceSessionId, "session:compact");
});

test("post-compact extraction fails closed for malformed or non-Smart details", () => {
  assert.deepEqual(
    extractSparkCompactionCandidates({ structured: { preservedFacts: ["partial"] } }),
    [],
  );
  assert.deepEqual(
    extractSparkCompactionCandidates({ ...structuredSummary, mode: "deterministic" }),
    [],
  );
  const malformedRefDetails = {
    ...structuredSummary,
    structured: {
      ...structuredSummary.structured,
      preservedFacts: ["Malformed evidence evidence:delivery-proof:extra must not be truncated."],
    },
  };
  assert.deepEqual(extractSparkCompactionCandidates(malformedRefDetails), []);
});

test("post-compact pipeline persists candidates without writing durable Memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-compact-candidates-"));
  try {
    const result = await runSparkCompactionCandidatePipeline({
      cwd: dir,
      sessionId: "session:compact",
      summary: "rendered summary",
      details: structuredSummary,
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal((await defaultSparkMemoryStore(dir, "workspace").status()).total, 0);
    const replay = await runSparkCompactionCandidatePipeline({
      cwd: dir,
      sessionId: "session:compact",
      summary: "rendered summary",
      details: structuredSummary,
    });
    assert.equal(replay.candidates.length, 1);
    const stored = await defaultRecallStore(dir, "workspace").list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.kind, "stable_fact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate persistence failures are isolated from remaining candidates", async () => {
  const candidateStore = new InMemoryCandidateStore();
  let recordCount = 0;
  const result = await runSparkCompactionCandidatePipeline({
    cwd: "/unused",
    summary: "rendered summary",
    details: {
      mode: "smart",
      structured: {
        version: 1,
        objective: "Verify failure isolation",
        completed: [],
        preservedFacts: [
          "First evidence-backed fact (evidence:first).",
          "Second evidence-backed fact (evidence:second).",
        ],
        decisions: [],
        changedFiles: [],
        commands: [],
        unresolved: [],
        inProgress: [],
        failures: [],
        memoryRefs: [],
      },
    },
    candidateStore: {
      list: () => candidateStore.list(),
      async record(input) {
        recordCount += 1;
        if (recordCount === 1) throw new Error("candidate store unavailable");
        return candidateStore.record(input);
      },
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0] ?? "", /candidate store unavailable/);
});

test("session_compact schedules candidate work after returning and ignores failed or non-full events", async () => {
  const api = new FakeApi();
  let releasePipeline: (() => void) | undefined;
  const pipelineStarted = new Promise<void>((resolve) => {
    api.runPipeline = async () => {
      resolve();
      await new Promise<void>((release) => {
        releasePipeline = release;
      });
      return emptyPipelineResult();
    };
  });
  sparkMemoryExtension(api, {
    runCompactionCandidatePipeline: (options) => api.runPipeline(options),
  });
  const handler = api.handlers.get("session_compact");
  assert.ok(handler);

  const returned = handler(
    {
      compactType: "full",
      succeeded: true,
      sessionId: "session:compact",
      compactionEntry: {
        type: "compaction",
        summary: "Smart summary",
        details: structuredSummary,
      },
    },
    { cwd: "/workspace" },
  );
  assert.equal(returned, undefined);
  await pipelineStarted;
  assert.ok(releasePipeline, "background pipeline should be running after handler returns");
  releasePipeline();

  let calls = 0;
  api.runPipeline = async () => {
    calls += 1;
    return emptyPipelineResult();
  };
  handler({ compactType: "micro", succeeded: true, compactionEntry: {} }, { cwd: "/workspace" });
  handler({ compactType: "full", succeeded: false, compactionEntry: {} }, { cwd: "/workspace" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
});

test("session_compact reports candidate failures as hidden non-triggering diagnostics", async () => {
  const api = new FakeApi();
  api.runPipeline = async () => ({
    ...emptyPipelineResult(),
    failures: ["memory unavailable"],
  });
  sparkMemoryExtension(api, {
    runCompactionCandidatePipeline: (options) => api.runPipeline(options),
  });
  const handler = api.handlers.get("session_compact");
  assert.ok(handler);

  handler(
    {
      compactType: "full",
      succeeded: true,
      sessionId: "session:compact",
      compactionEntry: {
        type: "compaction",
        summary: "Smart summary",
        details: structuredSummary,
      },
    },
    { cwd: "/workspace" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(api.messages, [
    {
      message: {
        customType: "spark-memory-compaction-candidate-diagnostic",
        content: "Post-compact Memory candidate processing reported 1 failure(s).",
        display: false,
        authority: "runtime_data",
        trust: "untrusted",
        details: { failures: ["memory unavailable"] },
      },
      options: { deliverAs: "nextTurn", triggerTurn: false },
    },
  ]);
});

class InMemoryCandidateStore {
  readonly candidates: Awaited<ReturnType<ReturnType<typeof defaultRecallStore>["list"]>> = [];

  async list() {
    return this.candidates;
  }

  async record(input: Parameters<ReturnType<typeof defaultRecallStore>["record"]>[0]) {
    const now = "2026-07-21T00:00:00.000Z";
    const candidate: RecallCandidate = {
      id: `recall:${this.candidates.length + 1}`,
      scope: input.scope,
      text: input.text,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs ?? [],
      kind: input.kind ?? "explicit",
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      status: "candidate" as const,
      createdAt: now,
      updatedAt: now,
      lifecycle: createMemoryLifecycle({
        recordRef: `recall:${this.candidates.length + 1}`,
        kind: input.kind === "open_item" ? "episodic" : "semantic",
        state: "candidate",
        scope: input.scope,
        evidenceRefs: input.evidenceRefs ?? [],
        sourceKind: input.kind === "explicit" ? "user_intent" : "compaction",
        capturedAt: now,
        legacyUnverified: false,
        approvalStatus: "not_required",
        content: {
          text: input.text,
          reason: input.reason,
          evidenceRefs: input.evidenceRefs ?? [],
          kind: input.kind ?? "explicit",
          sourceSessionId: input.sourceSessionId?.trim() || null,
          status: "candidate",
          promotedTo: null,
          rejectedReason: null,
        },
      }),
    };
    this.candidates.push(candidate);
    return candidate;
  }
}

class FakeApi {
  readonly handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  readonly tools = new Map<string, ToolConfig>();
  readonly messages: Array<{
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
      authority?: "runtime_control" | "runtime_data";
      trust?: "trusted" | "untrusted";
    };
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean };
  }> = [];
  runPipeline: (
    options: SparkCompactionCandidatePipelineOptions,
  ) => Promise<SparkCompactionCandidatePipelineResult> = async () => emptyPipelineResult();

  registerTool(config: ToolConfig): void {
    this.tools.set(config.name, config);
  }

  getAllTools(): Array<{ name: string }> {
    return Array.from(this.tools.keys()).map((name) => ({ name }));
  }

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    this.handlers.set(event, handler);
  }

  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
      authority?: "runtime_control" | "runtime_data";
      trust?: "trusted" | "untrusted";
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void {
    this.messages.push({ message, ...(options ? { options } : {}) });
  }
}

function emptyPipelineResult(): SparkCompactionCandidatePipelineResult {
  return { candidates: [], failures: [] };
}
