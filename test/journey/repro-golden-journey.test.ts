import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

import {
  defaultArtifactStore,
  type Artifact,
  type DocumentArtifactBody,
} from "@zendev-lab/spark-artifacts";
import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import {
  decodeSparkDshSessionJsonl,
  dshDocumentToSparkRecord,
} from "@zendev-lab/spark-session/transcript";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import { createRuntimeEnrollmentToken } from "@zendev-lab/spark-hub-coordination/runtime-registration";
import type { SparkSessionRepro } from "@zendev-lab/spark-repro";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

import { runSparkProcess, type SparkProcessTarget } from "../support/spark-process-harness.ts";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(root, "test/fixtures/repro/minimal-alignment");
const providerPlugin = resolve(root, "test/fixtures/repro/scripted-provider-plugin.ts");
const forgeShim = resolve(root, "test/fixtures/repro/forge-shim.mjs");

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface ScriptedRound {
  label: string;
  audience: "implementation" | "exactness" | "formalize";
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

interface ScriptedLedger {
  schema: "spark.repro.scripted-provider-ledger/v1";
  cursor: number;
  rounds: ScriptedRound[];
  requests: Array<{ round: number; label?: string; messageRoles: string[]; toolNames: string[] }>;
  auxiliaryRequests?: Array<{ label: string; messageRoles: string[]; toolNames: string[] }>;
  vars: Record<string, string>;
  cursors?: Record<string, number>;
  lastLabels?: Record<string, string>;
}

interface JourneyFixture {
  temporary: string;
  workspaceRoot: string;
  sparkHome: string;
  providerLedgerPath: string;
  forgeLedgerPath: string;
  target: SparkProcessTarget;
  port: number;
}

interface DurableSnapshot {
  repro: SparkSessionRepro;
  projection?: {
    stateUpdatedAt: string;
    reportArtifactRef: string;
    reportRevision: number;
    workbenchArtifactRef: string;
    workbenchRevision: number;
  };
}

let retainedFailureFixture: string | undefined;
const liveModelId = process.env.SPARK_REPRO_LIVE_MODEL?.trim();

afterEach(() => {
  if (retainedFailureFixture) {
    process.stderr.write(`Repro Golden Journey fixture retained at ${retainedFailureFixture}\n`);
  }
});

test("direct Repro start survives compaction and restarts across five daemon checkpoints", async () => {
  const fixture = await createJourneyFixture();
  retainedFailureFixture = fixture.temporary;
  const observedProcessPids: number[] = [];
  try {
    await assertMultiRepositoryWorkspace(fixture);
    const rootSessionId = await startRegisteredWorkspace(fixture, observedProcessPids);

    const started = await requestSparkDaemon(
      "repro.start",
      { ownerSessionId: rootSessionId, objective: "复现 glm52" },
      { env: fixture.target.env },
    );
    assert.equal(started.changed, true);

    const firstAccepted = await waitForRepro(fixture, (repro) => repro.receipts.length >= 1);
    const implementationSessionId = firstAccepted.lanes.implementation.sessionId;
    await seedLaneForCompaction(fixture, implementationSessionId);
    await compactLaneSession(fixture, implementationSessionId);
    observedProcessPids.push(await restartDaemon(fixture.target));

    const formalized = await waitForRepro(
      fixture,
      (repro) => repro.formalizedRevision === "revision:formalized",
    );
    assert.ok(formalized.receipts.length >= 3);
    assert.equal(formalized.receipts[2]?.checkpointId, formalized.checkpoints[2]?.checkpointId);
    observedProcessPids.push(await restartDaemon(fixture.target));

    const complete = await waitForRepro(
      fixture,
      (repro) => repro.status === "complete" && repro.receipts.length === 5,
    );
    await assertCompletedTopology(fixture, rootSessionId, complete);

    const beforeIdempotentRestart = await durableCounts(fixture, rootSessionId);
    const providerBefore = await readProviderLedger(fixture.providerLedgerPath);
    observedProcessPids.push(await restartDaemon(fixture.target));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    assert.deepEqual(await durableCounts(fixture, rootSessionId), beforeIdempotentRestart);
    assert.equal(
      (await readProviderLedger(fixture.providerLedgerPath)).requests.length,
      providerBefore.requests.length,
    );

    retainedFailureFixture = undefined;
  } finally {
    await stopProcesses(fixture.target, observedProcessPids);
    if (retainedFailureFixture !== fixture.temporary) {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
}, 240_000);

test("attention answer resumes the same checkpoint Session after daemon restart", async () => {
  const fixture = await createJourneyFixture(
    createJourneyRounds({ implementationAttention: true }),
  );
  retainedFailureFixture = fixture.temporary;
  const observedProcessPids: number[] = [];
  try {
    const rootSessionId = await startRegisteredWorkspace(fixture, observedProcessPids);
    await requestSparkDaemon(
      "repro.start",
      { ownerSessionId: rootSessionId, objective: "复现 glm52" },
      { env: fixture.target.env },
    );

    const waiting = await waitForRepro(fixture, (repro) => repro.status === "waiting_attention");
    const implementationSessionId = waiting.lanes.implementation.sessionId;
    const pendingBefore = await waitForSinglePendingAsk(fixture.target, rootSessionId);
    observedProcessPids.push(await restartDaemon(fixture.target));
    const pendingAfter = await waitForSinglePendingAsk(fixture.target, rootSessionId);
    assert.equal(pendingAfter.interactionRequestId, pendingBefore.interactionRequestId);
    const question = arrayField(pendingAfter, "questions")[0];
    assert.ok(question);

    const answered = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "ask",
          "answer",
          stringField(pendingAfter, "interactionRequestId"),
          "--session",
          rootSessionId,
          "--answers",
          JSON.stringify({
            [stringField(question, "id")]: {
              values: [],
              customText: "Use the official upstream GLM-5.2 implementation.",
            },
          }),
          "--json",
        ])
      ).stdout,
    );
    assert.equal(answered.outcome, "accepted");

    const complete = await waitForRepro(
      fixture,
      (repro) => repro.status === "complete" && repro.receipts.length === 5,
    );
    assert.equal(complete.lanes.implementation.sessionId, implementationSessionId);
    assert.equal(complete.checkpoints[0]?.attempt, 2);
    const graph = await defaultTaskGraphStore(fixture.workspaceRoot).load();
    assert.ok(graph);
    const implementationRuns = graph
      .runs(complete.projectRef)
      .filter((run) => run.taskRef === complete.lanes.implementation.taskRef);
    assert.equal(implementationRuns.length, 3);
    assert.equal(
      new Set(
        implementationRuns.map(
          (run) => run.execution?.sessionId ?? run.execution?.executionSessionId,
        ),
      ).size,
      1,
    );
    assert.equal((await listPendingAsks(fixture.target, rootSessionId)).length, 0);

    retainedFailureFixture = undefined;
  } finally {
    await stopProcesses(fixture.target, observedProcessPids);
    if (retainedFailureFixture !== fixture.temporary) {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
}, 240_000);

test("stop durably cancels Repro runs and closes all lane Sessions", async () => {
  const fixture = await createJourneyFixture(createJourneyRounds({ implementationDelayMs: 5_000 }));
  retainedFailureFixture = fixture.temporary;
  const observedProcessPids: number[] = [];
  try {
    const rootSessionId = await startRegisteredWorkspace(fixture, observedProcessPids);
    await requestSparkDaemon(
      "repro.start",
      { ownerSessionId: rootSessionId, objective: "复现 glm52" },
      { env: fixture.target.env },
    );
    const stoppedResponse = await requestSparkDaemon(
      "repro.stop",
      { ownerSessionId: rootSessionId, reason: "Golden Journey stop checkpoint" },
      { env: fixture.target.env },
    );
    assert.equal(stoppedResponse.changed, true);

    const stopped = readDurableSnapshot(fixture, rootSessionId).repro;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.receipts.length, 0);
    const graph = await defaultTaskGraphStore(fixture.workspaceRoot).load();
    assert.ok(graph);
    assert.equal(graph.tasks(stopped.projectRef).length, 3);
    assert.ok(graph.tasks(stopped.projectRef).every((task) => task.status === "cancelled"));
    assert.equal(graph.runs(stopped.projectRef).length, 3);
    assert.ok(graph.runs(stopped.projectRef).every((run) => run.status === "cancelled"));

    for (const lane of Object.values(stopped.lanes)) {
      const session = await requestSparkDaemon(
        "session.get",
        { sessionId: lane.sessionId },
        { env: fixture.target.env },
      );
      assert.equal(session.lifecycle, "closed");
      assert.ok((session.closeReceipts?.length ?? 0) >= 1);
    }

    observedProcessPids.push(await restartDaemon(fixture.target));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    const restarted = readDurableSnapshot(fixture, rootSessionId).repro;
    assert.equal(restarted.updatedAt, stopped.updatedAt);
    const restartedGraph = await defaultTaskGraphStore(fixture.workspaceRoot).load();
    assert.ok(restartedGraph?.runs(stopped.projectRef).every((run) => run.status === "cancelled"));

    retainedFailureFixture = undefined;
  } finally {
    await stopProcesses(fixture.target, observedProcessPids);
    if (retainedFailureFixture !== fixture.temporary) {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
}, 240_000);

test.skipIf(!liveModelId)(
  "real configured model completes a compacted multi-repository Repro",
  async () => {
    assert.ok(liveModelId);
    const fixture = await createJourneyFixture(createJourneyRounds(), { liveModelId });
    retainedFailureFixture = fixture.temporary;
    const observedProcessPids: number[] = [];
    try {
      await assertMultiRepositoryWorkspace(fixture);
      const rootSessionId = await startRegisteredWorkspace(fixture, observedProcessPids);
      await requestSparkDaemon(
        "repro.start",
        {
          ownerSessionId: rootSessionId,
          objective:
            "Reproduce the normalization behavior from repos/reference in repos/target. Inspect the two repositories and verify.mjs, make the smallest required correction, and attach strict Evidence for all five checkpoints.",
        },
        { env: fixture.target.env },
      );
      const firstAccepted = await waitForRepro(fixture, (repro) => repro.receipts.length >= 1);
      await seedLaneForCompaction(fixture, firstAccepted.lanes.implementation.sessionId);
      await compactLaneSession(fixture, firstAccepted.lanes.implementation.sessionId);
      observedProcessPids.push(await restartDaemon(fixture.target));
      const complete = await waitForRepro(
        fixture,
        (repro) => repro.status === "complete" && repro.receipts.length === 5,
      );
      await assertCompletedTopology(fixture, rootSessionId, complete, {
        expectedModel: parseModelId(liveModelId),
        scriptedProvider: false,
      });
      retainedFailureFixture = undefined;
    } finally {
      await stopProcesses(fixture.target, observedProcessPids);
      if (retainedFailureFixture !== fixture.temporary) {
        await rm(fixture.temporary, { recursive: true, force: true });
      }
    }
  },
  600_000,
);

async function assertCompletedTopology(
  fixture: JourneyFixture,
  rootSessionId: string,
  repro: SparkSessionRepro,
  options: {
    expectedModel?: { providerName: string; modelId: string };
    scriptedProvider?: boolean;
  } = {},
): Promise<void> {
  assert.equal(repro.version, 10);
  assert.equal(repro.schema, "spark.repro.session/v10");
  assert.equal(repro.objective, "复现 glm52");
  assert.equal(repro.formalizedRevision, "revision:formalized");
  assert.deepEqual(
    repro.checkpoints.map((checkpoint) => checkpoint.kind),
    ["implementation", "exactness", "formalize", "exactness_refresh", "implementation_refresh"],
  );
  assert.ok(repro.checkpoints.every((checkpoint) => checkpoint.status === "accepted"));
  assert.equal(repro.receipts.length, 5);
  assert.deepEqual(
    repro.receipts.map((receipt) => receipt.checkpointId),
    repro.checkpoints.map((checkpoint) => checkpoint.checkpointId),
  );
  assert.equal(repro.checkpoints[3]?.parentCheckpointId, repro.checkpoints[2]?.checkpointId);
  assert.equal(repro.checkpoints[4]?.parentCheckpointId, repro.checkpoints[2]?.checkpointId);

  const graph = await defaultTaskGraphStore(fixture.workspaceRoot).load();
  assert.ok(graph);
  const tasks = graph.tasks(repro.projectRef);
  const runs = graph.runs(repro.projectRef);
  assert.equal(tasks.length, 3);
  assert.equal(runs.length, 5);
  assert.ok(runs.every((run) => run.status === "succeeded"));
  const runSessionIds = runs.map(
    (run) => run.execution?.sessionId ?? run.execution?.executionSessionId,
  );
  assert.equal(new Set(runSessionIds).size, 3);
  for (const lane of Object.values(repro.lanes)) {
    const laneRuns = runs.filter((run) => run.taskRef === lane.taskRef);
    assert.equal(laneRuns.length, lane.lane === "formalize" ? 1 : 2);
    assert.deepEqual(
      new Set(runSessionIds.filter((sessionId) => sessionId === lane.sessionId)),
      new Set([lane.sessionId]),
    );
  }

  const sessions = jsonArray(
    (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"])).stdout,
  );
  assert.equal(sessions.length, 4);
  for (const lane of Object.values(repro.lanes)) {
    const session = sessions.find((candidate) => candidate.sessionId === lane.sessionId);
    assert.ok(session, `${lane.lane} Session must be visible`);
    const lineage = objectField(session, "lineage");
    assert.equal(lineage.kind, "child");
    assert.equal(lineage.parentSessionId, rootSessionId);
    assert.equal(objectField(lineage, "origin").kind, "task_revision");
    assert.equal(objectField(lineage, "origin").projectRef, repro.projectRef);
    assert.equal(objectField(lineage, "origin").taskRef, lane.taskRef);
    assert.deepEqual(
      objectField(session, "model"),
      options.expectedModel ?? {
        providerName: "spark-scripted",
        modelId: "spark-scripted-provider",
      },
    );
  }

  const durable = readDurableSnapshot(fixture, rootSessionId);
  assert.equal(durable.projection?.stateUpdatedAt, repro.updatedAt);
  const artifacts = await defaultArtifactStore(fixture.workspaceRoot).list();
  const projected = artifacts.filter(isDocumentArtifact);
  assert.equal(projected.length, 2);
  assert.deepEqual(
    new Set(projected.map((artifact) => artifact.body.mediaType)),
    new Set(["text/markdown", "application/vnd.a2ui+json"]),
  );
  assert.ok(projected.every((artifact) => artifact.body.management?.lifecycle === "sealed"));

  if (options.scriptedProvider !== false) {
    const provider = await readProviderLedger(fixture.providerLedgerPath);
    assert.equal(provider.cursor, provider.rounds.length);
    assert.deepEqual(
      provider.requests.map((request) => request.label).toSorted(compareOptionalText),
      provider.rounds.map((round) => round.label).toSorted(compareOptionalText),
    );
    assert.ok(
      provider.auxiliaryRequests?.some((request) => request.label === "auxiliary.compaction"),
    );
  }
  const forge = jsonObject(await readFile(fixture.forgeLedgerPath, "utf8"));
  assert.equal(forge.draftPrCreates, 0);
  assert.equal(forge.nonDraftPrCreates, 0);
}

function createJourneyRounds(
  options: { implementationAttention?: boolean; implementationDelayMs?: number } = {},
): ScriptedRound[] {
  const rounds: ScriptedRound[] = [];
  const tool = (
    audience: ScriptedRound["audience"],
    label: string,
    name: string,
    arguments_: Record<string, unknown>,
  ) => rounds.push({ audience, label, toolCalls: [{ id: label, name, arguments: arguments_ }] });
  const text = (audience: ScriptedRound["audience"], label: string, value: string) =>
    rounds.push({ audience, label, text: value });
  const provenance = {
    producer: "role",
    taskRef: "${BINDING_TASK_REF}",
    runRef: "${BINDING_RUN_REF}",
  };
  const common = (
    lane: ScriptedRound["audience"],
    checkpoint: string,
    source: boolean,
    parent: boolean,
  ) => ({
    schema: "spark.repro.lane-result/v2",
    reproId: "${BINDING_REPRO_ID}",
    checkpointId: "${BINDING_CHECKPOINT_ID}",
    ...(source ? { sourceCheckpointId: "${BINDING_SOURCE_CHECKPOINT_ID}" } : {}),
    ...(parent ? { parentCheckpointId: "${BINDING_PARENT_CHECKPOINT_ID}" } : {}),
    sessionId: "${BINDING_SESSION_ID}",
    taskRef: "${BINDING_TASK_REF}",
    runRef: "${BINDING_RUN_REF}",
    lane,
    checkpoint,
  });
  const record = (
    audience: ScriptedRound["audience"],
    label: string,
    title: string,
    body: Record<string, unknown>,
  ) =>
    tool(audience, label, "evidence", {
      action: "record",
      kind: "record",
      title,
      format: "json",
      body,
      provenance,
    });
  const checkpoint = (
    prefix: string,
    audience: ScriptedRound["audience"],
    kind: string,
    source: boolean,
    parent: boolean,
    proofVariable: string,
    resultVariable: string,
    verifyCommand: string,
  ) => {
    tool(audience, `${prefix}.verify`, "cue_exec", { command: verifyCommand, timeout: 30 });
    record(audience, `${prefix}.proof`, `${kind} proof`, {
      checkpoint: kind,
      passed: true,
      repositories: ["repos/reference", "repos/target"],
    });
    record(audience, `${prefix}.result`, `${kind} lane result`, {
      ...common(audience, kind, source, parent),
      kind: "checkpoint_result",
      summary: `${kind} accepted after bounded multi-repository verification`,
      evidenceRefs: [proofVariable],
      ...(kind === "formalize" ? { formalizedRevision: "revision:formalized" } : {}),
    });
    tool(audience, `${prefix}.plan`, "impl_update_task_plan_items", {
      ops: [{ op: "done", id: "item-1", evidenceRefs: [proofVariable, resultVariable] }],
    });
    tool(audience, `${prefix}.finish`, "impl_finish_task", {
      summary: `${kind} checkpoint completed with TaskRun-bound Evidence.`,
      evidenceRefs: [proofVariable, resultVariable],
    });
    text(audience, `${prefix}.complete`, `${kind} is terminal; daemon owner may advance.`);
  };

  if (options.implementationAttention) {
    record("implementation", "implementation-attention.proof", "Attention proof", {
      summary: "Two references disagree and require a user decision",
    });
    record("implementation", "implementation-attention.result", "Attention request", {
      ...common("implementation", "implementation", false, false),
      kind: "attention_request",
      evidenceRefs: ["${IMPLEMENTATION_ATTENTION_PROOF_EVIDENCE}"],
      decisionKey: "glm52-reference",
      question: "Which GLM-5.2 reference should be authoritative?",
      reason: "Two runnable references disagree on the normalization contract.",
      expectedAnswerKind: "freeform",
    });
    tool("implementation", "implementation-attention.plan", "impl_update_task_plan_items", {
      ops: [
        {
          op: "done",
          id: "item-1",
          evidenceRefs: [
            "${IMPLEMENTATION_ATTENTION_PROOF_EVIDENCE}",
            "${IMPLEMENTATION_ATTENTION_RESULT_EVIDENCE}",
          ],
        },
      ],
    });
    tool("implementation", "implementation-attention.finish", "impl_finish_task", {
      summary: "Implementation paused at a durable attention checkpoint.",
      evidenceRefs: [
        "${IMPLEMENTATION_ATTENTION_PROOF_EVIDENCE}",
        "${IMPLEMENTATION_ATTENTION_RESULT_EVIDENCE}",
      ],
    });
    text(
      "implementation",
      "implementation-attention.complete",
      "The attention attempt is terminal and awaits an AnswerEvent.",
    );
  }

  tool("implementation", "implementation.edit", "edit", {
    path: "target/normalize.mjs",
    edits: [
      {
        oldText: "  const denominator = variance + epsilon;",
        newText: "  const denominator = Math.sqrt(variance + epsilon);",
      },
    ],
  });
  checkpoint(
    "implementation",
    "implementation",
    "implementation",
    false,
    false,
    "${IMPLEMENTATION_PROOF_EVIDENCE}",
    "${IMPLEMENTATION_RESULT_EVIDENCE}",
    'node -e "setTimeout(() => {}, 300)" && node verify.mjs target',
  );
  checkpoint(
    "exactness",
    "exactness",
    "exactness",
    true,
    false,
    "${EXACTNESS_PROOF_EVIDENCE}",
    "${EXACTNESS_RESULT_EVIDENCE}",
    'node -e "setTimeout(() => {}, 800)" && node verify.mjs target',
  );
  checkpoint(
    "formalize",
    "formalize",
    "formalize",
    true,
    false,
    "${FORMALIZE_PROOF_EVIDENCE}",
    "${FORMALIZE_RESULT_EVIDENCE}",
    `${
      options.implementationDelayMs
        ? `node -e "setTimeout(() => {}, ${options.implementationDelayMs})" && `
        : ""
    }node verify.mjs target`,
  );
  checkpoint(
    "exactness-refresh",
    "exactness",
    "exactness_refresh",
    true,
    true,
    "${EXACTNESS_REFRESH_PROOF_EVIDENCE}",
    "${EXACTNESS_REFRESH_RESULT_EVIDENCE}",
    'node -e "setTimeout(() => {}, 800)" && node verify.mjs target',
  );
  checkpoint(
    "implementation-refresh",
    "implementation",
    "implementation_refresh",
    true,
    true,
    "${IMPLEMENTATION_REFRESH_PROOF_EVIDENCE}",
    "${IMPLEMENTATION_REFRESH_RESULT_EVIDENCE}",
    "node verify.mjs target",
  );
  return rounds;
}

async function createJourneyFixture(
  rounds: ScriptedRound[] = createJourneyRounds(),
  options: { liveModelId?: string } = {},
): Promise<JourneyFixture> {
  const temporary = await realpath(
    await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-repro-journey-")),
  );
  await chmod(temporary, 0o700);
  const workspaceRoot = resolve(temporary, "fixture-workspace");
  const sparkHome = resolve(temporary, "spark-home");
  const binDir = resolve(temporary, "bin");
  const providerLedgerPath = resolve(temporary, "provider-ledger.json");
  const forgeLedgerPath = resolve(temporary, "forge-ledger.json");
  const repositories = [
    resolve(workspaceRoot, "repos/reference"),
    resolve(workspaceRoot, "repos/target"),
  ];
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    ...repositories.map((repository) => mkdir(repository, { recursive: true })),
    mkdir(resolve(sparkHome, "apps/daemon"), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(resolve(temporary, "home"), { recursive: true }),
    mkdir(resolve(temporary, "xdg/run/cue"), { recursive: true, mode: 0o700 }),
  ]);
  await cp(fixtureRoot, workspaceRoot, { recursive: true });
  for (const [index, repository] of repositories.entries()) {
    await writeFile(resolve(repository, "README.md"), `fixture repository ${index + 1}\n`);
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.name", "Spark Journey"]);
    await git(repository, ["config", "user.email", "journey@example.invalid"]);
    await git(repository, ["config", "commit.gpgsign", "false"]);
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "fixture baseline"]);
  }

  const ghPath = resolve(binDir, "gh");
  await cp(forgeShim, ghPath);
  await chmod(ghPath, 0o755);
  await writeFile(
    forgeLedgerPath,
    `${JSON.stringify({
      schema: "spark.repro.forge-ledger/v1",
      trunk: "main",
      branches: [],
      draftPrCreates: 0,
      nonDraftPrCreates: 0,
      pullRequest: null,
      events: [],
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    providerLedgerPath,
    `${JSON.stringify(
      {
        schema: "spark.repro.scripted-provider-ledger/v1",
        cursor: 0,
        rounds,
        requests: [],
        vars: {},
      } satisfies ScriptedLedger,
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const configuredModel = options.liveModelId ?? "spark-scripted/spark-scripted-provider";
  await writeFile(
    resolve(sparkHome, "config.json"),
    `${JSON.stringify(
      {
        ...(options.liveModelId ? {} : { providers: [providerPlugin] }),
        enabledModels: [configuredModel],
        activeModelId: configuredModel,
        activeThinkingLevel: "off",
        skills: [],
        compact: { keepRecentTokens: 1 },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(sparkHome, "apps/daemon/config.toml"),
    'installationId = "spark-daemon-repro-golden-journey"\ndisplayName = "Repro Golden Journey"\n',
    { mode: 0o600 },
  );

  const port = await reservePort();
  const originalHome = process.env.HOME;
  const env = {
    ...process.env,
    HOME: resolve(temporary, "home"),
    SPARK_HOME: sparkHome,
    XDG_CONFIG_HOME: resolve(temporary, "xdg/config"),
    XDG_STATE_HOME: resolve(temporary, "xdg/state"),
    XDG_DATA_HOME: resolve(temporary, "xdg/data"),
    XDG_RUNTIME_DIR: resolve(temporary, "xdg/run"),
    ...(originalHome
      ? {
          COREPACK_HOME: process.env.COREPACK_HOME ?? resolve(originalHome, ".cache/node/corepack"),
        }
      : {}),
    SPARK_DAEMON_SERVICE_MODE: "detached",
    SPARK_HEADLESS_EXECUTOR_MODULE: resolve(
      root,
      "apps/spark-daemon/src/product/headless-role-executor.ts",
    ),
    SPARK_REPRO_SCRIPTED_PROVIDER_LEDGER: providerLedgerPath,
    SPARK_REPRO_FORGE_LEDGER: forgeLedgerPath,
    PATH: [binDir, originalHome ? resolve(originalHome, ".cargo/bin") : undefined, process.env.PATH]
      .filter((entry): entry is string => Boolean(entry))
      .join(delimiter),
    HOST: "127.0.0.1",
    PORT: String(port),
    SPARK_HUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
  } satisfies NodeJS.ProcessEnv;
  return {
    temporary,
    workspaceRoot,
    sparkHome,
    providerLedgerPath,
    forgeLedgerPath,
    port,
    target: {
      command: resolve(root, "apps/spark-cli/bin/spark"),
      cwd: workspaceRoot,
      env,
      timeoutMs: 120_000,
    },
  };
}

function parseModelId(value: string): { providerName: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("SPARK_REPRO_LIVE_MODEL must use provider/model format");
  }
  return { providerName: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

async function assertMultiRepositoryWorkspace(fixture: JourneyFixture): Promise<void> {
  await assert.rejects(gitOutput(fixture.workspaceRoot, ["rev-parse", "--show-toplevel"]));
  for (const repository of ["reference", "target"]) {
    assert.match(
      await gitOutput(resolve(fixture.workspaceRoot, `repos/${repository}`), [
        "rev-parse",
        "--show-toplevel",
      ]),
      new RegExp(`/repos/${repository}\\n$`, "u"),
    );
  }
  assert.equal((await runFixtureVerification(fixture.workspaceRoot, "reference")).exitCode, 0);
  assert.equal((await runFixtureVerification(fixture.workspaceRoot, "target")).exitCode, 1);
}

async function startRegisteredWorkspace(
  fixture: JourneyFixture,
  observedProcessPids: number[],
): Promise<string> {
  const enrollmentToken = seedHubEnrollment(fixture.sparkHome);
  const hubTarget = {
    ...fixture.target,
    env: {
      ...fixture.target.env,
      // The source Hub executes its built SvelteKit handler, while the
      // migration owner remains the spark-hub-storage-sqlite source package. Point only
      // the Hub process at that real asset directory; the daemon keeps its
      // ordinary source-workspace environment.
      SPARK_PRODUCT_DIST: resolve(root, "packages/spark-hub-storage-sqlite/src"),
    },
  } satisfies SparkProcessTarget;
  const hubStarted = jsonObject(
    (await runSparkProcess(hubTarget, ["hub", "web", "start", "--json"])).stdout,
  );
  observedProcessPids.push(numberField(hubStarted, "pid"));
  const daemonStarted = jsonObject(
    (await runSparkProcess(fixture.target, ["daemon", "start", "--json"])).stdout,
  );
  observedProcessPids.push(numberField(objectField(daemonStarted, "daemon"), "pid"));
  await runSparkProcess(fixture.target, [
    "daemon",
    "workspace",
    "register",
    fixture.workspaceRoot,
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
  return stringField(sessions[0]!, "sessionId");
}

function readDurableSnapshot(fixture: JourneyFixture, ownerSessionId: string): DurableSnapshot {
  const databasePath = resolveSparkPaths({
    app: "daemon",
    sparkHome: fixture.sparkHome,
  }).databasePath;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT state_json
         FROM daemon_repro_runs
         WHERE owner_session_id = ?
         ORDER BY updated_at DESC, repro_id DESC
         LIMIT 1`,
      )
      .get(ownerSessionId) as { state_json: string } | undefined;
    if (!row) throw new Error("Repro v10 state is unavailable");
    const repro = JSON.parse(row.state_json) as SparkSessionRepro;
    const projection = db
      .prepare(
        `SELECT state_updated_at, report_artifact_ref, report_revision,
                workbench_artifact_ref, workbench_revision
         FROM daemon_repro_projections
         WHERE repro_id = ?`,
      )
      .get(repro.reproId) as
      | {
          state_updated_at: string;
          report_artifact_ref: string;
          report_revision: number;
          workbench_artifact_ref: string;
          workbench_revision: number;
        }
      | undefined;
    return {
      repro,
      ...(projection
        ? {
            projection: {
              stateUpdatedAt: projection.state_updated_at,
              reportArtifactRef: projection.report_artifact_ref,
              reportRevision: projection.report_revision,
              workbenchArtifactRef: projection.workbench_artifact_ref,
              workbenchRevision: projection.workbench_revision,
            },
          }
        : {}),
    };
  } finally {
    db.close();
  }
}

async function waitForRepro(
  fixture: JourneyFixture,
  predicate: (repro: SparkSessionRepro) => boolean,
): Promise<SparkSessionRepro> {
  return await waitFor(
    async () => {
      try {
        const repro = readDurableSnapshot(
          fixture,
          stringField(
            jsonArray(
              (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"]))
                .stdout,
            ).find((session) => objectField(session, "lineage").kind === "root")!,
            "sessionId",
          ),
        ).repro;
        return predicate(repro) ? repro : undefined;
      } catch {
        return undefined;
      }
    },
    120_000,
    "Repro v10 checkpoint",
  );
}

async function compactLaneSession(fixture: JourneyFixture, sessionId: string): Promise<void> {
  const submitted = await requestSparkDaemon(
    "session.compact",
    {
      sessionId,
      customInstructions:
        "Preserve the active Repro objective and reload checkpoint bindings from daemon owner state.",
      idempotencyKey: "idem_repro_glm52_lane_compaction",
    },
    { env: fixture.target.env },
  );
  const result = await waitForInvocation(fixture.target, submitted.invocationId, "succeeded");
  assert.match(stringField(result, "assistantText"), /Compacted daemon session/u);
  const session = await requestSparkDaemon(
    "session.get",
    { sessionId },
    { env: fixture.target.env },
  );
  assert.ok(session.sessionPath, "compacted lane Session must expose its durable transcript path");
  const document = decodeSparkDshSessionJsonl(await readFile(session.sessionPath, "utf8"));
  assert.ok(document, "compacted lane Session must be DSH JSONL");
  const record = dshDocumentToSparkRecord(session.sessionPath, document);
  assert.ok(
    record.entries.some((entry) => entry.type === "compaction"),
    "compaction must persist a summary boundary in the reused lane Session",
  );
}

async function seedLaneForCompaction(fixture: JourneyFixture, sessionId: string): Promise<void> {
  const submitted = await requestSparkDaemon(
    "turn.submit",
    {
      sessionId,
      prompt: "Record a bounded continuation checkpoint before Repro compaction.",
      idempotencyKey: "idem_repro_glm52_lane_compaction_seed",
    },
    { env: fixture.target.env },
  );
  await waitForInvocation(fixture.target, submitted.invocationId, "succeeded");
}

async function durableCounts(
  fixture: JourneyFixture,
  rootSessionId: string,
): Promise<Record<string, unknown>> {
  const durable = readDurableSnapshot(fixture, rootSessionId);
  const graph = await defaultTaskGraphStore(fixture.workspaceRoot).load();
  assert.ok(graph);
  const sessions = jsonArray(
    (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"])).stdout,
  );
  const artifacts = await defaultArtifactStore(fixture.workspaceRoot).list();
  return {
    reproUpdatedAt: durable.repro.updatedAt,
    status: durable.repro.status,
    receipts: durable.repro.receipts.length,
    tasks: graph.tasks(durable.repro.projectRef).length,
    runs: graph.runs(durable.repro.projectRef).length,
    sessions: sessions.length,
    artifacts: artifacts.length,
    projection: durable.projection,
  };
}

async function listPendingAsks(
  target: SparkProcessTarget,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const response = jsonObject(
    (await runSparkProcess(target, ["daemon", "ask", "list", "--session", sessionId, "--json"]))
      .stdout,
  );
  return arrayField(response, "waits");
}

async function waitForSinglePendingAsk(
  target: SparkProcessTarget,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return await waitFor(
    async () => {
      const pending = await listPendingAsks(target, sessionId);
      return pending.length === 1 ? pending[0] : undefined;
    },
    120_000,
    "one Repro attention Ask",
  );
}

async function restartDaemon(target: SparkProcessTarget): Promise<number> {
  const status = jsonObject((await runSparkProcess(target, ["daemon", "status", "--json"])).stdout);
  const previousPid = numberField(objectField(status, "daemon"), "pid");
  try {
    process.kill(process.platform === "win32" ? previousPid : -previousPid, "SIGKILL");
  } catch {
    process.kill(previousPid, "SIGKILL");
  }
  await waitFor(
    async () => (isProcessAlive(previousPid) ? undefined : true),
    10_000,
    `daemon ${previousPid} to exit at the crash window`,
  );
  const started = jsonObject((await runSparkProcess(target, ["daemon", "start", "--json"])).stdout);
  return numberField(objectField(started, "daemon"), "pid");
}

async function waitForInvocation(
  target: SparkProcessTarget,
  invocationId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  const result = await waitFor(
    async () => {
      const value = jsonObject(
        (await runSparkProcess(target, ["daemon", "invocation", "result", invocationId, "--json"]))
          .stdout,
      );
      return ["succeeded", "failed", "cancelled"].includes(String(value.status))
        ? value
        : undefined;
    },
    60_000,
    `invocation ${invocationId} to become terminal`,
  );
  if (result.status !== expected) {
    throw new Error(
      `Invocation ${invocationId} became ${String(result.status)}: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function stopProcesses(target: SparkProcessTarget, pids: number[]): Promise<void> {
  await runSparkProcess(target, ["daemon", "stop", "--yes"]).catch(() => undefined);
  await runSparkProcess(target, ["hub", "web", "stop", "--json"]).catch(() => undefined);
  await Promise.all(
    [...new Set(pids)]
      .filter((pid) => pid > 0)
      .map(async (pid) => {
        await waitFor(
          async () => (isProcessAlive(pid) ? undefined : true),
          10_000,
          `process ${pid} to stop`,
        ).catch(() => undefined);
      }),
  );
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

async function readProviderLedger(path: string): Promise<ScriptedLedger> {
  return jsonObject(await readFile(path, "utf8")) as unknown as ScriptedLedger;
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const detail = lastError instanceof Error ? lastError.message : "";
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
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function runFixtureVerification(
  cwd: string,
  implementation: "reference" | "target",
): Promise<{ exitCode: number }> {
  try {
    await execFileAsync(process.execPath, [resolve(cwd, "verify.mjs"), implementation], {
      cwd,
      env: process.env,
      encoding: "utf8",
    });
    return { exitCode: 0 };
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    return { exitCode: typeof code === "number" ? code : Number(code) || 1 };
  }
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

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${key} must be an object`,
  );
  return value as Record<string, unknown>;
}

function arrayField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  assert.ok(Array.isArray(value), `${key} must be an array`);
  return value as Record<string, unknown>[];
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new TypeError(`${key} must be a number`);
  return value;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isDocumentArtifact(artifact: Artifact): artifact is Artifact<DocumentArtifactBody> {
  return artifact.kind === "document" && artifact.body.kind === "document";
}

function compareOptionalText(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}
