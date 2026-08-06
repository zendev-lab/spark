import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import MemoryProposalDetail from "./MemoryProposalDetail.svelte";
import MemoryQuarantineDetail from "./MemoryQuarantineDetail.svelte";
import {
  parseHubMemoryProposalDetail,
  parseHubMemoryQuarantineDetail,
  type HubMemoryProposalDetail,
  type HubMemoryQuarantineDetail,
} from "./memory-proposal-detail";

export const memoryProposalFixture: HubMemoryProposalDetail = {
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

describe("Hub memory proposal detail", () => {
  it("parses the bounded artifact projection", () => {
    expect(parseHubMemoryProposalDetail({ memoryProposal: memoryProposalFixture })).toEqual(
      memoryProposalFixture,
    );
    expect(parseHubMemoryProposalDetail({ memoryProposal: { proposalId: "bad" } })).toBeNull();
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

const memoryQuarantineFixture: HubMemoryQuarantineDetail = {
  artifactRef: "artifact:memory-quarantine-fixture",
  proposalId: "memory-proposal:purge-fixture",
  operation: "purge",
  status: "approved",
  manifestDigest: "a".repeat(64),
  planDigest: "b".repeat(64),
  purgeAfter: "2099-01-01T00:00:00.000Z",
  tombstoneStatus: "purge_incomplete",
  targetReceipts: [
    {
      targetId: "target:content",
      kind: "content",
      status: "completed",
      recordedAt: "2099-01-02T00:00:00.000Z",
      error: null,
    },
    {
      targetId: "target:revision",
      kind: "revision",
      status: "failed",
      recordedAt: "2099-01-02T00:00:01.000Z",
      error: "injected failure",
    },
  ],
  remainingTargets: ["target:revision"],
};

describe("Hub memory quarantine detail", () => {
  it("accepts receipts only through canonical artifact projection identity", () => {
    expect(
      parseHubMemoryQuarantineDetail({
        artifactRef: memoryQuarantineFixture.artifactRef,
        memoryQuarantine: memoryQuarantineFixture,
        openPreviewUrl: "http://temporary.invalid/not-a-receipt",
      }),
    ).toEqual(memoryQuarantineFixture);
    expect(
      parseHubMemoryQuarantineDetail({ memoryQuarantine: memoryQuarantineFixture }),
    ).toBeNull();
    expect(
      parseHubMemoryQuarantineDetail({
        artifactRef: "http://temporary.invalid",
        memoryQuarantine: memoryQuarantineFixture,
      }),
    ).toBeNull();
  });

  it("renders plan, manifest, purge-after, target receipt, failure, and remaining-target state", () => {
    const html = render(MemoryQuarantineDetail, {
      props: { detail: memoryQuarantineFixture },
    }).body;
    for (const visible of [
      "Memory quarantine",
      "purge_incomplete",
      "Manifest digest",
      "Plan digest",
      "Purge after",
      "target:revision",
      "injected failure",
      "Remaining targets",
    ]) {
      expect(html).toContain(visible);
    }
    expect(html).not.toContain("openPreviewUrl");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});
