import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { ExtensionRoleRunner } from "@zendev-lab/spark-core";
import {
  defaultSparkDynamicWorkflowEventStore,
  defaultSparkDynamicWorkflowManager,
  defaultSparkDynamicWorkflowRunStore,
  listSavedWorkflows,
  parseWorkflowScript,
  projectWorkflowRunEvents,
  readSavedWorkflow,
  runWorkflowScript,
  type SparkDynamicWorkflowEventInput,
  type WorkflowRunEvent,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "@zendev-lab/spark-workflows";
import {
  createSparkWorkflowRoleRunAdapter,
  type SparkRoleRunResult,
} from "@zendev-lab/spark-task-runtime";
import { defaultProjectRoleModelSettingsStore } from "@zendev-lab/spark-roles";
import {
  registerSparkWorkflowRunTool,
  workflowAgentTelemetryFromRoleRun,
} from "../policy/spark-workflow-run-tool-registration.ts";
import {
  buildSparkDynamicWorkflowDashboardView,
  formatSparkDynamicWorkflowRunLine,
  renderSparkDynamicWorkflowDashboardText,
} from "../policy/spark-dynamic-workflow-run-rendering.ts";

test("spark-workflows projects zero-agent parallel helper work into dashboard tree", async () => {
  const script = `export const meta = { name: 'zero agent fanout', description: 'zero agent fanout workflow' }
stage('Fanout')
const results = await parallel([
  () => webSearch({ query: 'fanout' }),
  () => fetchContent({ url: 'https://example.test/facts' }),
  () => evidenceRecord({ title: 'Brief', body: 'Body' }),
  () => workflow('child', { marker: 'nested' }),
], { concurrency: 2 })
stage('Fanout', { status: 'success' })
return results`;
  const child = `export const meta = { name: 'child', description: 'child workflow' }
return { child: true }`;
  const events: WorkflowRunEvent[] = [];
  const run = await runWorkflowScript(script, {
    agent: async () => assert.fail("zero-agent fanout should not call agent"),
    evidenceRecord: async () => ({ ref: "evidence:fanout-brief" }),
    webSearch: (request) => ({ searched: request.query }),
    fetchContent: (request) => ({ fetched: request.url }),
    loadWorkflowScript: (name) => (name === "child" ? child : undefined),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(run.agentCount, 0);
  const snapshot = projectWorkflowRunEvents(events);
  assert.equal(snapshot.nodesById["parallel:0"]?.kind, "parallel_group");
  assert.deepEqual(snapshot.nodesById["parallel:0"]?.children, [
    "parallel:0:item:0",
    "parallel:0:item:1",
    "parallel:0:item:2",
    "parallel:0:item:3",
  ]);
  assert.equal(snapshot.nodesById["tool:0"]?.parentId, "parallel:0:item:0");
  assert.equal(snapshot.nodesById["tool:1"]?.parentId, "parallel:0:item:1");
  assert.equal(snapshot.nodesById["tool:2"]?.parentId, "parallel:0:item:2");
  assert.equal(snapshot.nodesById["artifact:evidence:fanout-brief"]?.parentId, "tool:2");
  assert.equal(snapshot.nodesById["workflow:0"]?.parentId, "parallel:0:item:3");

  const dir = await mkdtemp(join(tmpdir(), "spark-zero-agent-fanout-dashboard-"));
  try {
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const meta = parseWorkflowScript(script).meta;
    const runRef = "run:zero-agent-fanout" as const;
    await store.startRun({
      runRef,
      source: { kind: "inline", label: "zero-agent fanout dashboard" },
      script,
      meta,
      options: { concurrency: 2 },
      now: "2026-06-23T00:00:00.000Z",
    });
    for (const event of events.filter((candidate) => candidate.type !== "run_started")) {
      const { id: _id, sequence: _sequence, timestamp, type, ...input } = event;
      await store.appendEvent(runRef, {
        ...(input as SparkDynamicWorkflowEventInput),
        type,
        timestamp,
      });
    }
    const dashboard = renderSparkDynamicWorkflowDashboardText(
      buildSparkDynamicWorkflowDashboardView({
        action: "inspect",
        runs: await store.listRuns(),
        includeHistory: true,
        detailed: true,
        targetRunRef: runRef,
      }),
    );
    assert.match(dashboard, /parallel_group parallel group 1 \[succeeded\]/);
    assert.match(dashboard, /parallel_item parallel item 1 \[succeeded\]/);
    assert.match(dashboard, /tool webSearch \[succeeded\]/);
    assert.match(dashboard, /tool fetchContent \[succeeded\]/);
    assert.match(dashboard, /artifact evidence:fanout-brief \[succeeded\]/);
    assert.match(dashboard, /nested_workflow child \[succeeded\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run extracts provider usage from role-run JSON events", () => {
  const roleResult: SparkRoleRunResult = {
    record: {
      ref: "run:child-json" as `run:${string}`,
      roleRef: "role:builtin-executor" as `role:${string}`,
      roleRevision: "test-revision",
      runName: "usage child",
      instruction: "report usage",
      status: "succeeded",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:05.000Z",
      model: "fallback-model",
    },
    stdout: "",
    stderr: "",
    jsonEvents: [
      {
        type: "done",
        message: {
          role: "assistant",
          model: "provider/model",
          provider: "provider",
          timestamp: 1_782_086_400_000,
          usage: {
            input: 100,
            output: 40,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 155,
            cost: { total: 0.0123 },
          },
        },
      },
    ],
  };

  assert.deepEqual(workflowAgentTelemetryFromRoleRun(roleResult), {
    runRef: "run:child-json",
    lastActivityAt: "2026-06-22T00:00:00.000Z",
    metadata: { runRef: "run:child-json", roleStatus: "succeeded" },
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 155,
      costUsd: 0.0123,
      model: "provider/model",
      provider: "provider",
    },
  });
});

test("Spark dynamic workflow dashboard renders isolated Graft agent provenance", async () => {
  const script = `export const meta = { name: 'graft ui', description: 'graft UI workflow' }
stage('Edit')
const result = await agent('edit file', { label: 'isolated editor', isolation: 'graft' })
stage('Edit', { status: 'success' })
return result`;
  const events: WorkflowRunEvent[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-executor",
    graftBaseRef: "tree:base",
    async runRoleInstruction() {
      return {
        text: "created scratch:edit candidate:edit patch:edit",
        metadata: { validation: "passed", candidateRef: "candidate:edit", patchRef: "patch:edit" },
      };
    },
  });
  await runWorkflowScript(script, {
    agent,
    onEvent: (event) => {
      events.push(event);
    },
  });
  const snapshot = projectWorkflowRunEvents(events);
  assert.deepEqual(snapshot.nodesById["agent:0"]?.telemetry?.metadata?.graftRefs, {
    scratchRefs: ["scratch:edit"],
    candidateRefs: ["candidate:edit"],
    patchRefs: ["patch:edit"],
  });

  const dir = await mkdtemp(join(tmpdir(), "spark-graft-provenance-dashboard-"));
  try {
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const meta = parseWorkflowScript(script).meta;
    const runRef = "run:graft-provenance" as const;
    await store.startRun({
      runRef,
      source: { kind: "inline", label: "graft provenance dashboard" },
      script,
      meta,
      options: {},
      base: {
        baseRef: "tree:base",
        baseState: "state:base",
        baseTree: "tree:base",
        capturedAt: "2026-06-23T00:00:00.000Z",
      },
      now: "2026-06-23T00:00:00.000Z",
    });
    for (const event of events.filter((candidate) => candidate.type !== "run_started")) {
      const { id: _id, sequence: _sequence, timestamp, type, ...input } = event;
      await store.appendEvent(runRef, {
        ...(input as SparkDynamicWorkflowEventInput),
        type,
        timestamp,
      });
    }
    const dashboard = renderSparkDynamicWorkflowDashboardText(
      buildSparkDynamicWorkflowDashboardView({
        action: "inspect",
        runs: await store.listRuns(),
        includeHistory: true,
        detailed: true,
        targetRunRef: runRef,
      }),
    );
    assert.match(dashboard, /agent isolated editor \[succeeded\]/);
    assert.match(dashboard, /Graft: status=admitted/);
    assert.match(dashboard, /scratch=scratch:edit/);
    assert.match(dashboard, /candidate=candidate:edit/);
    assert.match(dashboard, /patch=patch:edit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark dynamic workflow event store migrates v1 dynamic records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-event-migrate-"));
  try {
    const oldStore = defaultSparkDynamicWorkflowRunStore(dir);
    const eventStore = defaultSparkDynamicWorkflowEventStore(dir);
    const script = `export const meta = { name: 'legacy', description: 'legacy workflow' }
return 'ok'`;
    const meta = parseWorkflowScript(script).meta;
    const legacyRun = await oldStore.start({
      source: { kind: "inline", label: "legacy inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:00:00.000Z",
    });
    await oldStore.recordPhase(legacyRun.ref, {
      title: "Legacy phase",
      status: "success",
      startedAt: "2026-06-23T00:00:01.000Z",
      finishedAt: "2026-06-23T00:00:02.000Z",
    });
    await oldStore.recordJournal(legacyRun.ref, {
      index: 0,
      hash: "hash-0",
      result: "legacy agent result",
    });
    await oldStore.finish(legacyRun.ref, {
      meta,
      result: { migrated: true },
      phases: [
        {
          title: "Legacy phase",
          status: "success",
          startedAt: "2026-06-23T00:00:01.000Z",
          finishedAt: "2026-06-23T00:00:02.000Z",
        },
      ],
      agentCount: 1,
      journal: [{ index: 0, hash: "hash-0", result: "legacy agent result" }],
    });
    await oldStore.acknowledge(legacyRun.ref);
    await oldStore.saveAsWorkspaceWorkflow({
      cwd: dir,
      runRef: legacyRun.ref,
      workflowId: "legacy-migrated",
    });

    const pausedRun = await oldStore.start({
      source: { kind: "inline", label: "paused inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:01:00.000Z",
    });
    await oldStore.pause(pausedRun.ref, "pause migration");
    const stoppedRun = await oldStore.start({
      source: { kind: "inline", label: "stopped inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:02:00.000Z",
    });
    await oldStore.stop(stoppedRun.ref, "stop migration");
    const staleRun = await oldStore.start({
      source: { kind: "inline", label: "stale inline" },
      script,
      meta,
      options: {},
      now: "2026-06-23T00:03:00.000Z",
    });
    await oldStore.reconcileStale({ now: "2026-06-23T00:03:10.000Z", staleAfterMs: 1 });

    const migrated = await eventStore.migrateFromV1Snapshot(await oldStore.load());
    assert.equal(migrated.length, 4);
    const snapshot = migrated.find((candidate) => candidate.runRef === legacyRun.ref);
    assert.ok(snapshot);
    assert.equal(snapshot.status, "succeeded");
    assert.equal(snapshot.nodesById["phase:Legacy phase"]?.status, "succeeded");
    assert.equal(snapshot.nodesById["agent:0"]?.result, "legacy agent result");
    assert.deepEqual(snapshot.result, { migrated: true });
    assert.equal((await eventStore.getSnapshot(pausedRun.ref))?.status, "paused");
    assert.equal((await eventStore.getSnapshot(stoppedRun.ref))?.status, "stopped");
    assert.equal((await eventStore.getSnapshot(staleRun.ref))?.status, "stale");
    assert.deepEqual(
      (await eventStore.readEvents(legacyRun.ref)).map((event) => event.type),
      ["run_started", "phase_started", "phase_finished", "agent_succeeded", "run_succeeded"],
    );
    assert.deepEqual(
      (await eventStore.readEvents(pausedRun.ref)).map((event) => event.type),
      ["run_started", "run_paused"],
    );
    assert.deepEqual(
      (await eventStore.readEvents(stoppedRun.ref)).map((event) => event.type),
      ["run_started", "run_stopped"],
    );
    assert.deepEqual(
      (await eventStore.readEvents(staleRun.ref)).map((event) => event.type),
      ["run_started", "run_stale"],
    );
    const metadata = await eventStore.getMetadata(legacyRun.ref);
    assert.ok(metadata?.acknowledgedAt);
    assert.equal(metadata.savedWorkflow?.selector, "workspace:legacy-migrated");
    const compatible = await eventStore.toDynamicWorkflowRunRecord(legacyRun.ref);
    assert.ok(compatible);
    assert.equal(compatible.acknowledgedAt, metadata.acknowledgedAt);
    assert.equal(compatible.savedWorkflow?.selector, "workspace:legacy-migrated");
    assert.match(formatSparkDynamicWorkflowRunLine(compatible), /legacy/);
    const statuses = new Set(
      (await eventStore.listDynamicWorkflowRunRecords()).map((record) => record.status),
    );
    assert.deepEqual(statuses, new Set(["succeeded", "paused", "stopped", "stale"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run tool routes default agents through ctx.runRole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-native-role-"));
  try {
    await defaultProjectRoleModelSettingsStore(dir).save("implementation", "test/model");
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: {
          cwd: string;
          model?: { provider: string; id: string; api?: string };
          runRole?: ExtensionRoleRunner;
        },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool((config) =>
      tools.set(config.name, config as unknown as TestWorkflowRunTool),
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const nativeInputs: Parameters<ExtensionRoleRunner>[0][] = [];
    const runRole: ExtensionRoleRunner = async (input) => {
      nativeInputs.push(input);
      return {
        record: { ...input.record, status: "succeeded", finishedAt: "2026-06-22T00:00:00.000Z" },
        stdout: "native workflow agent output",
        stderr: "",
        jsonEvents: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "native workflow agent output" }],
            },
          },
        ],
      };
    };

    const script = `export const meta = { name: 'native role', description: 'native role workflow' }
return await agent('use native role', { label: 'native-agent', model: 'test/model' })`;
    const result = await tool.execute(
      "tool-call",
      { script, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir, model: { provider: "test", id: "model", api: "openai-responses" }, runRole },
    );

    assert.match(result.content[0]?.text ?? "", /Workflow run completed/);
    assert.equal(nativeInputs.length, 1);
    assert.equal(nativeInputs[0]?.role.ref, "role:builtin-executor");
    assert.equal(nativeInputs[0]?.model, "test/model");
    assert.equal(nativeInputs[0]?.cwd, dir);
    assert.equal(nativeInputs[0]?.usageExecutionKind, "workflow_agent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run tool persists, resumes, and keeps original base metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-run-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    const agentPrompts: string[] = [];
    const agentRunnerBases: Array<string | undefined> = [];
    let baseCaptures = 0;
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: (input) => {
          agentRunnerBases.push(input.base?.baseTree);
          return async (prompt) => {
            agentPrompts.push(prompt);
            return `result:${prompt}`;
          };
        },
        captureBase: () => {
          baseCaptures += 1;
          return {
            baseRef: "graft:test-base",
            baseState: `state-${baseCaptures}`,
            baseTree: `tree-${baseCaptures}`,
            capturedAt: "2026-06-22T00:00:00.000Z",
          };
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'persistent inline', description: 'persistent inline workflow' }
return await agent('hello ' + args.suffix, { label: 'hello' })`;
    const first = await tool.execute(
      "tool-call",
      { script, args: { suffix: "one" }, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const firstDetails = first.details as {
      workflow: {
        runRef: string;
        status: string;
        journalEntries: number;
        base?: { baseState?: string };
      };
    };
    assert.equal(firstDetails.workflow.status, "succeeded");
    assert.equal(firstDetails.workflow.journalEntries, 1);
    assert.equal(firstDetails.workflow.base?.baseState, "state-1");
    assert.deepEqual(agentPrompts, ["hello one"]);

    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const stored = await store.get(firstDetails.workflow.runRef as `run:${string}`);
    assert.ok(stored);
    assert.equal(stored.script, script);
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.journal.length, 1);
    assert.equal(stored.result, "result:hello one");
    assert.equal(stored.base?.baseState, "state-1");
    const eventsBeforeResume = await store.readEvents(stored.ref);
    assert.deepEqual(
      eventsBeforeResume.map((event) => event.type),
      [
        "run_started",
        "agent_started",
        "agent_succeeded",
        "run_succeeded",
        "agent_succeeded",
        "run_succeeded",
      ],
    );
    const metadataBeforeResume = await store.getMetadata(stored.ref);
    assert.ok(metadataBeforeResume);
    assert.equal((await defaultSparkDynamicWorkflowRunStore(dir).load()).runs.length, 0);
    assert.deepEqual(agentRunnerBases, ["tree-1"]);

    agentPrompts.length = 0;
    const resumed = await tool.execute(
      "tool-call",
      { runRef: firstDetails.workflow.runRef, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const resumedDetails = resumed.details as {
      workflow: {
        runRef: string;
        status: string;
        journalEntries: number;
        base?: { baseState?: string };
      };
    };
    assert.equal(resumedDetails.workflow.runRef, firstDetails.workflow.runRef);
    assert.equal(resumedDetails.workflow.status, "succeeded");
    assert.equal(resumedDetails.workflow.journalEntries, 1);
    assert.equal(resumedDetails.workflow.base?.baseState, "state-1");
    assert.deepEqual(agentPrompts, []);
    const eventsAfterResume = await store.readEvents(stored.ref);
    assert.deepEqual(
      eventsAfterResume.slice(0, eventsBeforeResume.length).map((event) => event.type),
      eventsBeforeResume.map((event) => event.type),
    );
    assert.ok(
      eventsAfterResume
        .slice(eventsBeforeResume.length)
        .some((event) => event.type === "agent_cached"),
      "expected resume to append cached-agent event without replacing prior events",
    );
    assert.equal((await store.getMetadata(stored.ref))?.createdAt, metadataBeforeResume.createdAt);
    assert.deepEqual(agentRunnerBases, ["tree-1", "tree-1"]);
    assert.equal(baseCaptures, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run streams live onUpdate events before wait=true completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-live-onupdate-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    const updates: string[] = [];
    let refreshes = 0;
    let releaseAgent!: (value: string) => void;
    const agentGate = new Promise<string>((resolve) => {
      releaseAgent = resolve;
    });
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => async () => agentGate,
        refreshSparkWidget: async () => {
          refreshes += 1;
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'live updates', description: 'live update workflow' }
stage('Live')
return await agent('wait for update', { label: 'live-child' })`;
    let completed = false;
    const running = tool
      .execute(
        "tool-call",
        { script, wait: true },
        new AbortController().signal,
        (update) => updates.push(update.content.map((part) => part.text).join("\n")),
        { cwd: dir },
      )
      .finally(() => {
        completed = true;
      });

    for (
      let attempt = 0;
      attempt < 200 && !updates.some((update) => /agent_started/.test(update));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      completed,
      false,
      "wait=true call should still be open while the agent is blocked",
    );
    assert.ok(
      updates.some((update) => /stage_started Live/.test(update)),
      updates.join("\n---\n"),
    );
    assert.ok(
      updates.some((update) => /agent_started live-child/.test(update)),
      updates.join("\n---\n"),
    );
    assert.equal(refreshes >= 2, true);

    releaseAgent("live result");
    const result = await running;
    assert.match(result.content[0].text, /Workflow run completed: inline workflow/);
    assert.equal(completed, true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("Spark workflow_run returns before background DynamicWorkflowManager completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-background-manager-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let releaseAgent!: (value: string) => void;
    const agentGate = new Promise<string>((resolve) => {
      releaseAgent = resolve;
    });
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      { createAgentRunner: () => async () => agentGate },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'background', description: 'background workflow' }
return await agent('slow child', { label: 'slow-child' })`;
    const publishedViews: unknown[] = [];
    const result = await tool.execute(
      "tool-call",
      { script },
      new AbortController().signal,
      () => undefined,
      {
        cwd: dir,
        ui: { publishView: (event: unknown) => publishedViews.push(event) },
      } as { cwd: string },
    );
    const details = result.details as { workflow: { runRef: `run:${string}`; status: string } };
    assert.equal(details.workflow.status, "running");
    assert.match(result.content[0].text, /Workflow run started: inline workflow/);
    assert.match(result.content[0].text, /background DynamicWorkflowManager/);
    assert.match(JSON.stringify(publishedViews), new RegExp(details.workflow.runRef));
    assert.match(JSON.stringify(publishedViews), /"dynamicStatus":"running"/);

    const store = defaultSparkDynamicWorkflowEventStore(dir);
    assert.equal((await store.get(details.workflow.runRef))?.status, "running");
    const managerCompletion = defaultSparkDynamicWorkflowManager().wait(details.workflow.runRef);
    assert.ok(managerCompletion, "background workflow should remain owned by the manager");
    releaseAgent("background result");
    let completed = await store.get(details.workflow.runRef);
    let events = await store.readEvents(details.workflow.runRef);
    for (
      let attempt = 0;
      attempt < 50 && (completed?.status !== "succeeded" || events.length < 6);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await store.get(details.workflow.runRef);
      events = await store.readEvents(details.workflow.runRef);
    }
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.result, "background result");
    assert.match(JSON.stringify(publishedViews), /"dynamicStatus":"succeeded"/);
    assert.deepEqual(events.map((event) => event.type).slice(0, 4), [
      "run_started",
      "agent_started",
      "agent_succeeded",
      "run_succeeded",
    ]);
    assert.equal((await managerCompletion).status, "succeeded");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("Spark DynamicWorkflowManager applies pause, resume, stop, and restart to active runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-real-controls-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const manager = defaultSparkDynamicWorkflowManager();
    const tools = new Map<string, TestWorkflowRunTool>();
    let firstAgentStarted = false;
    let secondAgentStarted = false;
    let releaseFirstAgent!: () => void;
    const firstAgentGate = new Promise<void>((resolve) => {
      releaseFirstAgent = resolve;
    });
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 1) {
              firstAgentStarted = true;
              await firstAgentGate;
              return "first";
            }
            secondAgentStarted = true;
            return "second";
          };
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");
    const script = `export const meta = { name: 'controls', description: 'pause resume workflow' }
const first = await agent('first', { label: 'first' })
const second = await agent('second', { label: 'second' })
return { first, second }`;
    const started = await tool.execute(
      "tool-call",
      { script },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const runRef = (started.details as { workflow: { runRef: `run:${string}` } }).workflow.runRef;
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    for (let attempt = 0; attempt < 50 && !firstAgentStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(firstAgentStarted, true);
    await manager.pause(store, runRef);
    assert.equal((await store.get(runRef))?.status, "paused");
    releaseFirstAgent();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondAgentStarted, false, "pause should block the next agent checkpoint");
    await manager.resume(store, runRef);
    let completed = await store.get(runRef);
    for (let attempt = 0; attempt < 50 && completed?.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await store.get(runRef);
    }
    assert.equal(secondAgentStarted, true);
    assert.equal(completed?.status, "succeeded");
    assert.deepEqual(completed?.result, { first: "first", second: "second" });
    assert.ok(
      (await store.readEvents(runRef)).some(
        (event) => event.type === "control_applied" && event.data && typeof event.data === "object",
      ),
      "expected pause/resume controls to record control_applied events",
    );

    const stopTools = new Map<string, TestWorkflowRunTool>();
    let stopSignal: AbortSignal | undefined;
    let stopAgentStarted = false;
    registerSparkWorkflowRunTool(
      (config) => stopTools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: ({ signal }) => {
          stopSignal = signal;
          return async () => {
            stopAgentStarted = true;
            await new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
            );
          };
        },
      },
    );
    const stopTool = stopTools.get("workflow_run");
    assert.ok(stopTool, "missing workflow_run tool");
    const stopStarted = await stopTool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'stop control', description: 'stop workflow' }
return await agent('never finishes', { label: 'blocked' })`,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const stopRunRef = (stopStarted.details as { workflow: { runRef: `run:${string}` } }).workflow
      .runRef;
    for (let attempt = 0; attempt < 50 && !stopAgentStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stopAgentStarted, true);
    await manager.stop(store, stopRunRef);
    assert.equal(stopSignal?.aborted, true);
    assert.equal((await store.get(stopRunRef))?.status, "stopped");

    const restartTools = new Map<string, TestWorkflowRunTool>();
    let restartFactoryCalls = 0;
    let restartAgentCalls = 0;
    let firstRestartSignal: AbortSignal | undefined;
    registerSparkWorkflowRunTool(
      (config) => restartTools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: ({ signal }) => {
          restartFactoryCalls += 1;
          if (!firstRestartSignal) firstRestartSignal = signal;
          return async () => {
            restartAgentCalls += 1;
            if (restartAgentCalls === 1) {
              await new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("restart abort")), {
                  once: true,
                }),
              );
            }
            return `restart-result-${restartAgentCalls}`;
          };
        },
      },
    );
    const restartTool = restartTools.get("workflow_run");
    assert.ok(restartTool, "missing workflow_run tool");
    const restartStarted = await restartTool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'restart control', description: 'restart workflow' }
return await agent('restart me', { label: 'restart-child' })`,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const restartRunRef = (restartStarted.details as { workflow: { runRef: `run:${string}` } })
      .workflow.runRef;
    for (let attempt = 0; attempt < 50 && restartAgentCalls < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(restartAgentCalls, 1);
    await manager.restart(store, restartRunRef);
    assert.equal(firstRestartSignal?.aborted, true);
    let restartedRun = await store.get(restartRunRef);
    for (let attempt = 0; attempt < 50 && restartedRun?.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      restartedRun = await store.get(restartRunRef);
    }
    assert.equal(restartFactoryCalls >= 2, true);
    assert.equal(restartAgentCalls >= 2, true);
    assert.equal(restartedRun?.status, "succeeded");
    assert.equal(restartedRun?.result, "restart-result-2");
    assert.ok(
      (await store.readEvents(restartRunRef)).some(
        (event) =>
          event.type === "control_applied" &&
          Boolean(event.data) &&
          typeof event.data === "object" &&
          !Array.isArray(event.data) &&
          (event.data as { action?: unknown }).action === "restart",
      ),
      "expected restart to record control_applied action",
    );
    await manager.wait(runRef);
    await manager.wait(stopRunRef);
    await manager.wait(restartRunRef);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("Spark workflow_run persists and renders real workflow agent telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-telemetry-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => async (_prompt, options) => {
          options.reportTelemetry?.({
            runRef: "run:child-usage",
            lastActivityAt: "2026-06-22T00:00:02.000Z",
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              costUsd: 0.025,
              model: "fake-model",
              provider: "fake-provider",
            },
          });
          return "telemetry result";
        },
        now: () => "2026-06-22T00:00:00.000Z",
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'telemetry', description: 'telemetry workflow' }
return await agent('collect usage', { label: 'usage-agent' })`;
    const result = await tool.execute(
      "tool-call",
      { script, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const runRef = (result.details as { workflow: { runRef: string } }).workflow.runRef;
    const stored = await defaultSparkDynamicWorkflowEventStore(dir).get(runRef as `run:${string}`);
    assert.ok(stored);
    assert.deepEqual(stored.usageTotals, {
      actualTokens: 15,
      estimatedTokens: 0,
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.025,
    });
    assert.equal(stored.spentTokens, 15);
    assert.equal(stored.agentTelemetry?.[0]?.label, "usage-agent");
    assert.equal(stored.agentTelemetry?.[0]?.usage?.source, "actual");
    assert.equal(stored.agentTelemetry?.[0]?.runRef, "run:child-usage");
    assert.match(formatSparkDynamicWorkflowRunLine(stored), /tokens=15 cost=\$0\.0250/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run tool executes inline and saved workflow scripts through injected runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-run-tool-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    const seen: Array<{
      script: string;
      args: unknown;
      tokenBudget?: number;
      concurrency?: number;
      hasWebSearch: boolean;
      hasFetchContent: boolean;
      hasLoadWorkflowScript: boolean;
    }> = [];
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        createAgentRunner: () => async () => "agent output",
        resolveScript: async ({ selector }) => ({
          label: selector,
          script: `export const meta = { name: 'saved', description: 'saved workflow' }
return 'saved-result'`,
        }),
        async runWorkflow<T = unknown>(
          script: string,
          options: WorkflowRunOptions,
        ): Promise<WorkflowRunResult<T>> {
          seen.push({
            script,
            args: options.args,
            tokenBudget: options.tokenBudget ?? undefined,
            concurrency: options.concurrency,
            hasWebSearch: typeof options.webSearch === "function",
            hasFetchContent: typeof options.fetchContent === "function",
            hasLoadWorkflowScript: typeof options.loadWorkflowScript === "function",
          });
          const stages = [
            { title: "Done", startedAt: "2026-06-18T00:00:00.000Z", status: "success" },
          ] as WorkflowRunResult<T>["phases"];
          return {
            meta: parseWorkflowScript(script).meta,
            result: { ok: true, args: options.args } as T,
            stages,
            phases: stages,
            agentCount: 2,
            journal: [],
          };
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const inline = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'inline', description: 'inline workflow' }
return 'inline-result'`,
        args: { focus: "demo" },
        tokenBudget: 50,
        concurrency: 3,
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    assert.match(inline.content[0].text, /Workflow run completed: inline workflow/);
    assert.match(inline.content[0].text, /╭─ Workflow inline \[succeeded\]/);
    assert.match(inline.content[0].text, /│ stages\s+✓ Done/);
    assert.match(inline.content[0].text, /│ controls\s+inspect: task_read/);
    assert.match(
      inline.content[0].text,
      /╰─ Result \(compact JSON; complete value is in details\.workflow\.result\)/,
    );
    const inlineDetails = inline.details as { workflow: { agentCount: number } };
    assert.equal(inlineDetails.workflow.agentCount, 2);
    assert.equal(seen[0]?.tokenBudget, 50);
    assert.equal(seen[0]?.concurrency, 3);
    assert.equal(seen[0]?.hasWebSearch, true);
    assert.equal(seen[0]?.hasFetchContent, true);
    assert.equal(seen[0]?.hasLoadWorkflowScript, true);

    await tool.execute(
      "tool-call",
      { selector: "builtin:research", args: { question: "demo" }, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    assert.match(seen[1]?.script ?? "", /name: 'saved'/);
    assert.deepEqual(seen[1]?.args, { question: "demo" });
    const persisted = await defaultSparkDynamicWorkflowEventStore(dir).load();
    assert.deepEqual(
      persisted.runs.map((run) => run.source.kind),
      ["inline", "selector"],
    );
    assert.equal(persisted.runs[1]?.source.selector, "builtin:research");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run blocks risky workflows until approved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-approval-deny-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let createdAgent = false;
    let ranWorkflow = false;
    let approvalRiskFlags: string[] = [];
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        approveRun: ({ summary }) => {
          approvalRiskFlags = summary.riskFlags;
          return { approved: false, reason: "test denied" };
        },
        createAgentRunner: () => {
          createdAgent = true;
          return async () => "agent output";
        },
        async runWorkflow<T = unknown>(): Promise<WorkflowRunResult<T>> {
          ranWorkflow = true;
          throw new Error("should not execute");
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const script = `export const meta = { name: 'needs approval', description: 'web workflow' }
return await webSearch({ query: 'approval smoke' })`;
    await assert.rejects(
      () =>
        tool.execute("tool-call", { script }, new AbortController().signal, () => undefined, {
          cwd: dir,
        }),
      /workflow_run approval denied: test denied/,
    );
    assert.deepEqual(approvalRiskFlags, ["web_or_fetch"]);
    assert.equal(createdAgent, false);
    assert.equal(ranWorkflow, false);
    const persisted = await defaultSparkDynamicWorkflowEventStore(dir).load();
    assert.equal(persisted.runs.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run approval resolves selected role tool policies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-role-approval-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<unknown>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let observed:
      | {
          riskFlags: string[];
          tools: string[];
          roles: string[];
          roleBindings: Array<{
            selector?: string;
            roleRef: string;
            roleRevision: string;
          }>;
        }
      | undefined;
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        approveRun: ({ summary }) => {
          observed = {
            riskFlags: summary.riskFlags,
            tools: summary.tools,
            roles: summary.roles,
            roleBindings: summary.roleBindings,
          };
          return { approved: false, reason: "test inspected role policy" };
        },
        createAgentRunner: () => async () => "should not run",
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    await assert.rejects(
      () =>
        tool.execute(
          "tool-call",
          {
            script: `export const meta = { name: 'role approval', description: 'role policy smoke' }
return await agent('bounded work', { role: 'executor' })`,
          },
          new AbortController().signal,
          () => undefined,
          { cwd: dir },
        ),
      /workflow_run approval denied: test inspected role policy/,
    );
    assert.deepEqual(observed?.roles, ["role:builtin-executor"]);
    assert.equal(observed?.roleBindings[0]?.selector, "executor");
    assert.equal(observed?.roleBindings[0]?.roleRef, "role:builtin-executor");
    assert.match(observed?.roleBindings[0]?.roleRevision ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.ok(observed?.tools.includes("cue_exec"));
    assert.ok(observed?.tools.includes("write"));
    assert.deepEqual(observed?.riskFlags, ["role_policies", "shell_tools", "write_tools"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run records scoped approval provenance for risky workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-approval-allow-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let approvalSource = "";
    let approvedRoleBindings:
      | Array<{ selector?: string; roleRef: string; roleRevision: string }>
      | undefined;
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        approveRun: ({ summary }) => {
          approvalSource = summary.source;
          assert.deepEqual(summary.riskFlags, ["role_policies", "shell_tools", "write_tools"]);
          approvedRoleBindings = summary.roleBindings;
          assert.equal(summary.resources.stageCount, 0);
          assert.equal(summary.resources.phaseCount, 0);
          return { approved: true, method: "reviewer", reason: "bounded executor delegation" };
        },
        createAgentRunner: () => async () => "agent output",
        now: () => "2026-06-22T12:00:00.000Z",
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const result = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'approved role', description: 'role workflow' }
return await agent('bounded work', { role: 'executor' })`,
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    assert.equal(approvalSource, "inline workflow");
    const runRef = (result.details as { workflow: { runRef: string } }).workflow.runRef;
    const stored = await defaultSparkDynamicWorkflowEventStore(dir).get(runRef as `run:${string}`);
    assert.ok(stored);
    assert.equal(stored.approval?.status, "approved");
    assert.equal(stored.approval?.method, "reviewer");
    assert.equal(stored.approval?.reason, "bounded executor delegation");
    assert.deepEqual(stored.approval?.summary.riskFlags, [
      "role_policies",
      "shell_tools",
      "write_tools",
    ]);
    assert.deepEqual(stored.approval?.summary.roleBindings, approvedRoleBindings);
    assert.equal(stored.approval?.summary.roleBindings?.[0]?.selector, "executor");
    assert.equal(stored.approval?.summary.roleBindings?.[0]?.roleRef, "role:builtin-executor");
    assert.match(
      stored.approval?.summary.roleBindings?.[0]?.roleRevision ?? "",
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.match(formatSparkDynamicWorkflowRunLine(stored), /approval=reviewer:role_policies/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run executes an ultracode-style generated workflow script", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-ultracode-smoke-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    let approvedRiskFlags: string[] = [];
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      {
        approveRun: ({ summary }) => {
          approvedRiskFlags = summary.riskFlags;
          return { approved: true, method: "reviewer", reason: "bounded ultracode smoke" };
        },
        createAgentRunner: () => async (_prompt, options) => {
          if (options.label === "planner") return "draft execution plan";
          if (options.label?.startsWith("verify ")) return { real: true };
          if (options.label === "completeness critic") return { complete: true };
          return "agent output";
        },
      },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const result = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'ultracode smoke', description: 'bounded generated workflow', stages: [{ title: 'Plan' }, { title: 'Verify' }, { title: 'Synthesize' }] }
stage('Plan')
const draft = await agent('Draft a short execution plan for ' + args.focus, { label: 'planner' })
stage('Verify')
const verdict = await verify(draft, { reviewers: 2, threshold: 0.5 })
const complete = await completenessCheck(args, { draft, verdict })
stage('Synthesize', { status: 'success' })
return { draft, verdict, complete }`,
        args: { focus: "workflow parity" },
        concurrency: 2,
        maxAgents: 6,
        tokenBudget: 1000,
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    assert.deepEqual(approvedRiskFlags, ["fan_out"]);
    const details = result.details as {
      workflow: {
        status: string;
        result: { draft: string; verdict: { real: boolean }; complete: { complete: boolean } };
      };
    };
    assert.equal(details.workflow.status, "succeeded");
    assert.equal(details.workflow.result.draft, "draft execution plan");
    assert.equal(details.workflow.result.verdict.real, true);
    assert.equal(details.workflow.result.complete.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dynamic workflow save uses collision-safe workspace selectors that rerun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-save-reuse-"));
  try {
    const script = `export const meta = { name: 'Reusable Flow', description: 'saved reusable workflow' }
return { reused: true, args }
`;
    const parsed = parseWorkflowScript(script);
    const store = defaultSparkDynamicWorkflowRunStore(dir);
    const run = await store.start({
      source: { kind: "inline", label: "generated reusable workflow" },
      script,
      args: { first: true },
      meta: parsed.meta,
      options: {},
    });
    const occupiedDirectory = join(dir, ".agents", "workflows", "reuse");
    await mkdir(occupiedDirectory, { recursive: true });
    await writeFile(join(occupiedDirectory, "workflow.js"), "existing user content\n", "utf8");
    const first = await store.saveAsWorkflow({ cwd: dir, runRef: run.ref, workflowId: "reuse" });
    const second = await store.saveAsWorkflow({ cwd: dir, runRef: run.ref, workflowId: "reuse" });
    assert.equal(first?.selector, "workspace:reuse-2");
    assert.equal(second?.selector, "workspace:reuse-3");
    assert.equal(
      await readFile(join(occupiedDirectory, "workflow.js"), "utf8"),
      "existing user content\n",
    );

    const eventOccupiedDirectory = join(dir, ".agents", "workflows", "event-reuse");
    await mkdir(eventOccupiedDirectory, { recursive: true });
    await writeFile(
      join(eventOccupiedDirectory, "workflow.js"),
      "existing event-store content\n",
      "utf8",
    );
    const eventStore = defaultSparkDynamicWorkflowEventStore(dir);
    const eventRun = await eventStore.start({
      source: { kind: "inline", label: "generated event-store workflow" },
      script,
      meta: parsed.meta,
      options: {},
    });
    const eventSaved = await eventStore.saveAsWorkflow({
      cwd: dir,
      runRef: eventRun.ref,
      workflowId: "event-reuse",
    });
    assert.equal(eventSaved?.selector, "workspace:event-reuse-2");
    assert.equal(
      await readFile(join(eventOccupiedDirectory, "workflow.js"), "utf8"),
      "existing event-store content\n",
    );

    const canonicalized = await store.saveAsWorkflow({
      cwd: dir,
      runRef: run.ref,
      workflowId: "under_score",
    });
    assert.equal(canonicalized?.selector, "workspace:under-score");
    await assert.doesNotReject(() =>
      readSavedWorkflow({ cwd: dir, selector: canonicalized?.selector ?? "" }),
    );

    const concurrent = await Promise.all([
      store.saveAsWorkflow({ cwd: dir, runRef: run.ref, workflowId: "reuse" }),
      store.saveAsWorkflow({ cwd: dir, runRef: run.ref, workflowId: "reuse" }),
    ]);
    assert.deepEqual(
      concurrent
        .map((saved) => saved?.selector)
        .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
      ["workspace:reuse-4", "workspace:reuse-5"],
    );

    const listed = await listSavedWorkflows(dir, { includeUser: false });
    assert.deepEqual(
      listed.workflows
        .map((workflow) => workflow.selector)
        .filter((selector) => selector.startsWith("workspace:reuse"))
        .sort(),
      ["workspace:reuse-2", "workspace:reuse-3", "workspace:reuse-4", "workspace:reuse-5"],
    );
    const saved = await readSavedWorkflow({ cwd: dir, selector: second?.selector ?? "" });
    assert.match(saved.script, /reused: true/u);

    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      { createAgentRunner: () => async () => "agent output" },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");
    const result = await tool.execute(
      "tool-call",
      { selector: second?.selector, args: { rerun: true }, wait: true },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );
    const details = result.details as { workflow: { result: { reused: boolean; args: unknown } } };
    assert.equal(details.workflow.result.reused, true);
    assert.deepEqual(details.workflow.result.args, { rerun: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dynamic workflow save preserves multi-stage runtime semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-save-stages-"));
  try {
    const script = `export const meta = {
  name: 'Multi-stage flow',
  description: 'saved multi-stage workflow',
  stages: [{ title: 'Scan' }, { title: 'Report' }],
}
stage('Scan')
stage('Report')
return { preserved: true }
`;
    const parsed = parseWorkflowScript(script);
    const store = defaultSparkDynamicWorkflowRunStore(dir);
    const run = await store.start({
      source: { kind: "inline", label: "generated multi-stage workflow" },
      script,
      meta: parsed.meta,
      options: {},
    });
    const saved = await store.saveAsWorkflow({ cwd: dir, runRef: run.ref, workflowId: "stages" });
    const resolved = await readSavedWorkflow({ cwd: dir, selector: saved?.selector ?? "" });
    const rerun = await runWorkflowScript(resolved.script, { agent: async () => "unused" });

    assert.deepEqual(
      rerun.stages?.map((stage) => stage.title),
      ["Scan", "Report"],
    );
    assert.equal((rerun.result as { preserved: boolean }).preserved, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark workflow_run tool resolves controlled nested saved workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-run-nested-"));
  try {
    type TestWorkflowRunTool = {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: () => void,
        ctx: { cwd: string },
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }>;
    };
    await mkdir(join(dir, ".agents", "workflows", "child"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "workflows", "child", "WORKFLOW.md"),
      `---
id: child
title: child
description: saved child workflow
stages:
  - id: run
    handler: child.js
---
Run the saved child workflow.
`,
      "utf8",
    );
    await writeFile(
      join(dir, ".agents", "workflows", "child", "child.js"),
      `return { marker: 'saved-child', args }
`,
      "utf8",
    );
    const tools = new Map<string, TestWorkflowRunTool>();
    registerSparkWorkflowRunTool(
      (config) => tools.set(config.name, config as unknown as TestWorkflowRunTool),
      { createAgentRunner: () => async () => "agent output" },
    );
    const tool = tools.get("workflow_run");
    assert.ok(tool, "missing workflow_run tool");

    const result = await tool.execute(
      "tool-call",
      {
        script: `export const meta = { name: 'parent', description: 'parent workflow' }
return await workflow('workspace:child', { focus: args.focus })`,
        args: { focus: "nested-demo" },
        wait: true,
      },
      new AbortController().signal,
      () => undefined,
      { cwd: dir },
    );

    assert.match(result.content[0].text, /Workflow run completed: inline workflow/);
    const details = result.details as { workflow: { result: { marker: string; args: unknown } } };
    assert.equal(details.workflow.result.marker, "saved-child");
    assert.deepEqual(details.workflow.result.args, { focus: "nested-demo" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
