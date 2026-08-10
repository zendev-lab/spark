import assert from "node:assert/strict";

const checkpointOperations = {
  "ask.pending": "journey-decision",
  "git.post_commit": "git_change.committed",
  "git.post_pr": "pull_request.submitted",
  "report.post_projection": "report.projected",
  "report.post_sync": "report.synced",
} as const;

const milestoneNames = [
  "repro.started",
  "decision.requested",
  "decision.persisted_across_restart",
  "decision.answered",
  "repro.resumed",
  "validation.failed_before_fix",
  "validation.passed_after_fix",
  "git_change.committed",
  "pull_request.submitted",
  "report.projected",
  "report.synced",
  "repro.completed",
  "workbench.sealed",
] as const;

interface ProcessIdentity {
  pid: number;
  generation: string;
  processStartToken: string;
}

interface RecoveryCheckpoint {
  id: keyof typeof checkpointOperations;
  sequence: number;
  operationId: string;
  before: ProcessIdentity;
  after: ProcessIdentity;
  providerHighWaterBefore: number;
  providerHighWaterAfter: number;
  cursorBefore: number;
  cursorAfter: number;
}

interface RecoveryLedger {
  schema: string;
  reproId: string;
  milestones: Array<{ name: string; reproId: string; count: number; sequence: number }>;
  providerRoundsAtWait: number;
  providerRoundsAtAnswer: number;
  resumeCount: number;
  toolApprovalCount: number;
  interaction: {
    beforeRestart: { interactionRequestId: string; humanRequestId: string };
    afterRestart: { interactionRequestId: string; humanRequestId: string };
    answerReceipt: string;
    answerOutcome: string;
  };
  interactionRequestId: string;
  humanRequestId: string;
  answerReceipt: string;
  daemon: { checkpoints: RecoveryCheckpoint[]; sqlitePath: string };
  validation: {
    reference: { exitCode: number };
    targetBeforeRepair: { exitCode: number };
    targetAfterRepair: { exitCode: number };
  };
  git: {
    commitCount: number;
    changedPaths: string[];
    statusPorcelainOutput: string;
    draftPrCreates: number;
    nonDraftPrCreates: number;
    artifactRef: string;
  };
  report: {
    summaryDigest: string;
    projectedReportDigest: string;
    reportArtifactRef: string;
    artifactRefs: string[];
    evidenceRefs: string[];
    formalGateCount: number;
    formalGatesAccepted: boolean;
    workbenchLifecycle: string;
    documentRevision: number;
  };
  terminalOwner: {
    pendingAskCount: number;
    canonicalDecisionRequestCount: number;
    toolApprovalRequestCount: number;
    activeInvocationCount: number;
    workbenchLifecycle: string;
    writableWorkbenchCount: number;
    formalEvidenceReceiptCount: number;
  };
  teardown: { daemonPids: number[]; liveDaemonPids: number[]; hubAlive: boolean };
  livePidCount: number;
}

