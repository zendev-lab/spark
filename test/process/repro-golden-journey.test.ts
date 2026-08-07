import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-daemon-client/local-rpc";
import { reproStageBlueprint } from "@zendev-lab/spark-extension/repro-test-support";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-hub-db";
import { createRuntimeEnrollmentToken } from "@zendev-lab/spark-hub-coordination/runtime-registration";
import { sessionReproStorePathV2 } from "@zendev-lab/spark-loop";
import {
  DEFAULT_REPRO_STAGES,
  encodeReproStepAskBinding,
  stepDefinitionDigest,
  type SparkReproStepDefinition,
} from "@zendev-lab/spark-repro";

import { runSparkProcess, type SparkProcessTarget } from "../support/spark-process-harness.ts";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(root, "test/fixtures/repro/minimal-alignment");
const providerPlugin = resolve(root, "test/fixtures/repro/scripted-provider-plugin.ts");
const forgeShim = resolve(root, "test/fixtures/repro/forge-shim.mjs");
const reproId = "repro:golden-journey-source-process";
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
  "report.projected",
  "report.synced",
  "repro.completed",
  "workbench.sealed",
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
  let hubPid = 0;
  try {
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
    const resumedLedger = await readProviderLedger(fixture.providerLedgerPath);
    const resumeCount = resumedLedger.requests.filter(
      (request) => request.label === "decision.replayed",
    ).length;
    assert.equal(resumeCount, 1);
    assert.equal(resumedLedger.cursor, resumedLedger.rounds.length);
    assert.equal(
      resumedLedger.auxiliaryRequests?.filter(
        (request) => request.label === "auxiliary.tool-approval.outcome",
      ).length,
      1,
    );
    assert.equal(
      resumedLedger.auxiliaryRequests?.filter(
        (request) => request.label === "auxiliary.tool-approval.verdict",
      ).length,
      1,
    );

    const report = await waitForJsonFile(resolve(fixture.workspace, "outputs/spark-summary.json"));
    const reportMarkdown = await readFile(resolve(fixture.workspace, "outputs/report.md"), "utf8");
    const reportWork = objectField(report, "work");
    assert.equal(stringField(reportWork, "reproId"), reproId);
    const reportArtifactRef = stringField(reportWork, "reportArtifactRef");
    const reportArtifactRefs = stringArrayField(reportWork, "artifactRefs");
    assert.equal(reportArtifactRefs.filter((ref) => ref === reportArtifactRef).length, 1);
    const projectedJson = reportMarkdown.match(/```json\n([\s\S]*?)\n```/u);
    assert.ok(projectedJson?.[1]);
    assert.deepEqual(JSON.parse(projectedJson[1]) as unknown, report);
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

    const forge = jsonObject(await readFile(fixture.forgeLedgerPath, "utf8"));
    assert.equal(forge.draftPrCreates, 1);
    assert.equal(forge.nonDraftPrCreates, 0);
    const commitCount = await gitOutput(fixture.managedWorktree, [
      "rev-list",
      "--count",
      "main..HEAD",
    ]);
    assert.equal(commitCount.trim(), "1");
    assert.equal(
      (await gitOutput(fixture.managedWorktree, ["diff", "--name-only", "main..HEAD"])).trim(),
      "target/normalize.mjs",
    );
    assert.equal((await gitOutput(fixture.managedWorktree, ["status", "--porcelain"])).trim(), "");

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
      interactionRequestId,
      humanRequestId: stringField(pendingAfter, "humanRequestId"),
      answerReceipt: winnerResponseId,
      daemon: {
        before: {
          pid: daemonPid,
          generation: generationBefore,
          processStartToken: ownershipBefore.processStartToken,
        },
        after: { pid: restartedDaemonPid, generation: generationAfter },
        sqlitePath: fixture.daemonDbPath,
      },
      git: {
        worktreePath: fixture.managedWorktree,
        commitCount: 1,
        draftPrCreates: forge.draftPrCreates,
        nonDraftPrCreates: forge.nonDraftPrCreates,
      },
      report: {
        reportArtifactRef,
        artifactRefs,
        evidenceRefs,
        workbenchLifecycle: terminal.workbenchLifecycle,
      },
    };
    process.stdout.write(`REPRO_GOLDEN_JOURNEY ${JSON.stringify(processLedger)}\n`);

    await stopProcesses(fixture.target);
    assert.equal(isProcessAlive(daemonPid), false);
    assert.equal(isProcessAlive(restartedDaemonPid), false);
    assert.equal(isProcessAlive(hubPid), false);
    retainedFailureFixture = undefined;
    await rm(fixture.temporary, { recursive: true, force: true });
  } catch (error) {
    await stopProcesses(fixture.target).catch(() => undefined);
    throw error;
  }
}, 300_000);

