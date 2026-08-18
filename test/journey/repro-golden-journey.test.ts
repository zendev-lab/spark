import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

import {
  defaultArtifactStore,
  type Artifact,
  type GitChangeArtifactBody,
} from "@zendev-lab/spark-artifacts";
import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-hub-db";
import { createRuntimeEnrollmentToken } from "@zendev-lab/spark-hub-coordination/runtime-registration";
import { sessionReproStorePathV2 } from "@zendev-lab/spark-loop";
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
  audience: "root" | "implementation" | "exactness" | "formalize";
  text?: string;
  toolCalls?: ScriptedToolCall[];
}

interface ScriptedLedger {
  schema: "spark.repro.scripted-provider-ledger/v1";
  cursor: number;
  rounds: ScriptedRound[];
  requests: Array<{
    round: number;
    label?: string;
    messageRoles: string[];
    toolNames: string[];
  }>;
  auxiliaryRequests?: Array<{
    label: string;
    messageRoles: string[];
    toolNames: string[];
  }>;
  vars: Record<string, string>;
  cursors?: Record<string, number>;
  lastLabels?: Record<string, string>;
}

interface JourneyFixture {
  temporary: string;
  sourceRepo: string;
  sparkHome: string;
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

test("/repro opens three durable lane Sessions and completes the five-run checkpoint chain", async () => {
  const fixture = await createJourneyFixture();
  retainedFailureFixture = fixture.temporary;
  const observedProcessPids: number[] = [];
  try {
    const referenceBefore = await runFixtureVerification(fixture.sourceRepo, "reference");
    const targetBefore = await runFixtureVerification(fixture.sourceRepo, "target");
    assert.equal(referenceBefore.exitCode, 0);
    assert.equal(targetBefore.exitCode, 1);

    const enrollmentToken = seedHubEnrollment(fixture.sparkHome);
    const hubStarted = jsonObject(
      (await runSparkProcess(fixture.target, ["hub", "web", "start", "--json"])).stdout,
    );
    observedProcessPids.push(numberField(hubStarted, "pid"));
    const started = jsonObject(
      (await runSparkProcess(fixture.target, ["daemon", "start", "--json"])).stdout,
    );
    observedProcessPids.push(numberField(objectField(started, "daemon"), "pid"));

    await runSparkProcess(fixture.target, [
      "daemon",
      "workspace",
      "register",
      fixture.sourceRepo,
      "--server-url",
      `http://127.0.0.1:${fixture.port}`,
      "--token",
      enrollmentToken,
      "--name",
      "Repro Golden Journey",
      "--allow-insecure-http",
    ]);

    const sessionsBefore = jsonArray(
      (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"])).stdout,
    );
    assert.equal(sessionsBefore.length, 1);
    const rootSessionId = stringField(sessionsBefore[0]!, "sessionId");
    const seeded = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "submit",
          "--session",
          rootSessionId,
          "--prompt",
          "Prepare a clean context boundary before starting Repro.",
          "--idempotency-key",
          "idem_repro_glm52_compaction_seed",
          "--json",
        ])
      ).stdout,
    );
    await waitForInvocation(fixture.target, stringField(seeded, "invocationId"), "succeeded");
    const submitted = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "submit",
          "--session",
          rootSessionId,
          "--prompt",
          "/repro 复现 glm52",
          "--idempotency-key",
          "idem_repro_glm52_three_lane",
          "--json",
        ])
      ).stdout,
    );
    await waitForInvocation(fixture.target, stringField(submitted, "invocationId"), "succeeded");

    const reproPath = sessionReproStorePathV2(fixture.sourceRepo, { sessionId: rootSessionId });
    const beforeCompact = await waitForReproCheckpoint(reproPath, (candidate) => {
      const receipts = arrayField(objectField(candidate, "threeLane"), "resultReceipts");
      return receipts.length > 0 && receipts.length < 5;
    });
    assert.ok(arrayField(objectField(beforeCompact, "threeLane"), "resultReceipts").length < 5);
    await compactReproRootSession(fixture, rootSessionId);
    const continued = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "submit",
          "--session",
          rootSessionId,
          "--prompt",
          "Continue the durable Repro checkpoint after context compaction.",
          "--idempotency-key",
          "idem_repro_glm52_after_compaction",
          "--json",
        ])
      ).stdout,
    );
    await waitForInvocation(fixture.target, stringField(continued, "invocationId"), "succeeded");

    const repro = await waitForReproCheckpoint(reproPath, (candidate) => {
      const state = objectField(candidate, "threeLane");
      const workItem = arrayField(state, "workItems")[0];
      return workItem?.status === "completed" && arrayField(state, "resultReceipts").length === 5;
    });
    await assertCompletedTopology(fixture, rootSessionId, repro);

    const beforeFinalRestart = await durableCounts(fixture, rootSessionId, repro);
    const providerBeforeFinalRestart = await readProviderLedger(fixture.providerLedgerPath);
    assert.equal(
      providerBeforeFinalRestart.requests.filter(
        (request) => request.label === "root.repro.continued.status",
      ).length,
      1,
      "the first post-compaction action must reload Repro from the durable owner",
    );
    assert.equal(
      providerBeforeFinalRestart.requests.filter(
        (request) => request.label === "root.repro.continued",
      ).length,
      1,
    );
    observedProcessPids.push(await restartDaemon(fixture.target));
    const afterFinalRestart = await durableCounts(fixture, rootSessionId, repro);
    const providerAfterFinalRestart = await readProviderLedger(fixture.providerLedgerPath);
    assert.deepEqual(afterFinalRestart, beforeFinalRestart);
    assert.equal(
      providerAfterFinalRestart.requests.length,
      providerBeforeFinalRestart.requests.length,
    );

    retainedFailureFixture = undefined;
  } finally {
    await stopProcesses(fixture.target, observedProcessPids);
    if (retainedFailureFixture !== fixture.temporary) {
      await rm(fixture.temporary, { recursive: true, force: true });
    }
  }
}, 240_000);

