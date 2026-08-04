import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";

import MemoryProposalDetail from "./MemoryProposalDetail.svelte";

const proposal = {
  proposalId: "memory-proposal:browser",
  operation: "propose_supersede",
  status: "pending",
  diff: {
    before: [
      {
        recordRef: "memory:old",
        revisionRef: "memory:old:revision:3",
        contentDigest: "a".repeat(64),
      },
    ],
    after: { recordRef: "memory:new", contentDigest: "b".repeat(64) },
  },
  lineage: {
    sources: [
      {
        recordRef: "memory:old",
        revisionRef: "memory:old:revision:3",
        contentDigest: "a".repeat(64),
        scope: "workspace",
      },
    ],
    targetRecordRef: "memory:new",
  },
  evidenceRefs: ["evidence:browser-review"],
  risk: "sensitive",
  expectedRevision: 3,
  proposalDigest: "c".repeat(64),
  previewRef: "artifact:browser-lineage-review",
  conflictStatus: "none",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

describe("MemoryProposalDetail browser contract", () => {
  it("keeps proof fields visible while leaving approval to SessionAskPanel", async () => {
    const screen = await render(MemoryProposalDetail, { proposal });
    await expect.element(screen.getByText("sensitive")).toBeVisible();
    await expect.element(screen.getByText("memory:old:revision:3")).toBeVisible();
    await expect.element(screen.getByText("evidence:browser-review")).toBeVisible();
    await expect.element(screen.getByText(/owning session’s Ask panel/u)).toBeVisible();
    expect(screen.container.querySelector("button")).toBeNull();
    expect(screen.container.querySelector("form")).toBeNull();
    await screen.unmount();
  });
});
