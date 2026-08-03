import { describe, expect, it } from "vitest";
import { createId } from "./refs.ts";
import {
  workspaceDelegationDeliverySchema,
  workspaceDelegationRequestSchema,
} from "./workspace-delegation.ts";

function request(overrides: Record<string, unknown> = {}) {
  return {
    delegationId: createId("dlg"),
    sourceWorkspaceId: createId("ws"),
    targetWorkspaceId: createId("ws"),
    goal: "Verify compatibility and return a bounded receipt",
    constraints: [],
    actor: { kind: "hub_owner", id: createId("usr") },
    lineage: [],
    hopCount: 1,
    idempotencyKey: createId("idem"),
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("workspace delegation protocol", () => {
  it("accepts a first-hop request and rejects self delegation", () => {
    expect(workspaceDelegationRequestSchema.parse(request()).hopCount).toBe(1);
    const workspaceId = createId("ws");
    expect(() =>
      workspaceDelegationRequestSchema.parse(
        request({ sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId }),
      ),
    ).toThrow(/cannot delegate to itself/u);
  });

  it("rejects loops and more than four hops", () => {
    const source = createId("ws");
    const target = createId("ws");
    expect(() =>
      workspaceDelegationRequestSchema.parse(
        request({
          sourceWorkspaceId: source,
          targetWorkspaceId: target,
          lineage: [createId("ws"), target],
          hopCount: 3,
        }),
      ),
    ).toThrow(/include the target/u);
    expect(() =>
      workspaceDelegationRequestSchema.parse(
        request({
          sourceWorkspaceId: source,
          targetWorkspaceId: target,
          lineage: [createId("ws"), createId("ws"), createId("ws"), createId("ws")],
          hopCount: 5,
        }),
      ),
    ).toThrow();
  });

  it("keeps internal evidence out of bounded receipts", () => {
    const parsed = workspaceDelegationDeliverySchema.parse({
      delegationId: createId("dlg"),
      messageSequence: 2,
      kind: "receipt",
      sourceWorkspaceId: createId("ws"),
      targetWorkspaceId: createId("ws"),
      receipt: {
        outcome: "completed",
        summary: "Compatibility verified.",
        artifactRefs: ["artifact:report"],
        verification: [{ label: "unit tests", status: "passed", summary: "42 passed" }],
      },
    });
    expect(parsed.receipt?.artifactRefs).toEqual(["artifact:report"]);
    expect(parsed.receipt).not.toHaveProperty("evidenceRefs");
  });

  it("rejects forged delivery routes and incomplete structured messages", () => {
    const snapshot = request();
    expect(() =>
      workspaceDelegationDeliverySchema.parse({
        delegationId: snapshot.delegationId,
        messageSequence: 1,
        kind: "request",
        sourceWorkspaceId: snapshot.targetWorkspaceId,
        targetWorkspaceId: snapshot.sourceWorkspaceId,
        request: snapshot,
      }),
    ).toThrow(/must match the delegation request snapshot/u);
    expect(() =>
      workspaceDelegationDeliverySchema.parse({
        delegationId: snapshot.delegationId,
        messageSequence: 2,
        kind: "question",
        sourceWorkspaceId: snapshot.sourceWorkspaceId,
        targetWorkspaceId: snapshot.targetWorkspaceId,
      }),
    ).toThrow(/requires text/u);
  });
});
