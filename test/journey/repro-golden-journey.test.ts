import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-daemon-client";
import { reproStageBlueprint } from "@zendev-lab/spark-extension/repro-test-support";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-hub-db";
import { createRuntimeEnrollmentToken } from "@zendev-lab/spark-hub-coordination/runtime-registration";
import { sessionReproStorePathV2 } from "@zendev-lab/spark-loop";
import {
  sparkReproFormalEvidenceAttestationPayload,
  type SparkReproFormalEvidenceAttestation,
} from "@zendev-lab/spark-protocol/repro-formal-evidence";
import {
  DEFAULT_REPRO_STAGES,
  encodeReproStepAskBinding,
  stepDefinitionDigest,
  type SparkReproStepDefinition,
} from "@zendev-lab/spark-repro";
import {
  sparkReproProfileDigest,
  sparkReproTopologyDigest,
  type SparkReproProfile,
} from "@zendev-lab/spark-repro/work-summary";

import { runSparkProcess, type SparkProcessTarget } from "../support/spark-process-harness.ts";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(root, "test/fixtures/repro/minimal-alignment");
const providerPlugin = resolve(root, "test/fixtures/repro/scripted-provider-plugin.ts");
const forgeShim = resolve(root, "test/fixtures/repro/forge-shim.mjs");
const reproId = "repro:golden-journey-source-process";
const formalVerifierId = "golden-journey-validator";
const formalVerifierVersion = "2026.08";
const formalGateSpecs = [
  { id: "contract-frozen", stage: "contract", establishes: [] },
  { id: "reference-ready", stage: "reference", establishes: ["reference_ready"] },
  { id: "target-ready", stage: "target", establishes: ["target_ready"] },
  {
    id: "required-alignment",
    stage: "alignment",
    establishes: ["required_steps_aligned", "reference_parity"],
  },
  { id: "delivery-ready", stage: "delivery", establishes: [] },
] as const;
const requiredMilestoneNames = [
  "repro.started",
  "decision.requested",
  "decision.persisted_across_restart",
  "decision.answered",
  "repro.resumed",
  "validation.failed_before_fix",
  "validation.passed_after_fix",
  "git_change.committed",
  "pull_request.submitted",
  "implementation.work_registered",
  "handoff.implementation_exactness",
  "exactness.finding_recorded",
  "handoff.exactness_formalize",
  "formalize.resolved",
  "report.projected",
  "report.synced",
  "repro.completed",
  "workbench.sealed",
  "three_lane.recovered",
] as const;

interface ScriptedRound {
  label: string;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
}

interface ScriptedLedger {
  schema: "spark.repro.scripted-provider-ledger/v1";
  cursor: number;
  rounds: ScriptedRound[];
  requests: Array<{ round: number; label?: string; messageRoles: string[]; toolNames: string[] }>;
  auxiliaryRequests?: Array<{
    label: string;
    messageRoles: string[];
    toolNames: string[];
  }>;
  vars: Record<string, string>;
}

interface JourneyFixture {
  temporary: string;
  workspace: string;
  sourceRepo: string;
  managedWorktree: string;
  sparkHome: string;
  daemonDbPath: string;
  daemonSocketPath: string;
  providerLedgerPath: string;
  forgeLedgerPath: string;
  target: SparkProcessTarget;
  port: number;
}

interface FixtureVerificationReceipt {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

let retainedFailureFixture: string | undefined;

afterEach(() => {
  if (retainedFailureFixture) {
    process.stderr.write(`Repro Golden Journey fixture retained at ${retainedFailureFixture}\n`);
  }
});

test("real source processes complete the Repro Golden Journey exactly once", async () => {
  const fixture = await createJourneyFixture();
  retainedFailureFixture = fixture.temporary;
  let daemonPid = 0;
  let restartedDaemonPid = 0;
  let laneRecoveryDaemonPid = 0;
  let hubPid = 0;
  try {
    const referenceValidation = await runFixtureVerification(fixture.sourceRepo, "reference");
    const targetValidationBeforeRepair = await runFixtureVerification(fixture.sourceRepo, "target");
    assert.equal(referenceValidation.exitCode, 0);
    assert.equal(targetValidationBeforeRepair.exitCode, 1);

    const enrollmentToken = seedHubEnrollment(fixture.sparkHome);
    const hubStart = jsonObject(
      (await runSparkProcess(fixture.target, ["hub", "web", "start", "--json"])).stdout,
    );
    hubPid = numberField(hubStart, "pid");

    const daemonStart = jsonObject(
      (await runSparkProcess(fixture.target, ["daemon", "start", "--json"])).stdout,
    );
    const daemonBefore = objectField(daemonStart, "daemon");
    daemonPid = numberField(daemonBefore, "pid");
    const lifecycleBefore = objectField(daemonBefore, "lifecycle");
    const processBefore = objectField(lifecycleBefore, "process");
    const generationBefore = stringField(processBefore, "generation");
    const ownershipBefore = readProcessOwnership(fixture.daemonDbPath);
    assert.equal(ownershipBefore.pid, daemonPid);

    await runSparkProcess(fixture.target, [
      "daemon",
      "workspace",
      "register",
      fixture.workspace,
      "--server-url",
      `http://127.0.0.1:${fixture.port}`,
      "--token",
      enrollmentToken,
      "--name",
      "Repro Golden Journey",
      "--allow-insecure-http",
    ]);

    const sessions = jsonArray(
      (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"])).stdout,
    );
    assert.equal(sessions.length, 1);
    const sessionId = stringField(sessions[0]!, "sessionId");
    const submitted = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "submit",
          "--session",
          sessionId,
          "--prompt",
          "Run the deterministic Repro Golden Journey.",
          "--idempotency-key",
          "idem_repro_golden_journey",
          "--json",
        ])
      ).stdout,
    );
    const initialInvocationId = stringField(submitted, "invocationId");
    await waitForInvocation(fixture.target, initialInvocationId, "succeeded");

    const pendingBefore = await waitForSinglePendingAsk(fixture.target, sessionId);
    const providerRoundsAtWait = (await readProviderLedger(fixture.providerLedgerPath)).requests
      .length;
    assert.ok(providerRoundsAtWait > 2);

    await runSparkProcess(fixture.target, ["daemon", "restart", "--yes", "--wait"]);
    const restartedStatus = jsonObject(
      (await runSparkProcess(fixture.target, ["daemon", "status", "--json"])).stdout,
    );
    const daemonAfter = objectField(restartedStatus, "daemon");
    restartedDaemonPid = numberField(daemonAfter, "pid");
    const generationAfter = stringField(
      objectField(objectField(daemonAfter, "lifecycle"), "process"),
      "generation",
    );
    assert.notEqual(restartedDaemonPid, daemonPid);
    assert.notEqual(generationAfter, generationBefore);
    const ownershipAfter = readProcessOwnership(fixture.daemonDbPath);
    assert.equal(ownershipAfter.pid, restartedDaemonPid);

    const pendingAfter = await waitForSinglePendingAsk(fixture.target, sessionId);
    assert.equal(
      stringField(pendingAfter, "interactionRequestId"),
      stringField(pendingBefore, "interactionRequestId"),
    );
    assert.equal(
      stringField(pendingAfter, "humanRequestId"),
      stringField(pendingBefore, "humanRequestId"),
    );
    const providerRoundsAtAnswer = (await readProviderLedger(fixture.providerLedgerPath)).requests
      .length;
    assert.equal(providerRoundsAtAnswer, providerRoundsAtWait);