test("lane attention survives daemon restart and resumes the original Session", async () => {
  const fixture = await createJourneyFixture(
    createJourneyRounds({ compactRoot: false, implementationAttention: true }),
  );
  retainedFailureFixture = fixture.temporary;
  const observedProcessPids: number[] = [];
  try {
    const enrollmentToken = seedHubEnrollment(fixture.sparkHome);
    const hubStarted = jsonObject(
      (await runSparkProcess(fixture.target, ["hub", "web", "start", "--json"])).stdout,
    );
    observedProcessPids.push(numberField(hubStarted, "pid"));
    const started = jsonObject(
      (await runSparkProcess(fixture.target, ["daemon", "start", "--json"])).stdout,
    );
    observedProcessPids.push(numberField(objectField(started, "daemon"), "pid"));
    await runSparkProcess(fixture.target, [
      "daemon",
      "workspace",
      "register",
      fixture.sourceRepo,
      "--server-url",
      `http://127.0.0.1:${fixture.port}`,
      "--token",
      enrollmentToken,
      "--allow-insecure-http",
    ]);

    const sessions = jsonArray(
      (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"])).stdout,
    );
    assert.equal(sessions.length, 1);
    const rootSessionId = stringField(sessions[0]!, "sessionId");
    const submitted = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "submit",
          "--session",
          rootSessionId,
          "--prompt",
          "/repro 复现 glm52",
          "--idempotency-key",
          "idem_repro_glm52_attention",
          "--json",
        ])
      ).stdout,
    );
    await waitForInvocation(fixture.target, stringField(submitted, "invocationId"), "succeeded");

    const pendingBeforeRestart = await waitForSinglePendingAsk(fixture.target, rootSessionId);
    const reproPath = sessionReproStorePathV2(fixture.sourceRepo, { sessionId: rootSessionId });
    const attentionCheckpoint = await waitForReproCheckpoint(reproPath, (candidate) =>
      arrayField(objectField(candidate, "threeLane"), "routes").some(
        (route) => route.action === "root_attention" && route.status === "pending",
      ),
    );
    const implementationSessionId = await implementationLaneSessionId(fixture, attentionCheckpoint);

    observedProcessPids.push(await restartDaemon(fixture.target));
    const pendingAfterRestart = await waitForSinglePendingAsk(fixture.target, rootSessionId);
    assert.equal(
      pendingAfterRestart.interactionRequestId,
      pendingBeforeRestart.interactionRequestId,
    );
    const answered = jsonObject(
      (
        await runSparkProcess(fixture.target, [
          "daemon",
          "ask",
          "answer",
          stringField(pendingAfterRestart, "interactionRequestId"),
          "--session",
          rootSessionId,
          "--answers",
          JSON.stringify({
            "glm52-reference": {
              values: [],
              customText: "Use the official upstream GLM-5.2 implementation.",
            },
          }),
          "--json",
        ])
      ).stdout,
    );
    assert.equal(answered.outcome, "accepted");

    const completed = await waitForReproCheckpoint(reproPath, (candidate) => {
      const state = objectField(candidate, "threeLane");
      const workItem = arrayField(state, "workItems")[0];
      return workItem?.status === "completed" && arrayField(state, "resultReceipts").length === 6;
    });
    const state = objectField(completed, "threeLane");
    assert.deepEqual(
      arrayField(state, "routes").map((route) => route.action),
      [
        "start_binding",
        "root_attention",
        "resume_binding",
        "materialize_binding",
        "materialize_binding",
        "refresh_binding",
        "refresh_binding",
      ],
    );
    assert.ok(arrayField(state, "routes").every((route) => route.status === "acknowledged"));
    assert.equal(await implementationLaneSessionId(fixture, completed), implementationSessionId);
    const graph = await defaultTaskGraphStore(fixture.sourceRepo).load();
    assert.ok(graph);
    const projectRef = stringField(completed, "projectRef") as Parameters<typeof graph.runs>[0];
    const implementationTaskRef = stringField(
      arrayField(state, "bindings").find((binding) => binding.lane === "implementation")!,
      "taskRef",
    );
    const implementationRuns = graph
      .runs(projectRef)
      .filter((run) => run.taskRef === implementationTaskRef);
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

