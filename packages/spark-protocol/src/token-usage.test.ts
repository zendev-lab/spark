import { describe, expect, it } from "vitest";
import {
  sparkTokenUsageAggregateSchema,
  sparkTokenUsageByPersistenceSchema,
  sparkTokenUsageReceiptSchema,
  sparkUsageExecutionSchema,
} from "./token-usage.ts";

const zeroBreakdown = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

describe("token usage protocol", () => {
  it("keeps execution identity repro-scoped with the frozen public vocabulary", () => {
    expect(
      sparkUsageExecutionSchema.parse({
        executionId: "run:child",
        parentExecutionId: "inv_root",
        scope: { kind: "repro", reproId: "repro-123" },
        kind: "role_run",
        persistence: "anonymous",
        status: "running",
        runRef: "run:child",
      }),
    ).toMatchObject({
      scope: { kind: "repro", reproId: "repro-123" },
      kind: "role_run",
      persistence: "anonymous",
      status: "running",
    });
    expect(
      sparkUsageExecutionSchema.safeParse({
        executionId: "run:child",
        scope: { kind: "repro", reproId: "repro-123" },
        kind: "role_run",
        persistence: "temporary",
        status: "active",
      }).success,
    ).toBe(false);
  });

  it("retains provider audit totals without double-counting reasoning", () => {
    const receipt = sparkTokenUsageReceiptSchema.parse({
      eventId: "usage_123",
      executionId: "inv_root",
      responseOrdinal: 1,
      measurement: "reported",
      provider: "openai",
      model: "gpt-test",
      providerResponseId: "response-123",
      providerTotalTokens: 35,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 8,
        totalTokens: 35,
      },
      costUsd: 0.25,
      observedAt: "2026-08-03T00:00:01.000Z",
    });
    expect(receipt.usage?.totalTokens).toBe(35);
    expect(
      sparkTokenUsageReceiptSchema.safeParse({
        ...receipt,
        usage: { ...receipt.usage, totalTokens: 43 },
      }).success,
    ).toBe(false);
    expect(
      sparkTokenUsageReceiptSchema.safeParse({
        ...receipt,
        usage: { ...receipt.usage, reasoningTokens: 21 },
      }).success,
    ).toBe(false);
  });

  it("keeps missing receipts explicit instead of fabricating zero reported usage", () => {
    const missing = {
      eventId: "usage_missing",
      executionId: "inv_root",
      responseOrdinal: 2,
      measurement: "missing",
      observedAt: "2026-08-03T00:00:02.000Z",
    } as const;
    expect(sparkTokenUsageReceiptSchema.parse(missing).usage).toBeUndefined();
    expect(
      sparkTokenUsageReceiptSchema.safeParse({ ...missing, usage: zeroBreakdown }).success,
    ).toBe(false);
  });

  it("projects direct reported/estimated and record-keyed breakdowns", () => {
    expect(
      sparkTokenUsageAggregateSchema.parse({
        scope: { kind: "repro", reproId: "repro-123" },
        quality: "partial",
        totalTokens: 0,
        activeExecutionCount: 1,
        responseCount: 0,
        missingResponseCount: 0,
        reported: zeroBreakdown,
        estimated: zeroBreakdown,
        byExecutionKind: { root_session: zeroBreakdown },
        byModel: {},
        asOf: "2026-08-03T00:00:03.000Z",
      }),
    ).toMatchObject({
      quality: "partial",
      activeExecutionCount: 1,
      reported: { totalTokens: 0 },
      byExecutionKind: { root_session: { totalTokens: 0 } },
    });
  });

  it("keeps the persistence diagnostic bounded and outside the canonical aggregate", () => {
    const projection = sparkTokenUsageByPersistenceSchema.parse({
      scope: { kind: "repro", reproId: "repro-123" },
      byPersistence: {
        anonymous: {
          quality: "exact",
          totalTokens: 3,
          activeExecutionCount: 0,
          responseCount: 1,
          missingResponseCount: 0,
          reported: { ...zeroBreakdown, inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          estimated: zeroBreakdown,
        },
        persistent: {
          quality: "unknown",
          totalTokens: 0,
          activeExecutionCount: 0,
          responseCount: 0,
          missingResponseCount: 0,
          reported: zeroBreakdown,
          estimated: zeroBreakdown,
        },
      },
      asOf: "2026-08-03T00:00:03.000Z",
    });
    expect(projection.byPersistence.anonymous.totalTokens).toBe(3);
    expect(JSON.stringify(projection)).not.toContain("eventId");
    const canonical = sparkTokenUsageAggregateSchema.parse({
      scope: projection.scope,
      quality: "unknown",
      totalTokens: 0,
      activeExecutionCount: 0,
      responseCount: 0,
      missingResponseCount: 0,
      reported: zeroBreakdown,
      estimated: zeroBreakdown,
      byExecutionKind: {},
      byModel: {},
      byPersistence: projection.byPersistence,
      asOf: projection.asOf,
    });
    expect(canonical).not.toHaveProperty("byPersistence");
  });

  it("makes partial, exact, estimated, and unknown quality mutually exclusive", () => {
    const base = {
      scope: { kind: "repro" as const, reproId: "repro-quality" },
      totalTokens: 0,
      activeExecutionCount: 0,
      responseCount: 0,
      estimatedResponseCount: 0,
      missingResponseCount: 0,
      coverageGapCount: 0,
      reported: zeroBreakdown,
      estimated: zeroBreakdown,
      byExecutionKind: {},
      byModel: {},
      asOf: "2026-08-03T00:00:03.000Z",
    };
    expect(sparkTokenUsageAggregateSchema.parse({ ...base, quality: "unknown" }).quality).toBe(
      "unknown",
    );
    expect(sparkTokenUsageAggregateSchema.safeParse({ ...base, quality: "exact" }).success).toBe(
      false,
    );
    expect(
      sparkTokenUsageAggregateSchema.parse({
        ...base,
        quality: "partial",
        coverageGapCount: 1,
      }).quality,
    ).toBe("partial");
    expect(
      sparkTokenUsageAggregateSchema.parse({
        ...base,
        quality: "estimated",
        responseCount: 1,
        estimatedResponseCount: 1,
      }).quality,
    ).toBe("estimated");
    expect(
      sparkTokenUsageAggregateSchema.parse({
        ...base,
        quality: "exact",
        responseCount: 1,
      }).quality,
    ).toBe("exact");
    expect(
      sparkTokenUsageAggregateSchema.safeParse({
        ...base,
        quality: "exact",
        responseCount: 1,
        missingResponseCount: 1,
      }).success,
    ).toBe(false);
  });
});