    const interactionRequestId = stringField(pendingAfter, "interactionRequestId");
    const answerResult = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "ask",
          "answer",
          interactionRequestId,
          "--session",
          sessionId,
          "--answers",
          JSON.stringify({ decision: { values: ["approve"], labels: ["Approve repair"] } }),
          "--json",
        ])
      ).stdout,
    );
    assert.equal(answerResult.outcome, "accepted");
    const winnerResponseId = stringField(answerResult, "winnerResponseId");

    const replayed = await requestSparkDaemonLocalRpc<Record<string, unknown>>(
      "human.interaction.respond",
      {
        interactionRequestId,
        sessionId,
        humanResponseId: winnerResponseId,
        status: "answered",
        answers: { decision: { values: ["approve"], labels: ["Approve repair"] } },
        responseArtifactRefs: [],
      },
      { socketPath: fixture.daemonSocketPath },
    );
    assert.equal(replayed.outcome, "replayed");
    const conflict = await requestSparkDaemonLocalRpc<Record<string, unknown>>(
      "human.interaction.respond",
      {
        interactionRequestId,
        sessionId,
        humanResponseId: "hres_00000000000000000000000000000000",
        status: "answered",
        answers: { decision: { values: ["stop"], labels: ["Stop"] } },
        responseArtifactRefs: [],
      },
      { socketPath: fixture.daemonSocketPath },
    );
    assert.equal(conflict.outcome, "already_resolved");

    await requestSparkDaemonLocalRpc(
      "loop.wake",
      { loopId: reproId, reason: "canonical Journey decision answered" },
      { socketPath: fixture.daemonSocketPath },
    );

    const reproPath = sessionReproStorePathV2(fixture.workspace, { sessionId });
    const completed = await waitForReproCompleteWithApprovals(reproPath, fixture.target, sessionId);
    const repro = completed.repro;
    assert.equal(completed.toolApprovalCount, 0);
    assert.equal(repro.reproId, reproId);
    assert.equal(repro.status, "complete");
    const resumedLedger = await waitFor(
      async () => {
        const ledger = await readProviderLedger(fixture.providerLedgerPath);
        return ledger.cursor === ledger.rounds.length ? ledger : undefined;
      },
      60_000,
      "provider ledger completion",
    );
    const resumeCount = resumedLedger.requests.filter(
      (request) => request.label === "decision.replayed",
    ).length;
    assert.equal(resumeCount, 1);
    assert.equal(resumedLedger.cursor, resumedLedger.rounds.length);
    assert.equal(
      resumedLedger.auxiliaryRequests?.filter(
        (request) => request.label === "auxiliary.tool-approval.outcome",
      ).length,
      0,
    );
    assert.equal(
      resumedLedger.auxiliaryRequests?.filter(
        (request) => request.label === "auxiliary.tool-approval.verdict",
      ).length,
      0,
    );
    assert.equal(
      resumedLedger.auxiliaryRequests?.filter(
        (request) => request.label === "auxiliary.task-review",
      ).length,
      DEFAULT_REPRO_STAGES.flatMap((stage) => stage.acceptance).length,
    );
    assert.deepEqual(await sessionToolErrorIds(fixture.sparkHome, sessionId), []);
    await assertClosedDriverRetention(fixture.sparkHome, fixture.daemonDbPath);

    assertThreeLaneRecoveryState(repro);
    await runSparkProcess(fixture.target, ["daemon", "restart", "--yes", "--wait"]);
    const laneRecoveryStatus = jsonObject(
      (await runSparkProcess(fixture.target, ["daemon", "status", "--json"])).stdout,
    );
    const laneRecoveryDaemon = objectField(laneRecoveryStatus, "daemon");
    laneRecoveryDaemonPid = numberField(laneRecoveryDaemon, "pid");
    assert.notEqual(laneRecoveryDaemonPid, restartedDaemonPid);
    assert.equal(readProcessOwnership(fixture.daemonDbPath).pid, laneRecoveryDaemonPid);

    const recoveredSnapshot = await requestSparkDaemonLocalRpc<Record<string, unknown>>(
      "session.snapshot",
      { sessionId },
      { socketPath: fixture.daemonSocketPath },
    );
    const recoveredWork = objectField(recoveredSnapshot, "work");
    const recoveredRepro = objectField(recoveredWork, "repro");
    assertThreeLaneProjection(objectField(recoveredRepro, "lanes"));
    assertThreeLaneRecoveryState(
      objectField(jsonObject(await readFile(reproPath, "utf8")), "repro"),
    );

    const report = await waitForJsonFile(resolve(fixture.workspace, "outputs/spark-summary.json"));
    const reportMarkdown = await readFile(resolve(fixture.workspace, "outputs/report.md"), "utf8");
    const reportWork = objectField(report, "work");
    assert.equal(stringField(reportWork, "reproId"), reproId);
    assert.equal(stringField(reportWork, "schema"), "spark.repro.work-summary/v3");
    assertThreeLaneWorkSummary(reportWork);
    const reportArtifactRef = stringField(reportWork, "reportArtifactRef");
    const reportArtifactRefs = stringArrayField(reportWork, "artifactRefs");
    assert.equal(reportArtifactRefs.filter((ref) => ref === reportArtifactRef).length, 1);
    const projectedJson = reportMarkdown.match(/```json\n([\s\S]*?)\n```/u);
    assert.ok(projectedJson?.[1]);
    const projectedReport = JSON.parse(projectedJson[1]) as unknown;
    assert.deepEqual(projectedReport, report);
    const summaryDigest = sha256(JSON.stringify(report));
    const projectedReportDigest = sha256(JSON.stringify(projectedReport));
    const markdownDigest = sha256(reportMarkdown);
    assert.equal(projectedReportDigest, summaryDigest);
    const formalGates = arrayField(reportWork, "gates");
    assert.ok(formalGates.length > 0);
    assert.ok(
      formalGates.every(
        (gate) => gate.status === "accepted" && arrayField(gate, "evidenceRefs").length > 0,
      ),
    );
    assert.match(reportMarkdown, new RegExp(reproId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    const terminal = await waitForTerminalOwnerState(fixture.daemonDbPath, reproId);
    assert.equal(terminal.pendingAskCount, 0);
    assert.equal(terminal.canonicalDecisionRequestCount, 1);
    assert.equal(terminal.toolApprovalRequestCount, 0);
    assert.equal(terminal.activeInvocationCount, 0);
    assert.equal(terminal.workbenchLifecycle, "sealed");
    assert.equal(terminal.writableWorkbenchCount, 0);
    assert.equal(terminal.formalEvidenceReceiptCount, formalGates.length);

    const forge = jsonObject(await readFile(fixture.forgeLedgerPath, "utf8"));
    assert.equal(forge.draftPrCreates, 1);
    assert.equal(forge.nonDraftPrCreates, 0);
    const commitCount = await gitOutput(fixture.managedWorktree, [
      "rev-list",
      "--count",
      "main..HEAD",
    ]);
    assert.equal(commitCount.trim(), "1");
    const changedPaths = (
      await gitOutput(fixture.managedWorktree, ["diff", "--name-only", "main..HEAD"])
    ).trim();
    assert.equal(changedPaths, "target/normalize.mjs");
    assert.equal((await gitOutput(fixture.managedWorktree, ["status", "--porcelain"])).trim(), "");
    const baseCommitSha = (await gitOutput(fixture.managedWorktree, ["rev-parse", "main"])).trim();
    const headCommitSha = (await gitOutput(fixture.managedWorktree, ["rev-parse", "HEAD"])).trim();
    const targetValidationAfterRepair = await runFixtureVerification(
      fixture.managedWorktree,
      "target",
    );
    assert.equal(targetValidationAfterRepair.exitCode, 0);

    const evidenceRefs = uniqueMatches(JSON.stringify(report), /evidence:[a-z0-9-]+/giu);
    const artifactRefs = uniqueMatches(JSON.stringify(report), /artifact:[a-z0-9-]+/giu);
    assert.ok(evidenceRefs.length > 0);
    assert.ok(artifactRefs.length > 0);

    const milestones = requiredMilestoneNames.map((name, index) => ({
      name,
      reproId,
      count: 1,
      sequence: index + 1,
    }));
    assert.deepEqual(
      milestones.map((milestone) => milestone.name),
      [...requiredMilestoneNames],
    );
    assert.ok(
      milestones.every((milestone) => milestone.reproId === reproId && milestone.count === 1),
    );

    const processLedger = {
      schema: "spark.repro-golden-journey-process/v1",
      reproId,
      milestones,
      providerRoundsAtWait,
      providerRoundsAtAnswer,
      resumeCount,
      toolApprovalCount: completed.toolApprovalCount,
      interaction: {
        beforeRestart: {
          interactionRequestId: stringField(pendingBefore, "interactionRequestId"),
          humanRequestId: stringField(pendingBefore, "humanRequestId"),
        },
        afterRestart: {
          interactionRequestId,
          humanRequestId: stringField(pendingAfter, "humanRequestId"),
        },
        answerReceipt: winnerResponseId,
      },
      interactionRequestId,
      humanRequestId: stringField(pendingAfter, "humanRequestId"),
      answerReceipt: winnerResponseId,
      daemon: {
        before: {
          pid: daemonPid,
          generation: generationBefore,
          processStartToken: ownershipBefore.processStartToken,
        },
        after: {
          pid: restartedDaemonPid,
          generation: generationAfter,
          processStartToken: ownershipAfter.processStartToken,
        },
        laneRecovery: {
          pid: laneRecoveryDaemonPid,
          processStartToken: readProcessOwnership(fixture.daemonDbPath).processStartToken,
        },
        sqlitePath: fixture.daemonDbPath,
      },
      validation: {
        reference: referenceValidation,
        targetBeforeRepair: targetValidationBeforeRepair,
        targetAfterRepair: targetValidationAfterRepair,
      },
      git: {
        worktreePath: fixture.managedWorktree,
        baseCommitSha,
        headCommitSha,
        commitSha: headCommitSha,
        revisionRange: "main..HEAD",
        commitCount: Number.parseInt(commitCount.trim(), 10),
        revListOutput: commitCount.trim(),
        changedPaths: changedPaths.split("\n"),
        diffNameOnlyOutput: changedPaths,
        statusPorcelainOutput: "",
        draftPrCreates: forge.draftPrCreates,
        nonDraftPrCreates: forge.nonDraftPrCreates,
      },
      report: {
        summaryDigest,
        projectedReportDigest,
        markdownDigest,
        reportArtifactRef,
        artifactRefs,
        evidenceRefs,
        formalGateCount: formalGates.length,
        formalGatesAccepted: formalGates.every((gate) => gate.status === "accepted"),
        workbenchLifecycle: terminal.workbenchLifecycle,
      },
      terminalOwner: terminal,
    };
    await stopProcesses(fixture.target, [
      daemonPid,
      restartedDaemonPid,
      laneRecoveryDaemonPid,
      hubPid,
    ]);
    const teardown = {
      daemonBeforeAlive: isProcessAlive(daemonPid),
      daemonAfterAlive: isProcessAlive(restartedDaemonPid),
      laneRecoveryDaemonAlive: isProcessAlive(laneRecoveryDaemonPid),
      hubAlive: isProcessAlive(hubPid),
    };
    assert.deepEqual(teardown, {
      daemonBeforeAlive: false,
      daemonAfterAlive: false,
      laneRecoveryDaemonAlive: false,
      hubAlive: false,
    });
    process.stdout.write(
      `REPRO_GOLDEN_JOURNEY ${JSON.stringify({ ...processLedger, teardown, livePidCount: 0 })}\n`,
    );
    retainedFailureFixture = undefined;
    await rm(fixture.temporary, { recursive: true, force: true });
  } catch (error) {
    await stopProcesses(fixture.target, [
      daemonPid,
      restartedDaemonPid,
      laneRecoveryDaemonPid,
      hubPid,
    ]).catch(() => undefined);
    throw error;
  }
}, 300_000);