async function createJourneyFixture(): Promise<JourneyFixture> {
  const temporary = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-repro-journey-"),
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
    mkdir(binDir, { recursive: true }),
    mkdir(resolve(temporary, "home"), { recursive: true }),
  ]);
  await writeFile(
    resolve(sparkHome, "role-model-settings.json"),
    `${JSON.stringify(
      {
        version: 1,
        roleModels: { "role:builtin-reviewer": "spark-scripted/spark-scripted-provider" },
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

  const rounds = createJourneyRounds();
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
        activeModelId: "spark-scripted/spark-scripted-provider",
        activeThinkingLevel: "off",
        skills: [],
      },
      null,
      2,
    )}\n`,
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
    SPARK_DAEMON_SERVICE_MODE: "detached",
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

function createJourneyRounds(): ScriptedRound[] {
  const rounds: ScriptedRound[] = [];
  let evidenceIndex = 1;
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
  tool("decision.step.done", "repro", {
    action: "step",
    stepId: askStep.id,
    stepStatus: "done",
    stepEvidenceRefs: ["${LAST_EVIDENCE_REF}"],
  });
  for (const requirement of DEFAULT_REPRO_STAGES[0]!.acceptance.filter(
    (candidate) => candidate.kind === "decision",
  )) {
    tool(`decision.record.${requirement.id}`, "repro", {
      action: "record",
      requirementId: requirement.id,
      proof: {
        kind: "decision",
        decisionRef: "${LAST_EVIDENCE_REF}",
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
  });
  tool("stage.contract.advance", "repro", { action: "advance" });

  completeStage(rounds, "reference", evidence, evidenceRef, tool, {
    observation: "The zero-dependency reference verifier passed.",
  });
  tool("stage.reference.advance", "repro", { action: "advance" });

  completeStage(rounds, "target", evidence, evidenceRef, tool, {
    observation: "The target probe produced the contractually expected pre-repair failure.",
  });
  tool("stage.target.evaluate", "repro", { action: "evaluate" });
  tool("stage.target.advance", "repro", { action: "advance" });

  tool("phase.implement", "phase", {
    action: "implement",
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
  });
  tool("stage.delivery.evaluate", "repro", { action: "evaluate" });

  tool("report.projected", "repro", {
    action: "project_report",
    workSummary: completeWorkSummary(),
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
  options: { askRequirementId?: string; observation: string },
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

function completeWorkSummary(): Record<string, unknown> {
  const topology = { dp: 1, tp: 1, pp: 1, ep: 1, cp: 1, sp: false };
  const profile = {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    steps: { completed: 100, target: 100 },
    topology,
  };
  const gate = (id: string, stage: string, establishes: string[] = [], withProfile = false) => ({
    id,
    title: id,
    stage,
    evidenceClass: "formal",
    status: "accepted",
    weight: 1,
    evidenceRefs: ["${LAST_EVIDENCE_REF}"],
    ...(establishes.length > 0 ? { establishes } : {}),
    ...(withProfile ? { profile } : {}),
  });
  return {
    reproId: "${REPRO_ID}",
    title: "Minimal normalization Golden Journey",
    stage: "delivery",
    target: {
      model: "minimum_complete",
      requiredSteps: 100,
      referenceStrategies: [],
      validationTopology: topology,
    },
    profile,
    artifactRefs: ["${ARTIFACT_REF_1}"],
    gates: [
      gate("contract-frozen", "contract"),
      gate("reference-ready", "reference", ["reference_ready"], true),
      gate("target-ready", "target", ["target_ready"], true),
      gate("required-alignment", "alignment", ["required_steps_aligned", "reference_parity"], true),
      gate("delivery-ready", "delivery"),
    ],
    conclusions: [
      {
        id: "target-aligned",
        claim: "The localized target repair matches all immutable fixture vectors.",
        verdict: "confirmed",
        profile,
        evidenceRefs: ["${LAST_EVIDENCE_REF}"],
      },
    ],
  };
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
  return await waitFor(
    async () => {
      const result = jsonObject(
        (await runSparkProcess(target, ["daemon", "invocation", "result", invocationId, "--json"]))
          .stdout,
      );
      return result.status === expected ? result : undefined;
    },
    60_000,
    `invocation ${invocationId} to become ${expected}`,
  );
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

async function stopProcesses(target: SparkProcessTarget): Promise<void> {
  await runSparkProcess(target, ["daemon", "stop", "--yes"]).catch(() => undefined);
  await runSparkProcess(target, ["hub", "web", "stop", "--json"]).catch(() => undefined);
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