export function assertReproGoldenJourneyRecoverySemantics(
  value: unknown,
): asserts value is RecoveryLedger {
  assert.ok(isRecord(value), "recovery ledger must be an object");
  const ledger = value as unknown as RecoveryLedger;
  assert.equal(ledger.schema, "spark.repro-golden-journey-process/v1");
  assert.equal(ledger.providerRoundsAtAnswer, ledger.providerRoundsAtWait);
  assert.equal(ledger.resumeCount, 1);
  assert.equal(ledger.toolApprovalCount, 0);

  assert.deepEqual(
    ledger.milestones.map((milestone) => milestone.name),
    [...milestoneNames],
  );
  assert.ok(
    ledger.milestones.every(
      (milestone, index) =>
        milestone.reproId === ledger.reproId &&
        milestone.count === 1 &&
        milestone.sequence === index + 1,
    ),
  );

  assert.deepEqual(
    ledger.daemon.checkpoints.map((checkpoint) => checkpoint.id),
    Object.keys(checkpointOperations),
  );
  for (const [index, checkpoint] of ledger.daemon.checkpoints.entries()) {
    assert.equal(checkpoint.sequence, index + 1);
    assert.equal(checkpoint.operationId, checkpointOperations[checkpoint.id]);
    assert.equal(checkpoint.providerHighWaterAfter, checkpoint.providerHighWaterBefore);
    assert.equal(checkpoint.cursorAfter, checkpoint.cursorBefore);
    assert.notEqual(checkpoint.after.pid, checkpoint.before.pid);
    assert.notEqual(checkpoint.after.generation, checkpoint.before.generation);
    assert.notEqual(checkpoint.after.processStartToken, checkpoint.before.processStartToken);
    if (index > 0) {
      assert.deepEqual(checkpoint.before, ledger.daemon.checkpoints[index - 1]!.after);
    }
  }

  assert.equal(
    ledger.interaction.beforeRestart.interactionRequestId,
    ledger.interaction.afterRestart.interactionRequestId,
  );
  assert.equal(
    ledger.interaction.beforeRestart.humanRequestId,
    ledger.interaction.afterRestart.humanRequestId,
  );
  assert.equal(ledger.interactionRequestId, ledger.interaction.afterRestart.interactionRequestId);
  assert.equal(ledger.humanRequestId, ledger.interaction.afterRestart.humanRequestId);
  assert.equal(ledger.answerReceipt, ledger.interaction.answerReceipt);
  assert.ok(["accepted", "orphaned"].includes(ledger.interaction.answerOutcome));

  assert.equal(ledger.validation.reference.exitCode, 0);
  assert.equal(ledger.validation.targetBeforeRepair.exitCode, 1);
  assert.equal(ledger.validation.targetAfterRepair.exitCode, 0);
  assert.equal(ledger.git.commitCount, 1);
  assert.deepEqual(ledger.git.changedPaths, ["target/normalize.mjs"]);
  assert.equal(ledger.git.statusPorcelainOutput, "");
  assert.equal(ledger.git.draftPrCreates, 1);
  assert.equal(ledger.git.nonDraftPrCreates, 0);
  assert.equal(
    ledger.report.artifactRefs.filter((ref) => ref === ledger.git.artifactRef).length,
    1,
  );
  assert.notEqual(ledger.git.artifactRef, ledger.report.reportArtifactRef);

  assert.equal(ledger.report.summaryDigest, ledger.report.projectedReportDigest);
  assert.equal(
    ledger.report.artifactRefs.filter((ref) => ref === ledger.report.reportArtifactRef).length,
    1,
  );
  assert.ok(ledger.report.evidenceRefs.some((ref) => ref.startsWith("evidence:answer-event:")));
  assert.equal(ledger.report.formalGatesAccepted, true);
  assert.equal(ledger.report.formalGateCount, 5);
  assert.equal(ledger.report.workbenchLifecycle, "sealed");
  assert.equal(ledger.report.documentRevision, 1);

  assert.equal(ledger.terminalOwner.pendingAskCount, 0);
  assert.equal(ledger.terminalOwner.canonicalDecisionRequestCount, 1);
  assert.equal(ledger.terminalOwner.toolApprovalRequestCount, 0);
  assert.equal(ledger.terminalOwner.activeInvocationCount, 0);
  assert.equal(ledger.terminalOwner.workbenchLifecycle, "sealed");
  assert.equal(ledger.terminalOwner.writableWorkbenchCount, 0);
  assert.equal(ledger.terminalOwner.formalEvidenceReceiptCount, ledger.report.formalGateCount);
  assert.deepEqual(
    ledger.teardown.daemonPids,
    ledger.daemon.checkpoints
      .map(({ after }) => after.pid)
      .toSpliced(0, 0, ledger.daemon.checkpoints[0]!.before.pid),
  );
  assert.deepEqual(ledger.teardown.liveDaemonPids, []);
  assert.equal(ledger.teardown.hubAlive, false);
  assert.equal(ledger.livePidCount, 0);
}