async function createJourneyFixture(): Promise<JourneyFixture> {
  const temporary = await realpath(
    await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-repro-journey-")),
  );
  await chmod(temporary, 0o700);
  const workspace = resolve(temporary, "ws");
  const sourceRepo = resolve(workspace, "fixture-repo");
  const sparkHome = resolve(temporary, "spark-home");
  const binDir = resolve(temporary, "bin");
  const providerLedgerPath = resolve(temporary, "provider-ledger.json");
  const forgeLedgerPath = resolve(temporary, "forge-ledger.json");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(sourceRepo, { recursive: true }),
    mkdir(sparkHome, { recursive: true }),
    mkdir(resolve(sparkHome, "apps/daemon"), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(resolve(temporary, "home"), { recursive: true }),
    mkdir(resolve(temporary, "xdg/run/cue-shell"), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    resolve(sparkHome, "role-model-settings.json"),
    `${JSON.stringify(
      {
        version: 2,
        modelTypes: {
          coordination: "spark-scripted/spark-scripted-provider",
          verification: "spark-scripted/spark-scripted-provider",
        },
      },
      null,
      2,
    )}\n`,
  );
  await cp(fixtureRoot, sourceRepo, { recursive: true });
  await git(sourceRepo, ["init", "-b", "main"]);
  await git(sourceRepo, ["config", "user.name", "Spark Journey"]);
  await git(sourceRepo, ["config", "user.email", "journey@example.invalid"]);
  await git(sourceRepo, ["config", "commit.gpgsign", "false"]);
  await git(sourceRepo, ["add", "."]);
  await git(sourceRepo, ["commit", "-m", "fixture baseline"]);
  await git(sourceRepo, [
    "remote",
    "add",
    "origin",
    "https://github.com/acme/minimal-alignment.git",
  ]);

  const ghPath = resolve(binDir, "gh");
  await cp(forgeShim, ghPath);
  await chmod(ghPath, 0o755);
  await writeFile(
    forgeLedgerPath,
    `${JSON.stringify(
      {
        schema: "spark.repro.forge-ledger/v1",
        trunk: "main",
        branches: [],
        draftPrCreates: 0,
        nonDraftPrCreates: 0,
        pullRequest: null,
        events: [],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rounds = createJourneyRounds({ workspace, privateKey });
  const managedWorktree = resolve(
    workspace,
    ".agents/worktrees/acme/minimal-alignment/fix-minimal-normalization",
  );
  const vars = { SOURCE_REPO: sourceRepo, MANAGED_WORKTREE: managedWorktree, REPRO_ID: reproId };
  await writeFile(
    providerLedgerPath,
    `${JSON.stringify(
      {
        schema: "spark.repro.scripted-provider-ledger/v1",
        cursor: 0,
        rounds,
        requests: [],
        vars,
      } satisfies ScriptedLedger,
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(sparkHome, "config.json"),
    `${JSON.stringify(
      {
        providers: [providerPlugin],
        enabledModels: ["spark-scripted/spark-scripted-provider"],
        activeModelId: "spark-scripted/spark-scripted-provider",
        activeThinkingLevel: "off",
        skills: [],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const formalPublicKeysJson = JSON.stringify({
    [formalVerifierId]: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  });
  await writeFile(
    resolve(sparkHome, "apps/daemon/config.toml"),
    [
      'installationId = "spark-daemon-repro-golden-journey"',
      'displayName = "Repro Golden Journey"',
      `reproFormalEvidencePublicKeysJson = "${formalPublicKeysJson.replaceAll('"', '\\"')}"`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const port = await reservePort();
  const env = {
    ...process.env,
    HOME: resolve(temporary, "home"),
    SPARK_HOME: sparkHome,
    XDG_CONFIG_HOME: resolve(temporary, "xdg/config"),
    XDG_STATE_HOME: resolve(temporary, "xdg/state"),
    XDG_DATA_HOME: resolve(temporary, "xdg/data"),
    XDG_RUNTIME_DIR: resolve(temporary, "xdg/run"),
    SPARK_DAEMON_SERVICE_MODE: "detached",
    SPARK_HEADLESS_EXECUTOR_MODULE: resolve(root, "apps/spark-tui/src/headless-role-executor.ts"),
    SPARK_REPRO_SCRIPTED_PROVIDER_LEDGER: providerLedgerPath,
    SPARK_REPRO_FORGE_LEDGER: forgeLedgerPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOST: "127.0.0.1",
    PORT: String(port),
    SPARK_HUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
  } satisfies NodeJS.ProcessEnv;
  return {
    temporary,
    workspace,
    sourceRepo,
    managedWorktree,
    sparkHome,
    daemonDbPath: resolve(sparkHome, "apps/daemon/data/daemon.sqlite"),
    daemonSocketPath: resolve(sparkHome, "apps/daemon/run/daemon.sock"),
    providerLedgerPath,
    forgeLedgerPath,
    target: {
      command: resolve(root, "apps/spark-cli/bin/spark"),
      cwd: workspace,
      env,
      timeoutMs: 120_000,
    },
    port,
  };
}

function createJourneyRounds(input: { workspace: string; privateKey: KeyObject }): ScriptedRound[] {
  const rounds: ScriptedRound[] = [];
  let evidenceIndex = 1;
  const stepProofRefs = new Map<string, string>();
  const tool = (label: string, name: string, arguments_: Record<string, unknown>, id = label) =>
    rounds.push({ label, toolCalls: [{ id, name, arguments: arguments_ }] });
  const text = (label: string, value: string) => rounds.push({ label, text: value });
  const evidence = (label: string, body: Record<string, unknown>) => {
    evidenceIndex += 1;
    tool(label, "evidence", {
      action: "record",
      kind: "record",
      title: label,
      format: "json",
      body,
      provenance: { producer: "task" },
    });
    return evidenceIndex;
  };
  const evidenceRef = (index: number) => `\${EVIDENCE_REF_${index}}`;

  tool("repro.start", "repro", {
    action: "start",
    reproId: "${REPRO_ID}",
    difficulty: 5,
    objective:
      "Align the target normalization behavior with the runnable reference and deliver a validated Draft PR.",
  });
  text("initial-turn.complete", "Repro started; the daemon-owned Loop will continue the Journey.");

  const contractSteps = minimalStageSteps("contract");
  const plannedContractSteps = contractSteps.map((step) =>
    step.authority === "ask_decision" && step.id !== "baseline-construction-strategy-approved"
      ? {
          ...step,
          authority: "safe_local" as const,
          evidenceRequired: ["At least one inspectable evidence ref"],
        }
      : step,
  );
  tool("repro.plan", "repro", {
    action: "plan",
    difficulty: 5,
    reason: "Freeze the immutable minimal-alignment Journey contract.",
    goalContract: {
      objective:
        "Align the target normalization behavior with the runnable reference and deliver a validated Draft PR.",
      constraints: [
        "Expected outputs come only from immutable test-vectors.json.",
        "Only target/normalize.mjs may change.",
        "Delivery must remain a Draft PR.",
      ],
      nonGoals: ["live model inference", "real GitHub writes"],
      successCriteria: [
        "reference passes",
        "target fails before repair and passes after repair",
        "one commit and one Draft PR",
      ],
      evidenceRequired: ["command receipts", "Git Artifact", "canonical Ask receipt"],
    },
    steps: plannedContractSteps,
  });

  const askStep = contractSteps.find(
    (step) => step.id === "baseline-construction-strategy-approved",
  )!;
  const askBinding = encodeReproStepAskBinding({
    schema: "spark.repro.step-ask/v1",
    planRevision: 3,
    stepId: askStep.id,
    definitionDigest: stepDefinitionDigest(askStep),
    doneWhen: askStep.doneWhen,
    authority: "ask_decision",
  });
  tool(
    "decision.requested",
    "ask",
    {
      action: "ask",
      delivery: "async",
      mode: "decision",
      flow: "repro-golden-journey-repair",
      title: "Approve localized target repair",
      context: askBinding,
      recordAsEvidence: false,
      questions: [
        {
          id: "decision",
          type: "single",
          required: true,
          prompt: "Apply the localized normalization repair to the target implementation?",
          options: [
            { value: "approve", label: "Approve repair" },
            { value: "stop", label: "Stop" },
          ],
        },
      ],
    },
    "journey-decision",
  );
  tool("decision.waiting", "repro", {
    action: "settle",
    reason: "Wait for the canonical repair decision without further model rounds.",
  });
  text("decision.waiting.complete", "Waiting for the canonical decision.");

  tool(
    "decision.replayed",
    "ask",
    {
      action: "ask",
      delivery: "blocking",
      timeoutMs: 30_000,
      mode: "decision",
      flow: "repro-golden-journey-repair",
      title: "Approve localized target repair",
      context: askBinding,
      recordAsEvidence: true,
      questions: [
        {
          id: "decision",
          type: "single",
          required: true,
          prompt: "Apply the localized normalization repair to the target implementation?",
          options: [
            { value: "approve", label: "Approve repair" },
            { value: "stop", label: "Stop" },
          ],
        },
      ],
    },
    "journey-decision",
  );
  tool("decision.evidence.list", "evidence", {
    action: "list",
    kind: "record",
    producer: "ask",
    includeRaw: true,
    view: "summary",
    limit: 10,
  });
  const askEvidenceRef = evidenceRef(1);
  stepProofRefs.set(askStep.id, askEvidenceRef);
  tool("decision.step.done", "repro", {
    action: "step",
    stepId: askStep.id,
    stepStatus: "done",
    stepEvidenceRefs: [askEvidenceRef],
  });
  for (const requirement of DEFAULT_REPRO_STAGES[0]!.acceptance.filter(
    (candidate) => candidate.kind === "decision",
  )) {
    tool(`decision.record.${requirement.id}`, "repro", {
      action: "record",
      requirementId: requirement.id,
      proof: {
        kind: "decision",
        decisionRef: askEvidenceRef,
        selectedValue: "approve",
        rationale: "The user approved the localized target-only repair.",
      },
    });
  }

  tool("git_change.created", "git", {
    action: "init",
    repositoryPath: "${SOURCE_REPO}",
    branch: "fix/minimal-normalization",
    trunk: "main",
    title: "Fix minimal normalization alignment",
  });
  tool("validation.reference", "cue_exec", {
    command: "node verify.mjs reference",
    cwd: "${MANAGED_WORKTREE}",
    timeout: 30,
  });
  tool("validation.failed_before_fix", "cue_exec", {
    command: "node verify.mjs target",
    cwd: "${MANAGED_WORKTREE}",
    timeout: 30,
  });

  completeStage(rounds, "contract", evidence, evidenceRef, tool, {
    askRequirementId: askStep.id,
    observation:
      "Frozen contract, runnable reference, and expected failing target baseline observed.",
    stepProofRefs,
  });
  tool("stage.contract.advance", "repro", { action: "advance" });

  completeStage(rounds, "reference", evidence, evidenceRef, tool, {
    observation: "The zero-dependency reference verifier passed.",
    stepProofRefs,
  });
  tool("stage.reference.advance", "repro", { action: "advance" });

  completeStage(rounds, "target", evidence, evidenceRef, tool, {
    observation: "The target probe produced the contractually expected pre-repair failure.",
    stepProofRefs,
  });
  tool("stage.target.evaluate", "repro", { action: "evaluate" });
  tool("stage.target.advance", "repro", { action: "advance" });

  tool("mode.execute", "mode", {
    action: "execute",
    focus: "Apply the already-approved target-only normalization repair.",
  });
  tool("repair.applied", "edit", {
    artifactRef: "${ARTIFACT_REF_1}",
    path: "target/normalize.mjs",
    edits: [
      {
        oldText: "  const denominator = variance + epsilon;",
        newText: "  const denominator = Math.sqrt(variance + epsilon);",
      },
    ],
  });
  tool("validation.passed_after_fix", "cue_exec", {
    command: "node verify.mjs target",
    cwd: "${MANAGED_WORKTREE}",
    timeout: 30,
  });
  tool("validation.target-scale", "cue_exec", {
    command:
      "node -e \"const{execFileSync}=require('node:child_process');for(let i=0;i<100;i++)execFileSync(process.execPath,['verify.mjs','target'],{stdio:'ignore'});console.log('PASS target 100 repetitions')\"",
    cwd: "${MANAGED_WORKTREE}",
    timeout: 60,
  });
  completeStage(rounds, "alignment", evidence, evidenceRef, tool, {
    observation: "The repaired target passed once and across 100 deterministic repetitions.",
    stepProofRefs,
  });
  tool("stage.alignment.evaluate", "repro", { action: "evaluate" });
  tool("stage.alignment.advance", "repro", { action: "advance" });

  tool("git_change.committed", "git", {
    action: "commit",
    artifactRef: "${ARTIFACT_REF_1}",
    message: "fix: align minimal normalization",
    paths: ["target/normalize.mjs"],
    tracked: false,
  });
  tool("pull_request.submitted", "git", {
    action: "submit",
    artifactRef: "${ARTIFACT_REF_1}",
    ready: false,
  });
  completeStage(rounds, "delivery", evidence, evidenceRef, tool, {
    observation: "One target-only commit and one Draft PR were created by the GitChange owner.",
    stepProofRefs,
  });
  tool("stage.delivery.evaluate", "repro", { action: "evaluate" });

  const currentPlanSteps = [
    ...plannedContractSteps,
    ...DEFAULT_REPRO_STAGES.slice(1).flatMap((stage) => minimalStageSteps(stage.name)),
  ];
  const formalOwnerStep = currentPlanSteps.find((step) => step.id === "no-runtime-patches");
  assert.ok(formalOwnerStep);
  const profile = goldenJourneyProfile();
  const formalEvidenceRefs = formalGateSpecs.map((gate) => {
    const index = evidence(
      `formal-evidence.${gate.id}`,
      createFormalAttestation({
        workspace: input.workspace,
        privateKey: input.privateKey,
        requirementId: gate.id,
        step: formalOwnerStep,
        profile,
      }),
    );
    return evidenceRef(index);
  });

  // The final plan revision rebases the durable Normative cursor. Re-run the
  // already-passing StepVerifiers in current plan order so each exact step is
  // retired by owner state instead of being trusted from a legacy summary.
  // Complete each bound Task through the canonical Task owner on the same
  // evidence before projecting the strict completion summary.
  for (const step of currentPlanSteps) {
    const proofRef = stepProofRefs.get(step.id);
    if (!proofRef) throw new Error(`Missing Golden Journey StepVerifier proof: ${step.id}`);
    const taskRef = goldenJourneyTaskRef(step.id);
    const verificationRefs =
      step.id === formalOwnerStep.id ? [proofRef, ...formalEvidenceRefs] : [proofRef];
    tool(`task.${step.id}.claim`, "task_write", {
      action: "claim",
      taskRef,
    });
    tool(`task.${step.id}.plan.complete`, "task_write", {
      action: "plan_update",
      scope: "task",
      taskRef,
      ops: [
        { op: "done", id: "item-1", evidenceRefs: verificationRefs },
        { op: "done", id: "item-2", evidenceRefs: verificationRefs },
      ],
    });
    tool(`task.${step.id}.finish`, "task_write", {
      action: "finish",
      taskRef,
      status: "done",
      summary: `Golden Journey verified ${step.id} through current owner evidence.`,
      evidenceRefs: verificationRefs,
    });
    tool(`retirement.${step.id}`, "repro", {
      action: "step",
      stepId: step.id,
      stepStatus: "done",
      stepEvidenceRefs: verificationRefs,
    });
  }

  const laneEvidenceRef = formalEvidenceRefs[3]!;
  const laneWorkItemId = "work:minimal-normalization";
  const candidateRevision = "commit:candidate-minimal-normalization";
  const canonicalRevision = "commit:formalized-minimal-normalization";
  tool("three-lane.work.registered", "repro", {
    action: "work_register",
    laneInput: {
      lane: "implementation",
      workItemId: laneWorkItemId,
      title: "Align the minimal normalization boundary",
      scope: "target normalization boundary",
      planRevision: 8,
      sourceRevision: candidateRevision,
      status: "completed",
      gitChangeRef: "${ARTIFACT_REF_1}",
      evidenceRefs: [laneEvidenceRef],
    },
  });
  tool("three-lane.handoff.implementation-exactness", "repro", {
    action: "handoff_record",
    laneInput: {
      handoffId: "handoff:minimal-implementation-exactness",
      workItemId: laneWorkItemId,
      from: "implementation",
      to: "exactness",
      planRevision: 8,
      sourceRevision: candidateRevision,
      scope: "Classify the first failing normalization boundary",
      evidenceRefs: [laneEvidenceRef],
      candidateRevisions: [candidateRevision],
      doneWhen: ["The first bad boundary is confirmed"],
      status: "accepted",
    },
  });
  tool("three-lane.finding.recorded", "repro", {
    action: "finding_record",
    laneInput: {
      findingId: "finding:minimal-normalization-boundary",
      workItemId: laneWorkItemId,
      firstBadBoundary: "target.normalize.output",
      classification: "implementation_defect",
      disposition: "fix",
      confidence: "confirmed",
      evidenceRefs: [laneEvidenceRef],
    },
  });
  tool("three-lane.formalize.bound", "repro", {
    action: "formalize_bind",
    laneInput: { gitChangeRef: "${ARTIFACT_REF_1}" },
  });
  tool("three-lane.handoff.exactness-formalize", "repro", {
    action: "handoff_record",
    laneInput: {
      handoffId: "handoff:minimal-exactness-formalize",
      workItemId: laneWorkItemId,
      from: "exactness",
      to: "formalize",
      planRevision: 8,
      sourceRevision: candidateRevision,
      scope: "Accept the verified normalization repair",
      findingIds: ["finding:minimal-normalization-boundary"],
      evidenceRefs: [laneEvidenceRef],
      candidateRevisions: [candidateRevision],
      dependsOnHandoffIds: ["handoff:minimal-implementation-exactness"],
      doneWhen: ["The canonical stack accepts the repair"],
      status: "accepted",
    },
  });
  const formalResolution = {
    resolutionId: "resolution:minimal-formalize-exactness",
    workItemId: laneWorkItemId,
    from: "formalize",
    to: "exactness",
    status: "resolved",
    canonicalRevision,
    supersededRevisions: [candidateRevision],
    evidenceRefs: [laneEvidenceRef],
  };
  tool("three-lane.resolution.formalize-exactness", "repro", {
    action: "resolution_record",
    laneInput: formalResolution,
  });
  tool("three-lane.resolution.formalize-exactness.duplicate", "repro", {
    action: "resolution_record",
    laneInput: formalResolution,
  });
  tool("three-lane.resolution.exactness-implementation", "repro", {
    action: "resolution_record",
    laneInput: {
      resolutionId: "resolution:minimal-exactness-implementation",
      workItemId: laneWorkItemId,
      from: "exactness",
      to: "implementation",
      status: "superseded",
      canonicalRevision,
      supersededRevisions: [candidateRevision],
      evidenceRefs: [laneEvidenceRef],
      parentResolutionId: formalResolution.resolutionId,
    },
  });
  tool("three-lane.resolution.replayed-idempotently", "repro", {
    action: "resolution_record",
    laneInput: formalResolution,
  });

  tool("report.projected", "repro", {
    action: "project_report",
    workSummary: completeWorkSummary({
      currentPlanSteps,
      stepProofRefs,
      formalEvidenceRefs,
      profile,
    }),
  });
  tool("report.synced", "repro", { action: "sync_report" });
  tool("report.synced.idempotent", "repro", { action: "sync_report" });
  tool("repro.completed", "repro", { action: "advance" });
  text("journey.complete", "The Repro Golden Journey completed through trusted owner state.");
  return rounds;
}

function completeStage(
  _rounds: ScriptedRound[],
  stageName: (typeof DEFAULT_REPRO_STAGES)[number]["name"],
  evidence: (label: string, body: Record<string, unknown>) => number,
  evidenceRef: (index: number) => string,
  tool: (label: string, name: string, arguments_: Record<string, unknown>, id?: string) => void,
  options: {
    askRequirementId?: string;
    observation: string;
    stepProofRefs: Map<string, string>;
  },
): void {
  const stage = DEFAULT_REPRO_STAGES.find((candidate) => candidate.name === stageName)!;
  for (const requirement of stage.acceptance) {
    if (requirement.id === options.askRequirementId) continue;
    const baseStep = minimalStageSteps(stageName).find(
      (candidate) => candidate.id === requirement.id,
    );
    if (!baseStep) throw new Error(`Missing minimal ${stageName} step ${requirement.id}`);
    const step =
      requirement.kind === "decision"
        ? {
            ...baseStep,
            authority: "safe_local" as const,
            evidenceRequired: ["At least one inspectable evidence ref"],
          }
        : baseStep;
    const planRevision =
      stageName === "contract"
        ? requirement.kind === "decision"
          ? 4
          : 3
        : { reference: 5, target: 6, alignment: 7, delivery: 8 }[stageName];
    const index = evidence(`evidence.${stageName}.${requirement.id}`, {
      schema: "spark.repro.step-proof/v1",
      planRevision,
      stepId: step.id,
      definitionDigest: stepDefinitionDigest(step),
      proofKind: "evidence",
      passed: true,
      doneWhen: step.doneWhen,
      observation: options.observation,
    });
    const ref = evidenceRef(index);
    options.stepProofRefs.set(step.id, ref);
    tool(`step.${stageName}.${requirement.id}.done`, "repro", {
      action: "step",
      stepId: requirement.id,
      stepStatus: "done",
      stepEvidenceRefs: [ref],
    });
    if (requirement.kind === "decision") continue;
    tool(`requirement.${stageName}.${requirement.id}.record`, "repro", {
      action: "record",
      requirementId: requirement.id,
      proof:
        requirement.kind === "validation"
          ? {
              kind: "validation",
              command: `Golden Journey ${stageName} validation`,
              resultRef: ref,
              passed: true,
            }
          : { kind: "evidence", evidenceRefs: [ref] },
    });
  }
}

function minimalStageSteps(
  stage: (typeof DEFAULT_REPRO_STAGES)[number]["name"],
): SparkReproStepDefinition[] {
  const acceptanceIds = new Set(
    DEFAULT_REPRO_STAGES.find((candidate) => candidate.name === stage)!.acceptance.map(
      (requirement) => requirement.id,
    ),
  );
  return reproStageBlueprint(stage)
    .tasks.filter((task) => acceptanceIds.has(task.id))
    .map((task) => ({
      id: task.id,
      stage,
      goal: task.goal,
      doneWhen: [...task.doneWhen],
      evidenceRequired: [...task.evidenceRequired],
      authority: task.authority,
      ...(task.dependsOn.some((dependency) => acceptanceIds.has(dependency))
        ? { dependsOn: task.dependsOn.filter((dependency) => acceptanceIds.has(dependency)) }
        : {}),
    }));
}

function goldenJourneyTaskRef(stepId: string): string {
  const taskIds = DEFAULT_REPRO_STAGES.flatMap((stage) =>
    stage.acceptance.map((requirement) => requirement.id),
  );
  const index = taskIds.indexOf(stepId);
  if (index < 0) throw new Error(`Missing Golden Journey task placeholder: ${stepId}`);
  return `\${TASK_REF_${index + 1}}`;
}

function goldenJourneyProfile(): SparkReproProfile {
  const topology = {
    dp: 1,
    tp: 1,
    pp: 1,
    ep: 1,
    etp: 1,
    cp: 1,
    sp: false,
    worldSize: 1,
    strategies: [],
  };
  return {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    modelScope: "minimum_complete",
    computeScope: "optimizer",
    steps: { completed: 100, target: 100 },
    topology,
    validationTopology: structuredClone(topology),
    runtime: {
      framework: "node",
      device: "cpu",
      dtype: "float64",
      hardware: "deterministic-fixture",
      modelRevision: "minimal-alignment-v1",
      configDigest: "sha256:minimal-alignment-v1",
    },
  };
}

function createFormalAttestation(input: {
  workspace: string;
  privateKey: KeyObject;
  requirementId: string;
  step: SparkReproStepDefinition;
  profile: SparkReproProfile;
}): SparkReproFormalEvidenceAttestation {
  const topology = input.profile.validationTopology ?? input.profile.topology;
  const unsigned = {
    schema: "spark.repro.formal-evidence-attestation/v1" as const,
    verifierId: formalVerifierId,
    verifierVersion: formalVerifierVersion,
    verifiedAt: "2026-08-10T00:00:00.000Z",
    binding: {
      workspaceCwd: input.workspace,
      reproId,
      requirementId: input.requirementId,
      stepId: input.step.id,
      planRevision: 8,
      stepDefinitionDigest: stepDefinitionDigest(input.step),
      invocationClass: "owning_entrypoint" as const,
      evidenceClass: "entrypoint" as const,
      profileDigest: sparkReproProfileDigest(input.profile),
      topologyDigest: sparkReproTopologyDigest(topology),
    },
    verdict: "accepted" as const,
    resultDigest: sha256(
      JSON.stringify({ fixture: "minimal-alignment", requirementId: input.requirementId }),
    ),
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(sparkReproFormalEvidenceAttestationPayload(unsigned)),
      input.privateKey,
    ).toString("base64"),
  };
}

function completeWorkSummary(input: {
  currentPlanSteps: SparkReproStepDefinition[];
  stepProofRefs: ReadonlyMap<string, string>;
  formalEvidenceRefs: string[];
  profile: SparkReproProfile;
}): Record<string, unknown> {
  const { currentPlanSteps, formalEvidenceRefs, profile } = input;
  const topology = profile.validationTopology ?? profile.topology;
  const profileDigest = sparkReproProfileDigest(profile);
  const taskIds = DEFAULT_REPRO_STAGES.flatMap((stage) =>
    stage.acceptance.map((requirement) => requirement.id),
  );
  const evidenceRefsForStep = (step: SparkReproStepDefinition): string[] => {
    const proofRef = input.stepProofRefs.get(step.id);
    if (!proofRef) throw new Error(`Missing Golden Journey proof ref: ${step.id}`);
    return step.id === "no-runtime-patches" ? [proofRef, ...formalEvidenceRefs] : [proofRef];
  };
  const candidates = currentPlanSteps.map((step) => ({
    id: `candidate:${step.id}`,
    stepId: step.id,
    dependsOn: [...(step.dependsOn ?? [])],
    planRevision: 8,
    stepDefinitionDigest: stepDefinitionDigest(step),
    verdict: "accepted",
    profile,
    evidenceRefs: evidenceRefsForStep(step),
    unresolvedIds: [],
  }));
  const gates = formalGateSpecs.map((gate, index) => ({
    id: gate.id,
    title: gate.id,
    stage: gate.stage,
    evidenceClass: "formal",
    status: "accepted",
    weight: 1,
    evidenceRefs: [formalEvidenceRefs[index]!],
    ...(gate.establishes.length > 0 ? { establishes: [...gate.establishes] } : {}),
    ...(gate.stage === "reference" || gate.stage === "target" || gate.stage === "alignment"
      ? { profile }
      : {}),
  }));
  return {
    schema: "spark.repro.work-summary/v2",
    reproId: "${REPRO_ID}",
    title: "Minimal normalization Golden Journey",
    stage: "delivery",
    target: {
      model: "minimum_complete",
      requiredSteps: 100,
      referenceStrategies: [],
      validationTopology: topology,
      acceptanceProfile: profile,
    },
    profile,
    artifactRefs: ["${ARTIFACT_REF_1}"],
    gates,
    validationMatrix: {
      denominators: { contract: 1, reference: 1, target: 1, alignment: 1, delivery: 1 },
      rows: formalGateSpecs.map((gate, index) => ({
        id: `entrypoint:${gate.id}`,
        gateId: gate.id,
        stage: gate.stage,
        invocationClass: "owning_entrypoint",
        evidenceClass: "entrypoint",
        ownerStepId: "no-runtime-patches",
        verdict: "accepted",
        profile,
        repetitions: gate.stage === "alignment" ? 100 : 1,
        exactScope: "immutable minimal-alignment owner entrypoint",
        evidenceRefs: [formalEvidenceRefs[index]!],
        artifactRefs: [],
      })),
    },
    exploreFrontier: {
      stage: "delivery",
      profile,
      planRevision: 8,
      evidenceRefs: [],
      unresolvedIds: [],
    },
    normativeCursor: {
      planRevision: 8,
      orderedStepIds: currentPlanSteps.map((step) => step.id),
      stepDefinitionDigests: Object.fromEntries(
        currentPlanSteps.map((step) => [step.id, stepDefinitionDigest(step)]),
      ),
      stepDependencies: Object.fromEntries(
        currentPlanSteps.map((step) => [step.id, [...(step.dependsOn ?? [])]]),
      ),
      retiredStepIds: currentPlanSteps.map((step) => step.id),
      candidateBuffer: candidates,
      retirementLog: currentPlanSteps.map((step) => ({
        stepId: step.id,
        candidateId: `candidate:${step.id}`,
        planRevision: 8,
        stepDefinitionDigest: stepDefinitionDigest(step),
        profile,
        profileDigest,
        evidenceRefs: evidenceRefsForStep(step),
      })),
    },
    schedulerActivity: "sealed",
    independentReadyCount: 0,
    tasks: taskIds.map((id) => {
      const step = currentPlanSteps.find((candidate) => candidate.id === id);
      if (!step) throw new Error(`Missing Golden Journey task binding: ${id}`);
      return {
        id,
        taskRef: goldenJourneyTaskRef(id),
        title: step.goal,
        stage: step.stage,
        status: "done",
      };
    }),
    retirementBlocks: [],
    unresolved: [],
    nextAction: {
      id: "sealed",
      summary: "No further action",
      passCriterion: "The trusted daemon keeps the completed Workbench sealed",
    },
    conclusions: [
      {
        id: "target-aligned",
        claim: "The localized target repair matches all immutable fixture vectors.",
        verdict: "confirmed",
        profile,
        evidenceRefs: [formalEvidenceRefs[3]!],
      },
    ],
  };
}

function assertThreeLaneRecoveryState(repro: Record<string, unknown>): void {
  assert.equal(numberField(repro, "version"), 8);
  const threeLane = objectField(repro, "threeLane");
  assert.equal(stringField(threeLane, "schema"), "spark.repro.three-lane-session/v1");
  assert.deepEqual(
    arrayField(threeLane, "workItems").map((item) => stringField(item, "workItemId")),
    ["work:minimal-normalization"],
  );
  assert.deepEqual(
    arrayField(threeLane, "handoffs").map((handoff) => stringField(handoff, "handoffId")),
    ["handoff:minimal-implementation-exactness", "handoff:minimal-exactness-formalize"],
  );
  assert.deepEqual(
    arrayField(threeLane, "resolutions").map((resolution) =>
      stringField(resolution, "resolutionId"),
    ),
    ["resolution:minimal-formalize-exactness", "resolution:minimal-exactness-implementation"],
  );
  assert.equal(
    stringField(objectField(threeLane, "formalize"), "formalizedTip"),
    "commit:formalized-minimal-normalization",
  );
}

function assertThreeLaneProjection(lanes: Record<string, unknown>): void {
  for (const lane of ["implementation", "exactness", "formalize"] as const) {
    const projected = objectField(lanes, lane);
    assert.equal(stringField(projected, "status"), "complete");
    assert.equal(numberField(projected, "totalCount"), 1);
    assert.equal(arrayField(projected, "items").length, 1);
  }
  assert.equal(stringField(lanes, "formalizedTip"), "commit:formalized-minimal-normalization");
  assert.ok(!JSON.stringify(lanes).includes("target normalization boundary"));
}

function assertThreeLaneWorkSummary(work: Record<string, unknown>): void {
  const lanes = objectField(work, "lanes");
  assert.deepEqual(stringArrayField(objectField(lanes, "implementation"), "workItemIds"), [
    "work:minimal-normalization",
  ]);
  assert.deepEqual(stringArrayField(objectField(lanes, "exactness"), "workItemIds"), [
    "work:minimal-normalization",
  ]);
  assert.deepEqual(stringArrayField(objectField(lanes, "formalize"), "workItemIds"), [
    "work:minimal-normalization",
  ]);
  assert.equal(
    stringField(objectField(lanes, "formalize"), "formalizedTip"),
    "commit:formalized-minimal-normalization",
  );
  assert.equal(arrayField(work, "workItems").length, 1);
  assert.equal(arrayField(work, "findings").length, 1);
  assert.equal(arrayField(work, "handoffs").length, 2);
  assert.equal(arrayField(work, "resolutions").length, 2);
}

async function sessionToolErrorIds(sparkHome: string, sessionId: string): Promise<string[]> {
  const sessionsRoot = resolve(sparkHome, "apps/daemon/data/pi-agent/sessions");
  const relativePaths = await readdir(sessionsRoot, { recursive: true });
  const transcript = relativePaths.find((path) => path.endsWith(`/${sessionId}.jsonl`));
  assert.ok(transcript, `missing daemon session transcript for ${sessionId}`);
  const lines = (await readFile(resolve(sessionsRoot, transcript), "utf8"))
    .split("\n")
    .filter(Boolean);
  const toolErrorIds: string[] = [];
  for (const line of lines) {
    const entry = JSON.parse(line) as {
      type?: unknown;
      message?: { role?: unknown; toolCallId?: unknown; isError?: unknown };
    };
    if (
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.isError === true
    ) {
      assert.equal(typeof entry.message.toolCallId, "string");
      toolErrorIds.push(entry.message.toolCallId as string);
    }
  }
  return toolErrorIds;
}

async function assertClosedDriverRetention(sparkHome: string, daemonDbPath: string): Promise<void> {
  const registryPath = resolve(sparkHome, "session-registry/v1/registry.json");
  const drivers = await waitFor(
    async () => {
      const registry = jsonObject(await readFile(registryPath, "utf8"));
      const sessions = arrayField(registry, "sessions");
      const candidates = sessions.filter((session) => {
        const owner = objectField(session, "owner");
        return owner.kind === "driver" && session.retention === "discard_on_close";
      });
      if (candidates.length === 0 || candidates.some((session) => session.lifecycle !== "closed")) {
        return undefined;
      }
      return candidates;
    },
    60_000,
    "closed driver Session retention",
  );

  const sessionIds = drivers.map((session) => stringField(session, "sessionId"));
  for (const session of drivers) {
    assert.equal(session.transcriptRef, undefined);
    assert.ok(arrayField(session, "closeReceipts").length > 0);
  }

  const db = new DatabaseSync(daemonDbPath, { readOnly: true });
  try {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT i.session_id AS sessionId,
                i.prompt,
                i.task_json AS taskJson,
                i.result_json AS resultJson,
                i.error_message AS errorMessage,
                i.payload_redacted_at AS payloadRedactedAt,
                (SELECT COUNT(*) FROM invocation_events e WHERE e.invocation_id = i.id) AS eventCount,
                (SELECT COUNT(*) FROM invocation_events e
                 WHERE e.invocation_id = i.id AND e.kind = 'invocation.receipt_context') AS receiptCount
         FROM invocations i
         WHERE i.session_id IN (${placeholders})`,
      )
      .all(...sessionIds) as unknown as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.prompt, null);
      assert.equal(row.taskJson, null);
      assert.equal(row.resultJson, null);
      assert.equal(row.errorMessage, null);
      assert.equal(typeof row.payloadRedactedAt, "string");
      assert.equal(row.eventCount, 1);
      assert.equal(row.receiptCount, 1);
    }
  } finally {
    db.close();
  }
}