async function assertCompletedTopology(
  fixture: JourneyFixture,
  rootSessionId: string,
  repro: Record<string, unknown>,
): Promise<void> {
  assert.equal(repro.version, 9);
  assert.equal(repro.objective, "复现 glm52");
  const state = objectField(repro, "threeLane");
  assert.equal(state.schema, "spark.repro.three-lane-session/v2");

  const workItems = arrayField(state, "workItems");
  const routes = arrayField(state, "routes");
  const bindings = arrayField(state, "bindings");
  const receipts = arrayField(state, "resultReceipts");
  const handoffs = arrayField(state, "handoffs");
  const resolutions = arrayField(state, "resolutions");
  assert.equal(workItems.length, 1);
  assert.equal(workItems[0]?.status, "completed");
  assert.deepEqual(
    routes.map((route) => route.action),
    [
      "start_binding",
      "materialize_binding",
      "materialize_binding",
      "refresh_binding",
      "refresh_binding",
    ],
  );
  assert.ok(routes.every((route) => route.status === "acknowledged"));
  assert.equal(bindings.length, 3);
  assert.equal(receipts.length, 5);
  assert.ok(receipts.every((receipt) => receipt.status === "accepted"));
  assert.equal(handoffs.length, 2);
  assert.deepEqual(
    handoffs.map((handoff) => `${String(handoff.from)}:${String(handoff.to)}`),
    ["implementation:exactness", "exactness:formalize"],
  );
  assert.equal(resolutions.length, 2);
  assert.deepEqual(
    resolutions.map((resolution) => `${String(resolution.from)}:${String(resolution.to)}`),
    ["formalize:exactness", "exactness:implementation"],
  );
  assert.equal(resolutions[1]?.parentResolutionId, resolutions[0]?.resolutionId);

  const formalizedTip = stringField(objectField(state, "formalize"), "formalizedTip");
  assert.equal(stringField(workItems[0]!, "sourceRevision"), formalizedTip);
  const graph = await defaultTaskGraphStore(fixture.sourceRepo).load();
  assert.ok(graph);
  const projectRef = stringField(repro, "projectRef") as Parameters<typeof graph.tasks>[0];
  const tasks = graph.tasks(projectRef);
  const runs = graph.runs(projectRef);
  assert.equal(tasks.length, 3);
  assert.equal(runs.length, 5);
  assert.ok(runs.every((run) => run.status === "succeeded"));

  const runSessionIds = runs.map((run) => {
    const sessionId = run.execution?.sessionId ?? run.execution?.executionSessionId;
    assert.ok(sessionId);
    return sessionId;
  });
  assert.equal(new Set(runSessionIds).size, 3);
  assert.ok(!runSessionIds.includes(rootSessionId));
  const activeSessions = jsonArray(
    (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"])).stdout,
  );
  assert.equal(activeSessions.length, 4);
  assert.ok(activeSessions.some((session) => session.sessionId === rootSessionId));
  assert.ok(
    runSessionIds.every((sessionId) =>
      activeSessions.some((session) => session.sessionId === sessionId),
    ),
  );
  for (const binding of bindings) {
    const taskRef = stringField(binding, "taskRef");
    const laneRuns = runs.filter((run) => run.taskRef === taskRef);
    const lane = stringField(binding, "lane");
    assert.equal(laneRuns.length, lane === "formalize" ? 1 : 2);
    assert.equal(
      new Set(laneRuns.map((run) => run.execution?.sessionId ?? run.execution?.executionSessionId))
        .size,
      1,
    );
  }

  const artifacts = (await defaultArtifactStore(fixture.sourceRepo).list()).filter(
    isGitChangeArtifact,
  );
  assert.equal(artifacts.length, 3);
  const worktreePaths = artifacts.map(gitChangeWorktreePath);
  assert.equal(new Set(worktreePaths).size, 3);
  const refreshedArtifactRefs = new Set(
    bindings
      .filter((binding) => binding.lane !== "formalize")
      .map((binding) => stringField(binding, "gitChangeRef")),
  );
  for (const artifact of artifacts) {
    assert.equal(
      await gitOutput(gitChangeWorktreePath(artifact), ["rev-parse", "HEAD"]),
      `${formalizedTip}\n`,
    );
    if (refreshedArtifactRefs.has(artifact.ref)) {
      assert.equal(artifact.body.revisionMaterialization?.headRevision, formalizedTip);
    }
  }

  const formalizeBinding = bindings.find((binding) => binding.lane === "formalize");
  assert.ok(formalizeBinding);
  const formalizeRef = stringField(formalizeBinding, "gitChangeRef");
  const formalizeArtifact = artifacts.find((artifact) => artifact.ref === formalizeRef);
  assert.ok(formalizeArtifact);
  assert.equal(formalizeArtifact.body.stack.entries.length, 1);
  assert.equal(formalizeArtifact.body.stack.entries[0]?.pullRequest?.draft, true);
  assert.equal(formalizeArtifact.body.stack.entries[0]?.pullRequest?.state, "open");

  const forge = jsonObject(await readFile(fixture.forgeLedgerPath, "utf8"));
  assert.equal(forge.draftPrCreates, 1);
  assert.equal(forge.nonDraftPrCreates, 0);

  const provider = await readProviderLedger(fixture.providerLedgerPath);
  assert.equal(provider.cursor, provider.rounds.length);
  assert.deepEqual(
    provider.requests
      .map((request) => request.label)
      .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    provider.rounds
      .map((round) => round.label)
      .toSorted((left, right) => left.localeCompare(right)),
  );
  assert.equal(
    provider.rounds
      .filter((round) => round.label === "root.repro.start")
      .flatMap((round) => round.toolCalls ?? [])
      .filter((call) => call.name === "repro").length,
    1,
  );
  assert.equal(
    provider.rounds
      .filter((round) => round.label === "root.repro.continued.status")
      .flatMap((round) => round.toolCalls ?? [])
      .filter((call) => call.name === "repro").length,
    1,
  );
  assert.equal(
    provider.requests.filter((request) => request.label === "root.repro.start").length,
    1,
  );
  assert.match(provider.vars.BASELINE_REVISION ?? "", /^[a-f0-9]{40}$/u);
  assert.match(provider.vars.CANDIDATE_REVISION ?? "", /^[a-f0-9]{40}$/u);
  assert.notEqual(provider.vars.BASELINE_REVISION, provider.vars.CANDIDATE_REVISION);
  assert.notEqual(provider.vars.CANDIDATE_REVISION, provider.vars.CANONICAL_REVISION);
  assert.equal(provider.vars.CANONICAL_REVISION, formalizedTip);

  const targetAfter = await runFixtureVerification(
    gitChangeWorktreePath(formalizeArtifact),
    "target",
  );
  assert.equal(targetAfter.exitCode, 0);
}

async function durableCounts(
  fixture: JourneyFixture,
  rootSessionId: string,
  repro: Record<string, unknown>,
): Promise<Record<string, number>> {
  const graph = await defaultTaskGraphStore(fixture.sourceRepo).load();
  assert.ok(graph);
  const projectRef = stringField(repro, "projectRef") as Parameters<typeof graph.tasks>[0];
  const state = objectField(repro, "threeLane");
  const sessions = jsonArray(
    (await runSparkProcess(fixture.target, ["daemon", "session", "list", "--json"])).stdout,
  );
  assert.ok(sessions.some((session) => session.sessionId === rootSessionId));
  return {
    tasks: graph.tasks(projectRef).length,
    runs: graph.runs(projectRef).length,
    artifacts: (await defaultArtifactStore(fixture.sourceRepo).list()).length,
    routes: arrayField(state, "routes").length,
    receipts: arrayField(state, "resultReceipts").length,
    handoffs: arrayField(state, "handoffs").length,
    resolutions: arrayField(state, "resolutions").length,
  };
}

function createJourneyRounds(
  options: { compactRoot?: boolean; implementationAttention?: boolean } = {},
): ScriptedRound[] {
  const rounds: ScriptedRound[] = [];
  const audience = (label: string): ScriptedRound["audience"] => {
    if (label.startsWith("root.")) return "root";
    if (label.startsWith("implementation")) return "implementation";
    if (label.startsWith("exactness")) return "exactness";
    return "formalize";
  };
  const tool = (label: string, name: string, arguments_: Record<string, unknown>) => {
    rounds.push({
      label,
      audience: audience(label),
      toolCalls: [{ id: label, name, arguments: arguments_ }],
    });
  };
  const text = (label: string, value: string) =>
    rounds.push({ label, audience: audience(label), text: value });
  const provenance = {
    producer: "role",
    taskRef: "${BINDING_TASK_REF}",
    runRef: "${BINDING_RUN_REF}",
  };
  const common = (lane: "implementation" | "exactness" | "formalize") => ({
    schema: "spark.repro.lane-result/v1",
    reproId: "${BINDING_REPRO_ID}",
    workItemId: "${BINDING_WORK_ITEM_ID}",
    lane,
    planRevision: "${BINDING_PLAN_REVISION}",
    bindingRevision: "${BINDING_REVISION}",
    taskRef: "${BINDING_TASK_REF}",
    runRef: "${BINDING_RUN_REF}",
    sourceRevision: "${BINDING_SOURCE_REVISION}",
    originRouteId: "${BINDING_ROUTE_ID}",
  });
  const recordEvidence = (label: string, title: string, body: Record<string, unknown>) => {
    tool(label, "evidence", {
      action: "record",
      kind: "record",
      title,
      format: "json",
      body,
      provenance,
    });
  };
  const complete = (
    prefix: string,
    lane: "implementation" | "exactness" | "formalize",
    validationRef: string,
    resultRef: string,
  ) => {
    tool(`${prefix}.plan`, "impl_update_task_plan_items", {
      ops: [
        { op: "done", id: `${lane}-execute`, evidenceRefs: [validationRef] },
        { op: "done", id: `${lane}-validate`, evidenceRefs: [validationRef] },
        { op: "done", id: `${lane}-record`, evidenceRefs: [resultRef] },
      ],
    });
    tool(`${prefix}.finish`, "impl_finish_task", {
      summary: `${lane} checkpoint completed with strict TaskRun-bound Evidence.`,
      evidenceRefs: [validationRef, resultRef],
    });
    text(`${prefix}.complete`, `${lane} checkpoint is terminal; the daemon owner may advance.`);
  };

  if (options.compactRoot !== false) {
    text("root.compaction.seed", "The next turn may start a durable Repro workflow.");
  }
  tool("root.repro.start", "repro", {
    action: "start",
    objective: "复现 glm52",
  });
  text("root.repro.started", "The daemon owns the three-lane checkpoint chain.");
  if (options.implementationAttention) {
    text("root.attention.waiting", "The Root attention checkpoint is durable and dormant.");
    text("root.attention.answered", "The direct user AnswerEvent resumed the owner checkpoint.");
  }
  if (options.compactRoot !== false) {
    tool("root.repro.continued.status", "repro", { action: "status" });
    text(
      "root.repro.continued",
      "The compacted transcript resumed from the daemon-owned Repro checkpoint without replaying launch.",
    );
  }

  if (options.implementationAttention) {
    recordEvidence("implementation-attention.context", "Implementation attention context", {
      summary: "Two runnable GLM-5.2 references disagree and require a direct user decision",
    });
    recordEvidence("implementation-attention.result", "Implementation attention request", {
      ...common("implementation"),
      kind: "attention_request",
      evidenceRefs: ["${IMPLEMENTATION_ATTENTION_CONTEXT_EVIDENCE}"],
      decisionKey: "glm52-reference",
      question: "Which GLM-5.2 reference should be authoritative?",
      reason: "Two runnable references disagree on the attention contract.",
      expectedAnswerKind: "freeform",
    });
    complete(
      "implementation-attention",
      "implementation",
      "${IMPLEMENTATION_ATTENTION_CONTEXT_EVIDENCE}",
      "${IMPLEMENTATION_ATTENTION_RESULT_EVIDENCE}",
    );
  }

  tool("implementation.edit", "edit", {
    path: "target/normalize.mjs",
    edits: [
      {
        oldText: "  const denominator = variance + epsilon;",
        newText: "  const denominator = Math.sqrt(variance + epsilon);",
      },
    ],
  });
  tool("implementation.verify", "cue_exec", { command: "node verify.mjs target", timeout: 30 });
  tool("implementation.commit", "git", {
    action: "commit",
    artifactRef: "${BINDING_GIT_CHANGE_REF}",
    message: "fix: align minimal normalization",
    paths: ["target/normalize.mjs"],
  });
  tool("implementation.head", "cue_exec", { command: "git rev-parse HEAD", timeout: 30 });
  recordEvidence("implementation.validation.evidence", "Implementation validation", {
    summary: "node verify.mjs target passed after the bounded normalization repair",
  });
  recordEvidence("implementation.result", "Implementation lane result", {
    ...common("implementation"),
    kind: "implementation_candidate",
    evidenceRefs: ["${IMPLEMENTATION_VALIDATION_EVIDENCE}"],
    scope: "glm52 normalization boundary",
    candidateRevisions: ["${CANDIDATE_REVISION}"],
    dependsOnHandoffIds: [],
    doneWhen: ["Exactness independently validates the candidate revision"],
  });
  complete(
    "implementation",
    "implementation",
    "${IMPLEMENTATION_VALIDATION_EVIDENCE}",
    "${IMPLEMENTATION_RESULT_EVIDENCE}",
  );

  tool("exactness.verify", "cue_exec", { command: "node verify.mjs target", timeout: 30 });
  recordEvidence("exactness.validation.evidence", "Exactness validation", {
    summary: "Exactness independently reproduced the passing target vectors",
    firstBadBoundary: "target.normalize.denominator",
  });
  recordEvidence("exactness.result", "Exactness lane result", {
    ...common("exactness"),
    kind: "exactness_finding",
    evidenceRefs: ["${EXACTNESS_VALIDATION_EVIDENCE}"],
    finding: {
      findingId: "finding:glm52-normalization-denominator",
      firstBadBoundary: "target.normalize.denominator",
      classification: "implementation_defect",
      disposition: "fix",
      confidence: "confirmed",
      evidenceRefs: ["${EXACTNESS_VALIDATION_EVIDENCE}"],
    },
    scope: "glm52 normalization exactness",
    candidateRevisions: ["${CANDIDATE_REVISION}"],
    dependsOnHandoffIds: [],
    doneWhen: ["Formalize records the confirmed mechanism in the canonical layer"],
  });
  complete(
    "exactness",
    "exactness",
    "${EXACTNESS_VALIDATION_EVIDENCE}",
    "${EXACTNESS_RESULT_EVIDENCE}",
  );

  tool("formalize.write", "write", {
    path: "FORMALIZED.md",
    expectedVersion: "missing",
    content:
      "# Formalized normalization mechanism\n\nThe target uses sqrt(variance + epsilon), matching the independently verified reference boundary.\n",
  });
  tool("formalize.verify", "cue_exec", { command: "node verify.mjs target", timeout: 30 });
  tool("formalize.commit", "git", {
    action: "commit",
    artifactRef: "${BINDING_GIT_CHANGE_REF}",
    message: "docs: formalize verified normalization mechanism",
    paths: ["FORMALIZED.md"],
  });
  tool("formalize.head", "cue_exec", { command: "git rev-parse HEAD", timeout: 30 });
  recordEvidence("formalize.validation.evidence", "Formalize validation", {
    summary:
      "The canonical layer passed the target vectors after importing Exactness-approved history",
  });
  recordEvidence("formalize.result", "Formalize lane result", {
    ...common("formalize"),
    kind: "formalized",
    evidenceRefs: ["${FORMALIZE_VALIDATION_EVIDENCE}"],
    canonicalRevision: "${CANONICAL_REVISION}",
    supersededRevisions: ["${CANDIDATE_REVISION}"],
  });
  complete(
    "formalize",
    "formalize",
    "${FORMALIZE_VALIDATION_EVIDENCE}",
    "${FORMALIZE_RESULT_EVIDENCE}",
  );

  tool("exactness-refresh.verify", "cue_exec", {
    command: "node verify.mjs target && test -f FORMALIZED.md",
    timeout: 30,
  });
  recordEvidence("exactness-refresh.validation.evidence", "Exactness refresh validation", {
    summary: "Exactness worktree refreshed to and validated the canonical revision",
  });
  recordEvidence("exactness-refresh.result", "Exactness refresh result", {
    ...common("exactness"),
    kind: "refresh",
    evidenceRefs: ["${EXACTNESS_REFRESH_VALIDATION_EVIDENCE}"],
    canonicalRevision: "${CANONICAL_REVISION}",
    supersededRevisions: ["${CANDIDATE_REVISION}"],
    outcome: "refreshed",
  });
  complete(
    "exactness-refresh",
    "exactness",
    "${EXACTNESS_REFRESH_VALIDATION_EVIDENCE}",
    "${EXACTNESS_REFRESH_RESULT_EVIDENCE}",
  );

  tool("implementation-refresh.verify", "cue_exec", {
    command: "node verify.mjs target && test -f FORMALIZED.md",
    timeout: 30,
  });
  recordEvidence(
    "implementation-refresh.validation.evidence",
    "Implementation refresh validation",
    { summary: "Implementation worktree refreshed to and validated the canonical revision" },
  );
  recordEvidence("implementation-refresh.result", "Implementation refresh result", {
    ...common("implementation"),
    kind: "refresh",
    evidenceRefs: ["${IMPLEMENTATION_REFRESH_VALIDATION_EVIDENCE}"],
    canonicalRevision: "${CANONICAL_REVISION}",
    supersededRevisions: ["${CANDIDATE_REVISION}"],
    outcome: "refreshed",
  });
  complete(
    "implementation-refresh",
    "implementation",
    "${IMPLEMENTATION_REFRESH_VALIDATION_EVIDENCE}",
    "${IMPLEMENTATION_REFRESH_RESULT_EVIDENCE}",
  );
  return rounds;
}

async function createJourneyFixture(
  rounds: ScriptedRound[] = createJourneyRounds(),
): Promise<JourneyFixture> {
  const temporary = await realpath(
    await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-repro-journey-")),
  );
  await chmod(temporary, 0o700);
  const sourceRepo = resolve(temporary, "fixture-repo");
  const sparkHome = resolve(temporary, "spark-home");
  const binDir = resolve(temporary, "bin");
  const providerLedgerPath = resolve(temporary, "provider-ledger.json");
  const forgeLedgerPath = resolve(temporary, "forge-ledger.json");
  await Promise.all([
    mkdir(sourceRepo, { recursive: true }),
    mkdir(resolve(sparkHome, "apps/daemon"), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(resolve(temporary, "home"), { recursive: true }),
    mkdir(resolve(temporary, "xdg/run/cue-shell"), { recursive: true, mode: 0o700 }),
  ]);
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
  await writeFile(
    resolve(sparkHome, "role-model-settings.json"),
    `${JSON.stringify(
      {
        version: 2,
        modelTypes: {
          coordination: "spark-scripted/spark-scripted-provider",
          verification: "spark-scripted/spark-scripted-provider",
          implementation: "spark-scripted/spark-scripted-provider",
          exploration: "spark-scripted/spark-scripted-provider",
        },
      },
      null,
      2,
    )}\n`,
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
        compact: { keepRecentTokens: 1 },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(sparkHome, "apps/daemon/config.toml"),
    [
      'installationId = "spark-daemon-repro-golden-journey"',
      'displayName = "Repro Golden Journey"',
      "",
    ].join("\n"),
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
    SPARK_HEADLESS_EXECUTOR_MODULE: resolve(root, "apps/spark-tui/src/headless-role-executor.ts"),
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
    sourceRepo,
    sparkHome,
    providerLedgerPath,
    forgeLedgerPath,
    port,
    target: {
      command: resolve(root, "apps/spark-cli/bin/spark"),
      cwd: sourceRepo,
      env,
      timeoutMs: 120_000,
    },
  };
}

async function waitForReproCheckpoint(
  path: string,
  predicate: (repro: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return await waitFor(
    async () => {
      try {
        const snapshot = jsonObject(await readFile(path, "utf8"));
        const repro = objectField(snapshot, "repro");
        return predicate(repro) ? repro : undefined;
      } catch {
        return undefined;
      }
    },
    120_000,
    "Repro durable checkpoint",
  );
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

async function implementationLaneSessionId(
  fixture: JourneyFixture,
  repro: Record<string, unknown>,
): Promise<string> {
  const graph = await defaultTaskGraphStore(fixture.sourceRepo).load();
  assert.ok(graph);
  const projectRef = stringField(repro, "projectRef") as Parameters<typeof graph.runs>[0];
  const implementationBinding = arrayField(objectField(repro, "threeLane"), "bindings").find(
    (binding) => binding.lane === "implementation",
  );
  assert.ok(implementationBinding);
  const taskRef = stringField(implementationBinding, "taskRef");
  const sessionIds = graph
    .runs(projectRef)
    .filter((run) => run.taskRef === taskRef)
    .map((run) => run.execution?.sessionId ?? run.execution?.executionSessionId)
    .filter((sessionId): sessionId is string => Boolean(sessionId));
  assert.ok(sessionIds.length > 0);
  assert.equal(new Set(sessionIds).size, 1);
  return sessionIds[0]!;
}

async function restartDaemon(target: SparkProcessTarget): Promise<number> {
  await runSparkProcess(target, ["daemon", "restart", "--yes", "--wait"]);
  const status = jsonObject((await runSparkProcess(target, ["daemon", "status", "--json"])).stdout);
  return numberField(objectField(status, "daemon"), "pid");
}

async function compactReproRootSession(fixture: JourneyFixture, sessionId: string): Promise<void> {
  const submitted = await requestSparkDaemon(
    "session.compact",
    {
      sessionId,
      customInstructions:
        "Preserve only durable identifiers; Repro continuation must reload owner checkpoints.",
      idempotencyKey: "idem_repro_glm52_root_compaction",
    },
    { env: fixture.target.env },
  );
  const terminal = await waitForInvocation(fixture.target, submitted.invocationId, "succeeded");
  assert.match(stringField(terminal, "assistantText"), /Compacted daemon session/u);
  const snapshot = await requestSparkDaemon(
    "session.snapshot",
    { sessionId, messageLimit: 10_000 },
    { env: fixture.target.env },
  );
  assert.ok(snapshot.work?.repro, "compacted snapshot must retain the Repro work projection");
  assert.ok(
    JSON.stringify(snapshot.work.repro).length < 32_000,
    "compacted snapshot must expose only the bounded Repro projection",
  );
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
      return value.status === "succeeded" ||
        value.status === "failed" ||
        value.status === "cancelled"
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
  await runSparkProcess(target, ["hub", "web", "stop", "--json"]).catch(() => undefined);
  await Promise.all(
    [...new Set(pids)]
      .filter((pid) => pid > 0)
      .map(async (pid) => {
        await waitFor(
          async () => (isProcessAlive(pid) ? undefined : true),
          10_000,
          `daemon process ${pid} to stop`,
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
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [resolve(cwd, "verify.mjs"), implementation],
      { cwd, env: process.env, encoding: "utf8" },
    );
    return { exitCode: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    const exitCode = typeof failure.code === "number" ? failure.code : Number(failure.code);
    return {
      exitCode: Number.isInteger(exitCode) ? exitCode : 1,
      stdout: failure.stdout?.trim() ?? "",
      stderr: failure.stderr?.trim() ?? "",
    };
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

function isGitChangeArtifact(artifact: Artifact): artifact is Artifact<GitChangeArtifactBody> {
  return artifact.kind === "git_change" && artifact.body.kind === "git_change";
}

function gitChangeWorktreePath(artifact: Artifact<GitChangeArtifactBody>): string {
  const path = artifact.body.worktree.path;
  if (!path) throw new Error(`${artifact.ref} has no attached worktree path`);
  return path;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