export function goldenJourneyOwnerOutcomeProjection(value: unknown): unknown {
  assert.ok(isRecord(value), "Golden Journey ledger must be an object");
  const ledger = value as unknown as RecoveryLedger;
  assert.equal(ledger.schema, "spark.repro-golden-journey-process/v1");
  assert.equal(ledger.providerRoundsAtAnswer, ledger.providerRoundsAtWait);
  assert.equal(ledger.resumeCount, 1);
  assert.deepEqual(
    ledger.milestones.map(({ name, count, sequence }) => ({ name, count, sequence })),
    milestoneNames.map((name, index) => ({ name, count: 1, sequence: index + 1 })),
  );
  assert.equal(
    ledger.interaction.beforeRestart.interactionRequestId,
    ledger.interaction.afterRestart.interactionRequestId,
  );
  assert.equal(
    ledger.interaction.beforeRestart.humanRequestId,
    ledger.interaction.afterRestart.humanRequestId,
  );
  assert.equal(ledger.validation.reference.exitCode, 0);
  assert.equal(ledger.validation.targetBeforeRepair.exitCode, 1);
  assert.equal(ledger.validation.targetAfterRepair.exitCode, 0);
  assert.equal(ledger.git.commitCount, 1);
  assert.deepEqual(ledger.git.changedPaths, ["target/normalize.mjs"]);
  assert.equal(ledger.git.draftPrCreates, 1);
  assert.equal(ledger.git.nonDraftPrCreates, 0);
  assert.equal(ledger.report.summaryDigest, ledger.report.projectedReportDigest);
  assert.equal(
    ledger.report.artifactRefs.filter((ref) => ref === ledger.report.reportArtifactRef).length,
    1,
  );
  assert.equal(ledger.report.formalGateCount, 5);
  assert.equal(ledger.report.formalGatesAccepted, true);
  assert.equal(ledger.report.workbenchLifecycle, "sealed");
  assert.equal(ledger.terminalOwner.pendingAskCount, 0);
  assert.equal(ledger.terminalOwner.toolApprovalRequestCount, 0);
  assert.equal(ledger.terminalOwner.activeInvocationCount, 0);
  assert.equal(ledger.terminalOwner.writableWorkbenchCount, 0);
  assert.equal(ledger.livePidCount, 0);
  return {
    milestones: ledger.milestones.map(({ name, count, sequence }) => ({ name, count, sequence })),
    interaction: {
      stableRequest: true,
      answerRecorded: Boolean(ledger.answerReceipt),
      resumeCount: ledger.resumeCount,
    },
    validation: {
      reference: ledger.validation.reference.exitCode,
      targetBeforeRepair: ledger.validation.targetBeforeRepair.exitCode,
      targetAfterRepair: ledger.validation.targetAfterRepair.exitCode,
    },
    git: {
      commitCount: ledger.git.commitCount,
      changedPaths: ledger.git.changedPaths,
      draftPrCreates: ledger.git.draftPrCreates,
      nonDraftPrCreates: ledger.git.nonDraftPrCreates,
    },
    report: {
      projectionMatchesSummary: ledger.report.summaryDigest === ledger.report.projectedReportDigest,
      reportArtifactCount: ledger.report.artifactRefs.filter(
        (ref) => ref === ledger.report.reportArtifactRef,
      ).length,
      formalGateCount: ledger.report.formalGateCount,
      formalGatesAccepted: ledger.report.formalGatesAccepted,
      workbenchLifecycle: ledger.report.workbenchLifecycle,
    },
    terminal: {
      pendingAskCount: ledger.terminalOwner.pendingAskCount,
      toolApprovalRequestCount: ledger.terminalOwner.toolApprovalRequestCount,
      activeInvocationCount: ledger.terminalOwner.activeInvocationCount,
      writableWorkbenchCount: ledger.terminalOwner.writableWorkbenchCount,
      livePidCount: ledger.livePidCount,
    },
  };
}

export function recoveryOutcomeProjection(value: unknown): unknown {
  assertReproGoldenJourneyRecoverySemantics(value);
  return {
    milestones: value.milestones.map(({ name, count, sequence }) => ({ name, count, sequence })),
    checkpoints: value.daemon.checkpoints.map(({ id, sequence, operationId }) => ({
      id,
      sequence,
      operationId,
    })),
    interaction: {
      stableRequest: true,
      answerRecorded: Boolean(value.answerReceipt),
      resumeCount: value.resumeCount,
    },
    validation: {
      reference: value.validation.reference.exitCode,
      targetBeforeRepair: value.validation.targetBeforeRepair.exitCode,
      targetAfterRepair: value.validation.targetAfterRepair.exitCode,
    },
    git: {
      commitCount: value.git.commitCount,
      changedPaths: value.git.changedPaths,
      draftPrCreates: value.git.draftPrCreates,
      nonDraftPrCreates: value.git.nonDraftPrCreates,
      artifactRecorded: value.report.artifactRefs.includes(value.git.artifactRef),
    },
    report: {
      projectionMatchesSummary: value.report.summaryDigest === value.report.projectedReportDigest,
      reportArtifactCount: value.report.artifactRefs.filter(
        (ref) => ref === value.report.reportArtifactRef,
      ).length,
      formalGateCount: value.report.formalGateCount,
      formalGatesAccepted: value.report.formalGatesAccepted,
      workbenchLifecycle: value.report.workbenchLifecycle,
      documentRevision: value.report.documentRevision,
    },
    terminal: {
      pendingAskCount: value.terminalOwner.pendingAskCount,
      toolApprovalRequestCount: value.terminalOwner.toolApprovalRequestCount,
      activeInvocationCount: value.terminalOwner.activeInvocationCount,
      writableWorkbenchCount: value.terminalOwner.writableWorkbenchCount,
      livePidCount: value.livePidCount,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