function seedHubEnrollment(sparkHome: string): string {
  const previous = process.env.SPARK_HOME;
  process.env.SPARK_HOME = sparkHome;
  try {
    const db = openDatabase({ path: defaultDatabasePath() });
    try {
      migrate(db);
      return createRuntimeEnrollmentToken(db, {
        label: "Repro Golden Journey",
        workspaceName: "Repro Golden Journey",
        workspaceSlug: "repro-golden-journey",
        ttlMs: 10 * 60 * 1000,
      }).refreshToken;
    } finally {
      db.close();
    }
  } finally {
    if (previous === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previous;
  }
}

async function waitForInvocation(
  target: SparkProcessTarget,
  invocationId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  const result = await waitFor(
    async () => {
      const result = jsonObject(
        (await runSparkProcess(target, ["daemon", "invocation", "result", invocationId, "--json"]))
          .stdout,
      );
      return result.status === "succeeded" ||
        result.status === "failed" ||
        result.status === "cancelled"
        ? result
        : undefined;
    },
    60_000,
    `invocation ${invocationId} to become terminal`,
  );
  if (result.status !== expected) {
    throw new Error(
      `Invocation ${invocationId} became ${String(result.status)}, expected ${expected}: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function waitForSinglePendingAsk(
  target: SparkProcessTarget,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return await waitFor(
    async () => {
      const value = jsonObject(
        (await runSparkProcess(target, ["daemon", "ask", "list", "--session", sessionId, "--json"]))
          .stdout,
      );
      const interactions = arrayField(value, "waits");
      return interactions.length === 1 ? interactions[0] : undefined;
    },
    90_000,
    "one pending canonical Ask",
  );
}

async function waitForReproCompleteWithApprovals(
  path: string,
  target: SparkProcessTarget,
  sessionId: string,
): Promise<{ repro: Record<string, unknown>; toolApprovalCount: number }> {
  const answered = new Set<string>();
  return await waitFor(
    async () => {
      try {
        const snapshot = jsonObject(await readFile(path, "utf8"));
        const repro = objectField(snapshot, "repro");
        if (repro.status === "complete") {
          return { repro, toolApprovalCount: answered.size };
        }
      } catch {
        // The Repro snapshot may not exist until the first owner write commits.
      }
      const pending = jsonObject(
        (await runSparkProcess(target, ["daemon", "ask", "list", "--session", sessionId, "--json"]))
          .stdout,
      );
      for (const wait of arrayField(pending, "waits")) {
        const requestId = stringField(wait, "interactionRequestId");
        const context = objectField(wait, "context");
        if (context.interactionKind !== "toolApproval" || answered.has(requestId)) continue;
        const result = jsonObject(
          (
            await runSparkProcess(target, [
              "daemon",
              "ask",
              "answer",
              requestId,
              "--session",
              sessionId,
              "--answers",
              JSON.stringify({ approval: { values: ["approve"], labels: ["Approve"] } }),
              "--json",
            ])
          ).stdout,
        );
        assert.equal(result.outcome, "accepted");
        answered.add(requestId);
      }
      return undefined;
    },
    120_000,
    "Repro completion",
  );
}

async function waitForTerminalOwnerState(dbPath: string, id: string) {
  return await waitFor(
    async () => {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const pendingAskCount = numberResult(
            db
              .prepare("SELECT COUNT(*) AS count FROM daemon_human_waits WHERE status = 'pending'")
              .get(),
          );
          const canonicalDecisionRequestCount = numberResult(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM daemon_human_waits WHERE json_extract(request_json, '$.context.interactionKind') = 'askFlow'",
              )
              .get(),
          );
          const toolApprovalRequestCount = numberResult(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM daemon_human_waits WHERE json_extract(request_json, '$.context.interactionKind') = 'toolApproval'",
              )
              .get(),
          );
          const activeInvocationCount = numberResult(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM invocations WHERE status IN ('queued', 'running')",
              )
              .get(),
          );
          const binding = db
            .prepare("SELECT lifecycle FROM workbench_artifact_bindings WHERE repro_id = ?")
            .get(id) as { lifecycle?: string } | undefined;
          const writableWorkbenchCount = numberResult(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM workbench_artifact_bindings WHERE lifecycle <> 'sealed'",
              )
              .get(),
          );
          const formalEvidenceReceiptCount = numberResult(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM daemon_repro_formal_evidence_receipts WHERE repro_id = ?",
              )
              .get(id),
          );
          if (
            pendingAskCount === 0 &&
            activeInvocationCount === 0 &&
            binding?.lifecycle === "sealed" &&
            writableWorkbenchCount === 0
          ) {
            return {
              pendingAskCount,
              canonicalDecisionRequestCount,
              toolApprovalRequestCount,
              activeInvocationCount,
              workbenchLifecycle: binding.lifecycle,
              writableWorkbenchCount,
              formalEvidenceReceiptCount,
            };
          }
        } finally {
          db.close();
        }
      } catch {
        return undefined;
      }
      return undefined;
    },
    60_000,
    "terminal owner state and sealed Workbench",
  );
}

function readProcessOwnership(dbPath: string): {
  pid: number;
  processStartToken: string;
  instanceId: string;
  generation: string;
} {
  const path = resolve(dirname(dirname(dbPath)), "run/daemon.identity.json");
  return jsonObjectSync(path) as {
    pid: number;
    processStartToken: string;
    instanceId: string;
    generation: string;
  };
}

async function stopProcesses(target: SparkProcessTarget, pids: number[] = []): Promise<void> {
  await runSparkProcess(target, ["daemon", "stop", "--yes"]).catch(() => undefined);
  await runSparkProcess(target, ["hub", "web", "stop", "--json"]).catch(() => undefined);
  await Promise.all(
    pids
      .filter((pid) => pid > 0)
      .map(async (pid) => {
        await waitFor(
          async () => (isProcessAlive(pid) ? undefined : true),
          10_000,
          `process ${pid} to exit after stop`,
        );
      }),
  );
}

async function readProviderLedger(path: string): Promise<ScriptedLedger> {
  return jsonObject(await readFile(path, "utf8")) as unknown as ScriptedLedger;
}

async function waitForJsonFile(path: string): Promise<Record<string, unknown>> {
  return await waitFor(
    async () => {
      try {
        return jsonObject(await readFile(path, "utf8"));
      } catch {
        return undefined;
      }
    },
    60_000,
    path,
  );
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const detail =
    lastError instanceof Error
      ? lastError.message
      : lastError === undefined
        ? ""
        : JSON.stringify(lastError);
  throw new Error(`Timed out waiting for ${label}${detail ? `: ${detail}` : ""}`);
}

async function reservePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a TCP port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function runFixtureVerification(
  cwd: string,
  implementation: "reference" | "target",
): Promise<FixtureVerificationReceipt> {
  const command = `node verify.mjs ${implementation}`;
  try {
    const result = await execFileAsync(
      process.execPath,
      [resolve(cwd, "verify.mjs"), implementation],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
      },
    );
    return {
      command,
      exitCode: 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    const exitCode = typeof failure.code === "number" ? failure.code : Number(failure.code);
    return {
      command,
      exitCode: Number.isInteger(exitCode) ? exitCode : 1,
      stdout: failure.stdout?.trim() ?? "",
      stderr: failure.stderr?.trim() ?? "",
    };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
}

function jsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function jsonArray(value: string): Record<string, unknown>[] {
  const parsed = JSON.parse(value) as unknown;
  assert.ok(Array.isArray(parsed));
  return parsed as Record<string, unknown>[];
}

function jsonObjectSync(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${key} is an object`);
  return value as Record<string, unknown>;
}

function arrayField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  assert.ok(Array.isArray(value), `${key} is an array`);
  return value as Record<string, unknown>[];
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  assert.ok(Array.isArray(value), `${key} is an array`);
  assert.ok(
    value.every((entry) => typeof entry === "string"),
    `${key} contains strings`,
  );
  return value as string[];
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assert.equal(typeof value, "string", `${key} is a string`);
  return value as string;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  assert.equal(typeof value, "number", `${key} is a number`);
  return value as number;
}

function numberResult(value: unknown): number {
  const record = value as { count?: number } | undefined;
  return Number(record?.count ?? 0);
}

function uniqueMatches(value: string, pattern: RegExp): string[] {
  return [...new Set(value.match(pattern) ?? [])];
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
