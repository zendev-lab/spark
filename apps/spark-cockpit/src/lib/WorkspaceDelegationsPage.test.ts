import { getCockpitDictionary } from "@zendev-lab/spark-i18n/cockpit";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import WorkspaceDelegationsPage from "./WorkspaceDelegationsPage.svelte";

const messages = getCockpitDictionary("en").delegations;
const workspaces = [
  { id: "ws_source", slug: "source", name: "Source Workspace" },
  { id: "ws_target", slug: "target", name: "Target Workspace" },
];
const statuses = [
  "queued",
  "retry_wait",
  "delivering",
  "running",
  "awaiting_source",
  "cancelling",
  "completed",
  "rejected",
  "failed",
  "cancelled",
] as const;

function delegation(status: (typeof statuses)[number], index: number) {
  return {
    request: {
      delegationId: `dlg_${String(index).padStart(32, "0")}`,
      sourceWorkspaceId: "ws_source",
      targetWorkspaceId: "ws_target",
      goal: `Goal ${status}`,
      constraints: [],
      actor: { kind: "hub_owner", id: "usr_owner" },
      lineage: [],
      hopCount: 1,
      idempotencyKey: `idem_${String(index).padStart(32, "0")}`,
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    status,
    version: 1,
    nextMessageSequence: 2,
    targetSessionId: "sess_target_main",
    ...(status === "completed"
      ? {
          receipt: {
            outcome: "completed",
            summary: "Compatibility verified.",
            artifactRefs: ["artifact:compatibility-report"],
            verification: [{ label: "unit tests", status: "passed", summary: "42 passed" }],
          },
        }
      : {}),
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:01.000Z",
  };
}

function page(
  authorizedWorkspaceId: string | null,
  delegations = statuses.map(delegation),
  audits: Record<string, unknown[]> = {},
) {
  return render(WorkspaceDelegationsPage, {
    props: { authorizedWorkspaceId, audits, delegations, workspaces, messages } as never,
  });
}

describe("WorkspaceDelegationsPage", () => {
  it("renders every reachable delegation state and bounded receipt fields", () => {
    const { body } = page(null);

    for (const status of statuses) {
      expect(body).toContain(`data-status="${status}"`);
      expect(body).toContain(`Goal ${status}`);
    }
    expect(body).toContain("Compatibility verified.");
    expect(body).toContain("artifact:compatibility-report");
    expect(body).toContain("unit tests");
    expect(body).toContain("42 passed");
    expect(body).not.toContain("evidence:");
  });

  it("shows the main-session entry only to the target workspace member or Hub Owner", () => {
    const target = page("ws_target").body;
    const source = page("ws_source").body;
    const owner = page(null).body;

    expect(target).toContain('href="/target/sessions/sess_target_main"');
    expect(owner).toContain('href="/target/sessions/sess_target_main"');
    expect(source).not.toContain("/target/sessions/sess_target_main");
  });

  it("renders the empty inbox state", () => {
    expect(page("ws_source", []).body).toContain(messages.empty);
  });

  it("renders owner delivery audit entries without exposing them to members", () => {
    const completed = delegation("completed", 6);
    const audit = {
      [completed.request.delegationId]: [
        {
          sequence: 1,
          kind: "request",
          deliveryStatus: "succeeded",
          fromWorkspaceId: "ws_source",
          toWorkspaceId: "ws_target",
          runtimeControlCommandId: "cmd_delivery",
        },
      ],
    };

    expect(page(null, [completed], audit).body).toContain("cmd_delivery");
    expect(page("ws_source", [completed]).body).not.toContain(messages.audit);
  });
});
