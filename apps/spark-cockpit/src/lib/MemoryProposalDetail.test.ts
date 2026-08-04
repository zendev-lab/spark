import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import MemoryProposalDetail from "./MemoryProposalDetail.svelte";
import {
  parseCockpitMemoryProposalDetail,
  type CockpitMemoryProposalDetail,
} from "./memory-proposal-detail";

export const memoryProposalFixture: CockpitMemoryProposalDetail = {
  proposalId: "memory-proposal:fixture",
  operation: "propose_merge",
  status: "pending",
  diff: {
    before: [
      {
        recordRef: "memory:first",
        revisionRef: "memory:first:revision:1",
        contentDigest: "a".repeat(64),
      },
      {
        recordRef: "memory:second",
        revisionRef: "memory:second:revision:1",
        contentDigest: "b".repeat(64),
      },
    ],
    after: { recordRef: "memory:first", contentDigest: "c".repeat(64) },
  },
  lineage: {
    sources: [
      {
        recordRef: "memory:first",
        revisionRef: "memory:first:revision:1",
        contentDigest: "a".repeat(64),
        scope: "workspace",
      },
      {
        recordRef: "memory:second",
        revisionRef: "memory:second:revision:1",
        contentDigest: "b".repeat(64),
        scope: "workspace",
      },
    ],
    targetRecordRef: "memory:first",
  },
  evidenceRefs: ["evidence:review"],
  risk: "behavior_changing",
  expectedRevision: 1,
  proposalDigest: "d".repeat(64),
  previewRef: "artifact:lineage-fixture",
  conflictStatus: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

describe("Cockpit memory proposal detail", () => {
  it("parses the bounded artifact projection", () => {
    expect(parseCockpitMemoryProposalDetail({ memoryProposal: memoryProposalFixture })).toEqual(
      memoryProposalFixture,
    );
    expect(parseCockpitMemoryProposalDetail({ memoryProposal: { proposalId: "bad" } })).toBeNull();
  });

  it("renders diff, digest, risk, evidence, revision, lineage, and conflict state without actions", () => {
    const html = render(MemoryProposalDetail, { props: { proposal: memoryProposalFixture } }).body;
    for (const visible of [
      "Before",
      "After",
      "behavior_changing",
      "Expected revision",
      "Proposal digest",
      "evidence:review",
      "memory:second:revision:1",
      "Conflict",
      "none",
      "owning session’s Ask panel",
    ]) {
      expect(html).toContain(visible);
    }
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});
