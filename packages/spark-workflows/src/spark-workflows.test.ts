import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  defaultSparkDynamicWorkflowEventStore,
  defaultSparkDynamicWorkflowRunStore,
  fanOutWithBriefWorkflowScript,
  listSavedWorkflows,
  parseWorkflowScript,
  projectWorkflowRunEvents,
  readSavedWorkflow,
  researchWorkflowScript,
  reviewWorkflowScript,
  resolveWorkflowDefinition,
  runWorkflowScript,
  type WorkflowRunEvent,
} from "./index.ts";
import {
  createSparkWorkflowRoleRunAdapter,
  SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS,
  type SparkWorkflowGraftAgentResult,
  type SparkWorkflowRoleRunRequest,
} from "@zendev-lab/spark-runtime";

test("spark-workflows package stays isolated from runtime execution packages", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  assert.equal(pkg.dependencies?.["@zendev-lab/spark-runtime"], undefined);
  assert.equal(pkg.dependencies?.["@zendev-lab/spark-roles"], undefined);
  assert.equal(pkg.dependencies?.["spark-goal"], undefined);
});

test("spark-workflows parses metadata without executing expressions", () => {
  assert.throws(
    () =>
      parseWorkflowScript(`export const meta = {
  name: (() => { throw new Error('meta executed') })(),
  description: 'Demo workflow',
}`),
    /unsupported identifier|expected identifier/,
  );

  const parsed = parseWorkflowScript(`export const meta = {
  name: 'demo { literal }',
  description: "Demo // workflow",
  stages: [
    // braces in comments should not terminate metadata: { }
    { title: 'Scan' },
  ],
}
return 'ok'`);

  assert.equal(parsed.meta.name, "demo { literal }");
  assert.equal(parsed.meta.description, "Demo // workflow");
  assert.deepEqual(parsed.meta.stages, [{ title: "Scan" }]);
  assert.deepEqual(parsed.meta.phases, [{ title: "Scan" }]);
  assert.equal(parsed.body, "return 'ok'");
});

test("spark-workflows rejects duplicate normalized metadata stage titles", () => {
  assert.throws(
    () =>
      parseWorkflowScript(`export const meta = {
  name: 'ambiguous stages',
  description: 'Duplicate stage titles silently collapse runtime identity.',
  stages: [{ title: 'Scan' }, { title: ' Scan ' }],
}`),
    /stages\[1\]\.title duplicates workflow meta\.stages\[0\]\.title: "Scan"/u,
  );
});

test("spark-workflows parses metadata and runs sandbox primitives with journal", async () => {
  const script = `export const meta = {
  name: 'demo',
  description: 'Demo workflow',
  stages: [{ title: 'Scan' }, { title: 'Report' }],
}

stage('Scan')
const scan = await agent('scan repo', { label: 'scan' })
stage('Report')
const [a, b] = await parallel([
  () => agent('check a', { label: 'a' }),
  () => agent('check b', { label: 'b' }),
])
return { scan, a, b }`;

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "demo");
  assert.deepEqual(
    parsed.meta.stages?.map((stage) => stage.title),
    ["Scan", "Report"],
  );

  const prompts: string[] = [];
  const result = await runWorkflowScript(script, {
    agent: async (prompt) => {
      prompts.push(prompt);
      return "result: " + prompt;
    },
  });
  assert.deepEqual(prompts, ["scan repo", "check a", "check b"]);
  assert.deepEqual(
    result.stages?.map((stage) => stage.title),
    ["Scan", "Report"],
  );
  assert.deepEqual(
    result.phases.map((stage) => stage.title),
    ["Scan", "Report"],
  );
  assert.equal(result.agentCount, 3);
  assert.equal(result.journal.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    scan: "result: scan repo",
    a: "result: check a",
    b: "result: check b",
  });

  const replayPrompts: string[] = [];
  const replay = await runWorkflowScript(script, {
    resumeJournal: new Map(result.journal.map((entry) => [entry.index, entry])),
    agent: async (prompt) => {
      replayPrompts.push(prompt);
      return "rerun: " + prompt;
    },
  });
  assert.deepEqual(replayPrompts, []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay.result)),
    JSON.parse(JSON.stringify(result.result)),
  );
});

test("spark-workflows lists and reads builtin workflows without frontmatter mode", async () => {
  const listing = await listSavedWorkflows(".", {
    includeUser: false,
    workspaceWorkflowDir: "/definitely/missing/spark-workflows",
  });

  assert.deepEqual(listing.errors, []);
  assert.deepEqual(
    listing.workflows.map((workflow) => workflow.selector),
    [
      "builtin:research",
      "builtin:review",
      "builtin:repro",
      "builtin:repro-stage-orchestrate",
      "builtin:repro-module-sweep",
      "builtin:repro-first-divergence",
      "builtin:repro-change-loop",
      "builtin:repro-long-horizon",
      "builtin:repro-axis-qualify",
      "builtin:repro-topology-compose",
      "builtin:repro-evidence-review",
      "builtin:repro-delivery-sync",
    ],
  );
  assert.deepEqual(
    listing.workflows.map((workflow) => workflow.phase),
    [
      "plan",
      "plan",
      "implement",
      "implement",
      "implement",
      "implement",
      "implement",
      "implement",
      "implement",
      "implement",
      "plan",
      "implement",
    ],
  );

  const { descriptor, script } = await readSavedWorkflow({
    cwd: ".",
    selector: "builtin:research",
    includeUser: false,
  });
  assert.equal(descriptor.source, "builtin");
  assert.equal(descriptor.phase, "plan");
  assert.equal(descriptor.path, "builtin:research");
  assert.deepEqual(descriptor.stages, ["plan", "search", "fetch", "verify", "report"]);
  assert.match(script, /export const meta/);
  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "research");
  assert.equal("mode" in parsed.meta, false);

  await assert.rejects(
    () => readSavedWorkflow({ cwd: ".", selector: "builtin:missing", includeUser: false }),
    /unknown builtin workflow: missing/,
  );
  await assert.rejects(
    () => readSavedWorkflow({ cwd: ".", selector: "inline:demo", includeUser: false }),
    /workflow selector must be builtin:<id>, workspace:<id>, or user:<id>/,
  );
});

test("spark-workflows rejects legacy top-level saved workflow scripts during discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-canonical-filename-"));
  const workflowDir = join(dir, "workflows");
  try {
    await mkdir(workflowDir, { recursive: true });
    const path = join(workflowDir, "under_score.js");
    await writeFile(
      path,
      `export const meta = { name: 'underscored', description: 'cannot round-trip' }`,
    );

    const listing = await listSavedWorkflows(dir, {
      includeUser: false,
      workspaceWorkflowDir: workflowDir,
    });

    assert.equal(
      listing.workflows.some((workflow) => workflow.source === "workspace"),
      false,
    );
    assert.equal(listing.errors.length, 1);
    assert.equal(listing.errors[0]?.path, path);
    assert.match(
      listing.errors[0]?.error ?? "",
      /legacy top-level workflow script under_score\.js is rejected/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WORKFLOW.md v2 extends builtin:repro additively and hashes handler content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-v2-repro-"));
  const root = join(dir, "workflows");
  const workflowDir = join(root, "strict-repro");
  try {
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "WORKFLOW.md"),
      `---
id: strict-repro
title: Strict Repro
extends: builtin:repro
skills: [numerical-review]
roles: [role:reviewer]
stages:
  - id: independent-review
    handler: review.js
loop:
  beforeTick:
    - id: workspace-ready
      when:
        kind: expression
        expression: { op: literal, value: true }
      then: { action: proceed }
---
Add an independent numerical review without weakening Repro gates.
`,
      "utf8",
    );
    await writeFile(join(workflowDir, "review.js"), "return { reviewed: true }\n", "utf8");

    const first = await resolveWorkflowDefinition({
      cwd: dir,
      selector: "workspace:strict-repro",
      includeUser: false,
      workspaceWorkflowDir: root,
    });
    assert.deepEqual(
      first.stages.map((stage) => stage.id),
      ["contract", "reference", "target", "alignment", "delivery", "independent-review"],
    );
    assert.equal(first.loop.completion?.selector, "builtin:repro-reviewer");
    assert.equal(first.loop.beforeTick[0]?.id, "repro-pending-decision");
    assert.equal(first.loop.beforeTick[1]?.id, "workspace-ready");
    assert.equal(first.workbench, "live");
    assert.match(first.script, /reviewed: true/u);

    await writeFile(join(workflowDir, "review.js"), "return { reviewed: 'again' }\n", "utf8");
    const changed = await resolveWorkflowDefinition({
      cwd: dir,
      selector: "workspace:strict-repro",
      includeUser: false,
      workspaceWorkflowDir: root,
    });
    assert.notEqual(changed.digest, first.digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WORKFLOW.md v2 fails closed on unknown fields and weakened Repro policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-v2-invalid-"));
  const root = join(dir, "workflows");
  try {
    await mkdir(join(root, "unknown"), { recursive: true });
    await writeFile(
      join(root, "unknown", "WORKFLOW.md"),
      `---\nid: unknown\ntitle: Unknown\ncommand: unsafe\n---\nReject unknown fields.\n`,
    );
    await assert.rejects(
      () =>
        resolveWorkflowDefinition({
          cwd: dir,
          selector: "workspace:unknown",
          workspaceWorkflowDir: root,
        }),
      /unknown fields: command/u,
    );

    await mkdir(join(root, "weak-repro"), { recursive: true });
    await writeFile(
      join(root, "weak-repro", "WORKFLOW.md"),
      `---
id: weak-repro
title: Weak Repro
extends: builtin:repro
workbench: checkpoint
---
Attempt to weaken the live workbench.
`,
    );
    await assert.rejects(
      () =>
        resolveWorkflowDefinition({
          cwd: dir,
          selector: "workspace:weak-repro",
          workspaceWorkflowDir: root,
        }),
      /cannot weaken builtin:repro workbench policy/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark-workflows research builtin fans out with collected errors and report synthesis", async () => {
  const { descriptor, script } = await readSavedWorkflow({
    cwd: ".",
    selector: "builtin:research",
    includeUser: false,
  });
  assert.equal(descriptor.source, "builtin");
  assert.equal(descriptor.phase, "plan");
  assert.deepEqual(descriptor.stages, ["plan", "search", "fetch", "verify", "report"]);

  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "research");
  assert.equal("mode" in parsed.meta, false);

  const agentCalls: Array<{ prompt: string; label?: string; model?: string; agentType?: string }> =
    [];
  const run = await runWorkflowScript(researchWorkflowScript(), {
    args: {
      question: "Should research live in workflows?",
      panelModels: [
        { label: "fast", model: "provider/fast" },
        { label: "blocked", model: "provider/blocked" },
      ],
      judgeModel: "provider/judge",
    },
    agent: async (prompt, options) => {
      agentCalls.push({
        prompt,
        label: options.label,
        model: options.model,
        agentType: options.agentType,
      });
      if (options.label === "blocked") throw new Error("MODEL_BLOCKED");
      if (options.label === "write cited report") return "final synthesis";
      return "panel answer from " + options.label;
    },
    webSearch: (request) => ({
      answer: "search answer for " + (request.query ?? ""),
      results: [{ title: "source", url: "https://example.test/source" }],
    }),
    fetchContent: (request) => ({ url: request.url, text: "source facts" }),
  });

  assert.equal(run.agentCount, 5);
  assert.deepEqual(
    run.stages?.map((stage) => stage.title),
    ["Plan", "Search", "Fetch", "Verify", "Report"],
  );
  assert.deepEqual(
    agentCalls.map((call) => call.label),
    ["research plan", "fast", "blocked", "cross-check sources", "write cited report"],
  );
  assert.deepEqual(
    agentCalls.map((call) => call.agentType),
    [undefined, "model", "model", undefined, "model"],
  );
  assert.equal(agentCalls[1]?.model, "provider/fast");
  assert.equal(agentCalls[4]?.model, "provider/judge");
  assert.match(agentCalls[1]?.prompt ?? "", /Assess the source evidence/);
  assert.match(agentCalls[3]?.prompt ?? "", /MODEL_BLOCKED/);
  assert.match(agentCalls[4]?.prompt ?? "", /final user-facing deep research report/);
  assert.equal((run.result as { report?: unknown }).report, "final synthesis");
});

test("spark-workflows exposes and runs workflow script factories", async () => {
  const research = parseWorkflowScript(researchWorkflowScript());
  assert.equal(research.meta.name, "research");
  assert.deepEqual(
    research.meta.stages?.map((stage) => stage.title),
    ["Plan", "Search", "Fetch", "Verify", "Report"],
  );

  const review = parseWorkflowScript(reviewWorkflowScript());
  assert.equal(review.meta.name, "review");
  assert.deepEqual(
    review.meta.stages?.map((stage) => stage.title),
    ["Investigate", "Critique", "Rebut", "Verdict"],
  );

  const fanOut = parseWorkflowScript(fanOutWithBriefWorkflowScript());
  assert.equal(fanOut.meta.name, "fan_out_with_brief");
  assert.deepEqual(
    fanOut.meta.stages?.map((stage) => stage.title),
    ["Brief", "Fan out", "Fan in"],
  );

  const researchRun = await runWorkflowScript(researchWorkflowScript(), {
    args: { question: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(researchRun.agentCount, 5);
  assert.deepEqual(
    researchRun.stages?.map((stage) => stage.title),
    ["Plan", "Search", "Fetch", "Verify", "Report"],
  );

  const reviewRun = await runWorkflowScript(reviewWorkflowScript(), {
    args: { task: "workflow smoke" },
    agent: async (_prompt, options) => options.label ?? "agent",
  });
  assert.equal(reviewRun.agentCount, 5);
  assert.deepEqual(
    reviewRun.stages?.map((stage) => stage.title),
    ["Investigate", "Critique", "Rebut", "Verdict"],
  );
});

test("spark-workflows records explicit stage statuses", async () => {
  const script = `export const meta = {
    name: 'stage status',
    description: 'Stage status workflow',
  }

  stage('Scan')
  await agent('scan work', { label: 'scan' })
  stage('Scan', { status: 'success' })
  stage('Skipped', { status: 'skip' })
  return 'done'`;

  const stageEvents: Array<{
    title: string;
    status?: string;
    startedAt: string;
    finishedAt?: string;
  }> = [];
  const run = await runWorkflowScript(script, {
    now: (() => {
      let tick = 0;
      return () => `2026-06-09T00:00:0${tick++}.000Z`;
    })(),
    agent: async (_prompt, options) => options.stage ?? "none",
    onStage: (event) => stageEvents.push(event),
  });

  assert.deepEqual(run.stages, [
    {
      title: "Scan",
      status: "success",
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:01.000Z",
    },
    {
      title: "Skipped",
      status: "skip",
      startedAt: "2026-06-09T00:00:02.000Z",
      finishedAt: "2026-06-09T00:00:02.000Z",
    },
  ]);
  assert.deepEqual(stageEvents, [
    { title: "Scan", startedAt: "2026-06-09T00:00:00.000Z" },
    {
      title: "Scan",
      status: "success",
      startedAt: "2026-06-09T00:00:00.000Z",
      finishedAt: "2026-06-09T00:00:01.000Z",
    },
    {
      title: "Skipped",
      status: "skip",
      startedAt: "2026-06-09T00:00:02.000Z",
      finishedAt: "2026-06-09T00:00:02.000Z",
    },
  ]);
});

test("spark-workflows emits typed run events and projects snapshots", async () => {
  const script = `export const meta = { name: 'eventful', description: 'eventful workflow' }
stage('Plan')
const web = await webSearch({ query: 'events' })
const values = await parallel([
  () => agent('first', { label: 'first' }),
  () => fetchContent({ url: 'https://example.test/source' }),
], { concurrency: 2 })
stage('Plan', { status: 'success' })
return { web, values }`;
  const events: WorkflowRunEvent[] = [];

  const run = await runWorkflowScript(script, {
    agent: async (_prompt, options) => ({ label: options.label, ok: true }),
    webSearch: (request) => ({ query: request.query, results: [] }),
    fetchContent: (request) => ({ url: request.url, text: "content" }),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(run.result && typeof run.result === "object", true);
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type !== "parallel_item_succeeded"),
    [
      "run_started",
      "stage_started",
      "tool_started",
      "tool_succeeded",
      "parallel_group_started",
      "parallel_item_started",
      "agent_started",
      "parallel_item_started",
      "tool_started",
      "tool_succeeded",
      "agent_succeeded",
      "parallel_group_succeeded",
      "stage_finished",
      "run_succeeded",
    ],
  );
  assert.ok(events.some((event) => event.type === "parallel_item_succeeded"));
  const snapshot = projectWorkflowRunEvents(events);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.meta?.name, "eventful");
  assert.deepEqual(
    snapshot.nodes.map((node) => [node.kind, node.label, node.status]),
    [
      ["run", "eventful", "succeeded"],
      ["stage", "Plan", "succeeded"],
      ["tool", "webSearch", "succeeded"],
      ["parallel_group", "parallel group 1", "succeeded"],
      ["parallel_item", "parallel item 1", "succeeded"],
      ["agent", "first", "succeeded"],
      ["parallel_item", "parallel item 2", "succeeded"],
      ["tool", "fetchContent", "succeeded"],
    ],
  );
  assert.deepEqual(
    snapshot.stages.map((stage) => stage.id),
    ["stage:Plan"],
  );
  assert.deepEqual(
    snapshot.phases.map((stage) => stage.id),
    ["stage:Plan"],
  );
  assert.deepEqual(snapshot.nodesById["parallel:0"]?.children, [
    "parallel:0:item:0",
    "parallel:0:item:1",
  ]);
  assert.equal(snapshot.nodesById["parallel:0"]?.parentId, "stage:Plan");
  assert.equal(snapshot.nodesById["agent:0"]?.parentId, "parallel:0:item:0");
  assert.equal(snapshot.nodesById["tool:1"]?.parentId, "parallel:0:item:1");
});

test("spark-workflows serializes asynchronous live event delivery", async () => {
  const events: WorkflowRunEvent["type"][] = [];
  let releaseStage!: () => void;
  let enterStage!: () => void;
  const stageGate = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  const stageEntered = new Promise<void>((resolve) => {
    enterStage = resolve;
  });
  const running = runWorkflowScript(
    `export const meta = { name: 'ordered-events', description: 'ordered events' }
stage('Plan')
return await agent('work', { label: 'worker' })`,
    {
      agent: async () => "done",
      onEvent: async (event) => {
        if (event.type === "stage_started") {
          enterStage();
          await stageGate;
        }
        events.push(event.type);
      },
    },
  );

  await stageEntered;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.includes("agent_started"), false);
  releaseStage();
  await running;

  assert.ok(events.indexOf("stage_started") < events.indexOf("agent_started"));
  assert.ok(events.indexOf("agent_started") < events.indexOf("agent_succeeded"));
});

test("spark-workflows projects failed run and node events", async () => {
  const script = `export const meta = { name: 'failed events', description: 'failed event workflow' }
stage('Work')
await agent('explode', { label: 'boom' })`;
  const events: WorkflowRunEvent[] = [];

  await assert.rejects(
    () =>
      runWorkflowScript(script, {
        agent: async () => {
          throw new Error("agent exploded");
        },
        onEvent: (event) => {
          events.push(event);
        },
      }),
    /agent exploded/,
  );

  const snapshot = projectWorkflowRunEvents(events);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.errorMessage, "agent exploded");
  assert.equal(snapshot.nodesById["agent:0"]?.status, "failed");
  assert.equal(snapshot.nodesById["agent:0"]?.errorMessage, "agent exploded");
});

test("spark-workflows projects status-only, artifact, log, nested, cached, and helper error events", async () => {
  const statusOnlyEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'status only', description: 'status-only stage' }
stage('Skipped', { status: 'skip' })
log('note from workflow')
return 'ok'`,
    {
      agent: async () => "unused",
      onEvent: (event) => {
        statusOnlyEvents.push(event);
      },
    },
  );
  const statusOnly = projectWorkflowRunEvents(statusOnlyEvents);
  assert.equal(statusOnly.nodesById["stage:Skipped"]?.status, "skipped");
  assert.ok(
    statusOnly.eventTail.some(
      (event) => event.type === "log" && event.message === "note from workflow",
    ),
  );

  const artifactEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'artifact events', description: 'artifact event workflow' }
return await evidenceRecord({ title: 'Brief', body: 'Body' })`,
    {
      agent: async () => "unused",
      evidenceRecord: async () => ({ ref: "evidence:brief" }),
      onEvent: (event) => {
        artifactEvents.push(event);
      },
    },
  );
  const artifactSnapshot = projectWorkflowRunEvents(artifactEvents);
  assert.equal(artifactSnapshot.nodesById["artifact:evidence:brief"]?.kind, "artifact");
  assert.equal(artifactSnapshot.nodesById["artifact:evidence:brief"]?.status, "succeeded");

  const child = `export const meta = { name: 'child', description: 'child workflow' }
stage('Child')
return { child: true }`;
  const nestedEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'parent', description: 'parent workflow' }
const child = await workflow('child')
return child`,
    {
      agent: async () => "unused",
      loadWorkflowScript: (name) => (name === "child" ? child : undefined),
      onEvent: (event) => {
        nestedEvents.push(event);
      },
    },
  );
  assert.deepEqual(
    nestedEvents
      .filter((event) => event.type.startsWith("nested_workflow"))
      .map((event) => event.type),
    ["nested_workflow_started", "nested_workflow_succeeded"],
  );
  assert.equal(new Set(nestedEvents.map((event) => event.sequence)).size, nestedEvents.length);
  assert.equal(projectWorkflowRunEvents(nestedEvents).nodesById["workflow:0"]?.status, "succeeded");

  const initial = await runWorkflowScript(
    `export const meta = { name: 'cache source', description: 'cache source workflow' }
return await agent('cached', { label: 'cached agent' })`,
    { agent: async () => "cached-result" },
  );
  const cachedEvents: WorkflowRunEvent[] = [];
  await runWorkflowScript(
    `export const meta = { name: 'cache source', description: 'cache source workflow' }
return await agent('cached', { label: 'cached agent' })`,
    {
      resumeJournal: new Map(initial.journal.map((entry) => [entry.index, entry])),
      agent: async () => assert.fail("cached agent should not run"),
      onEvent: (event) => {
        cachedEvents.push(event);
      },
    },
  );
  assert.equal(projectWorkflowRunEvents(cachedEvents).nodesById["agent:0"]?.status, "cached");

  const helperErrorEvents: WorkflowRunEvent[] = [];
  await assert.rejects(
    () =>
      runWorkflowScript(
        `export const meta = { name: 'helper error', description: 'helper error workflow' }
return await webSearch({ query: 'boom' })`,
        {
          agent: async () => "unused",
          webSearch: () => {
            throw new Error("search exploded");
          },
          onEvent: (event) => {
            helperErrorEvents.push(event);
          },
        },
      ),
    /search exploded/,
  );
  const helperError = projectWorkflowRunEvents(helperErrorEvents);
  assert.equal(helperError.status, "failed");
  assert.equal(helperError.nodesById["tool:0"]?.status, "failed");
  assert.equal(helperError.nodesById["tool:0"]?.errorMessage, "search exploded");
});

test("spark-workflows applies stage model defaults and per-agent overrides", async () => {
  const script = `export const meta = {
    name: 'model routing',
    description: 'Model routing workflow',
    stages: [{ title: 'Scan', model: 'provider/stage-model' }],
  }

  stage('Scan')
  await agent('stage default', { label: 'default' })
  await agent('agent override', { label: 'override', model: 'provider/agent-model' })`;

  const models: Array<string | undefined> = [];
  await runWorkflowScript(script, {
    agent: async (_prompt, options) => {
      models.push(options.model);
      return "ok";
    },
  });

  assert.deepEqual(models, ["provider/stage-model", "provider/agent-model"]);
});

test("spark-workflows fan_out_with_brief records one brief and fans out with evidenceRef", async () => {
  const prompts: string[] = [];
  const artifactInputs: Array<{ title: string; body: string; kind?: string; format?: string }> = [];

  const run = await runWorkflowScript(fanOutWithBriefWorkflowScript(), {
    args: {
      briefTitle: "Audit brief",
      briefBody: "Shared context for all workers.",
      agents: [
        { name: "task", prompt: "audit task output", label: "Task auditor" },
        { name: "artifact", prompt: "audit artifact output" },
      ],
      concurrency: 1,
    },
    evidenceRecord: async (input) => {
      artifactInputs.push(input);
      return { ref: "evidence:brief-xyz" };
    },
    agent: async (prompt, options) => {
      prompts.push(prompt);
      assert.equal(options.evidenceRef, "evidence:brief-xyz");
      return "result:" + options.label;
    },
  });

  assert.deepEqual(artifactInputs, [
    {
      title: "Audit brief",
      body: "Shared context for all workers.",
      kind: "research",
      format: "markdown",
    },
  ]);
  assert.equal(run.agentCount, 2);
  assert.deepEqual(
    run.stages?.map((stage) => `${stage.title}:${stage.status ?? "open"}`),
    ["Brief:success", "Fan out:success", "Fan in:open"],
  );
  assert.match(prompts[0] ?? "", /CONTEXT_BUNDLE: read evidence ref evidence:brief-xyz/);
  assert.match(prompts[0] ?? "", /audit task output/);
  assert.match(prompts[1] ?? "", /audit artifact output/);
  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), {
    briefRef: "evidence:brief-xyz",
    outputs: [
      { name: "task", label: "Task auditor", result: "result:Task auditor" },
      { name: "artifact", label: "artifact", result: "result:artifact" },
    ],
  });
});

test("spark-workflows fan_out_with_brief requires artifact recorder", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript(fanOutWithBriefWorkflowScript(), {
        args: { briefBody: "brief", agents: [{ name: "one", prompt: "work" }] },
        agent: async () => "unused",
      }),
    /evidenceRecord adapter is required/,
  );
});

test("spark-workflows rejects unsupported workflow agent isolation", async () => {
  for (const isolation of ["container", "worktree"]) {
    const script = `export const meta = { name: 'isolation', description: 'isolation test' }
await agent('check isolation', { isolation: '${isolation}' })`;

    await assert.rejects(
      () =>
        runWorkflowScript(script, {
          agent: async () => "should not run",
        }),
      /workflow agent isolation must be 'graft'/,
    );
  }
});

test("spark-workflows graft isolation smoke keeps parallel same-path edits in separate refs", async () => {
  const requests: SparkWorkflowRoleRunRequest[] = [];
  const agent = createSparkWorkflowRoleRunAdapter({
    roleRef: "role:builtin-worker",
    graftBaseRef: "tree:base-smoke",
    async runRoleInstruction(request) {
      requests.push(request);
      const suffix = request.label.endsWith("A") ? "a" : "b";
      return {
        text: `edited shared.txt through scratch:${suffix} candidate:${suffix}`,
      };
    },
  });
  const script = `export const meta = { name: 'graft isolation smoke', description: 'parallel isolated edit smoke' }
return await parallel([
  () => agent('edit shared.txt to say A', { label: 'worker A', isolation: 'graft' }),
  () => agent('edit shared.txt to say B', { label: 'worker B', isolation: 'graft' }),
], { concurrency: 2 })`;

  const run = await runWorkflowScript(script, { agent });

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.env?.GRAFT_BASE_REF),
    ["tree:base-smoke", "tree:base-smoke"],
  );
  for (const request of requests) {
    assert.deepEqual(request.allowedTools, SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS);
    assert.match(request.instruction, /Graft isolation is active/);
    assert.match(request.instruction, /shared\.txt/);
  }
  const results = run.result as SparkWorkflowGraftAgentResult[];
  assert.deepEqual(
    results.map((result) => result.graftRefs.candidateRefs[0]),
    ["candidate:a", "candidate:b"],
  );
  assert.deepEqual(
    results.map((result) => result.graftRefs.scratchRefs[0]),
    ["scratch:a", "scratch:b"],
  );
});

test("spark-workflows parallel limits concurrency", async () => {
  const script = `export const meta = { name: 'parallel limit', description: 'limit test' }
let active = 0
let maxActive = 0
const output = await parallel([1, 2, 3, 4].map((value) => async () => {
  active += 1
  maxActive = Math.max(maxActive, active)
  await new Promise((resolve) => setTimeout(resolve, 5))
  active -= 1
  return value
}), { concurrency: 2 })
return { output, maxActive }`;

  const run = await runWorkflowScript(script, { agent: async () => "unused" });

  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), {
    output: [1, 2, 3, 4],
    maxActive: 2,
  });
});

test("spark-workflows parallel retries failures and can collect rejected results", async () => {
  const script = `export const meta = { name: 'parallel retry', description: 'retry test' }
const attempts = { flaky: 0, bad: 0 }
const retried = await parallel([
  async () => {
    attempts.flaky += 1
    if (attempts.flaky < 2) throw new Error('not yet')
    return 'ok'
  },
], { retry: { attempts: 2 } })
const collected = await parallel([
  async () => 'good',
  async () => {
    attempts.bad += 1
    throw new Error('bad')
  },
], { retry: { attempts: 2 }, onError: 'collect' })
return { attempts, retried, collected }`;

  const run = await runWorkflowScript(script, { agent: async () => "unused" });
  const result = JSON.parse(JSON.stringify(run.result)) as {
    attempts: { flaky: number; bad: number };
    retried: string[];
    collected: Array<{ status: string; value?: string; attempts: number }>;
  };

  assert.equal(result.attempts.flaky, 2);
  assert.equal(result.attempts.bad, 2);
  assert.deepEqual(result.retried, ["ok"]);
  assert.equal(result.collected[0]?.status, "fulfilled");
  assert.equal(result.collected[0]?.value, "good");
  assert.equal(result.collected[1]?.status, "rejected");
  assert.equal(result.collected[1]?.attempts, 2);
});

test("spark-workflows agent evidenceRef prepends context bundle prompt", async () => {
  const script = `export const meta = { name: 'brief', description: 'evidence ref test' }
return await agent('do the work', { label: 'worker', evidenceRef: 'evidence:brief-123' })`;
  const prompts: string[] = [];

  const run = await runWorkflowScript(script, {
    agent: async (prompt, options) => {
      prompts.push(prompt);
      assert.equal(options.evidenceRef, "evidence:brief-123");
      return "done";
    },
  });

  assert.match(prompts[0] ?? "", /CONTEXT_BUNDLE: read evidence ref evidence:brief-123/);
  assert.match(prompts[0] ?? "", /Workflow agent request:\ndo the work/);
  assert.equal(run.result, "done");
});

test("spark-workflows rejects Artifact refs at Evidence boundaries", async () => {
  const negativeValues = JSON.parse(
    await readFile(
      new URL("../../../test/fixtures/evidence-surface/negative-values.json", import.meta.url),
      "utf8",
    ),
  ) as { wrongNamespaceRef: string };
  const invalidAgentScript = `export const meta = { name: 'invalid ref', description: 'reject product ref' }
return await agent('do the work', { evidenceRef: '${negativeValues.wrongNamespaceRef}' })`;
  await assert.rejects(
    () => runWorkflowScript(invalidAgentScript, { agent: async () => "unused" }),
    /evidenceRef must be an evidence: ref/,
  );

  const invalidRecorderScript = `export const meta = { name: 'invalid recorder', description: 'reject product result' }
return await evidenceRecord({ title: 'Brief', body: 'Body' })`;
  await assert.rejects(
    () =>
      runWorkflowScript(invalidRecorderScript, {
        agent: async () => "unused",
        evidenceRecord: async () => ({ ref: negativeValues.wrongNamespaceRef as never }),
      }),
    /must return an evidence: ref/,
  );
});

test("spark-workflows rejects empty child delivery instead of journaling success", async () => {
  const script = `export const meta = { name: 'empty delivery', description: 'empty delivery test' }
await agent('child', { label: 'child' })`;

  await assert.rejects(
    () =>
      runWorkflowScript(script, {
        agent: async () => ({
          delivery: { status: "empty", message: "No final assistant message found" },
        }),
      }),
    /workflow agent child produced empty delivery: No final assistant message found/,
  );
});

test("spark-workflows requires metadata as the first executable workflow statement", () => {
  assert.throws(
    () =>
      parseWorkflowScript(`const hidden = true
export const meta = { name: 'late', description: 'late meta' }
return hidden`),
    /must start with export const meta/,
  );

  const parsed = parseWorkflowScript(`// leading comments are allowed
export const meta = { name: 'first', description: 'first meta' }
return 'ok'`);
  assert.equal(parsed.meta.name, "first");
});

test("spark-workflows runtime hardens deterministic resume against wall-clock randomness", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript(
        `export const meta = { name: 'nondeterministic', description: 'nondeterministic test' }
return Date.now()`,
        { agent: async () => "unused" },
      ),
    /Date\.now\(\) is unavailable/,
  );

  await assert.rejects(
    () =>
      runWorkflowScript(
        `export const meta = { name: 'random', description: 'random test' }
return Math.random()`,
        { agent: async () => "unused" },
      ),
    /Math\.random\(\) is unavailable/,
  );
});

test("spark-workflows resume replays only the unchanged prefix", async () => {
  const script = `export const meta = { name: 'resume prefix', description: 'resume prefix test' }
await agent(args && args.changed ? 'changed first' : 'original first', { label: 'first' })
await agent('static second', { label: 'second' })
return 'done'`;
  const initial = await runWorkflowScript(script, {
    args: { changed: false },
    agent: async (_prompt, options) => options.label,
  });

  const livePrompts: string[] = [];
  const replay = await runWorkflowScript(script, {
    args: { changed: true },
    resumeJournal: new Map(initial.journal.map((entry) => [entry.index, entry])),
    agent: async (prompt, options) => {
      livePrompts.push(`${options.label}:${prompt}`);
      return `live ${options.label}`;
    },
  });

  assert.deepEqual(livePrompts, ["first:changed first", "second:static second"]);
  assert.deepEqual(
    replay.journal.map((entry) => entry.result),
    ["live first", "live second"],
  );
});

test("spark-workflows exposes quality helpers, item pipelines, retry, and gate", async () => {
  const script = `export const meta = { name: 'quality helpers', description: 'quality helpers test' }
const verdict = await verify('claim', { reviewers: 3, threshold: 0.66 })
const best = await judgePanel(['weak', 'strong'], { judges: 2, rubric: 'test rubric' })
const found = await loopUntilDry({
  round: (index) => index === 0 ? ['a', 'a', 'b'] : [],
  maxRounds: 4,
})
const piped = await pipeline([1, 2], (value) => value * 2, (value) => value + 1)
const retried = await retry((index) => index, { attempts: 3, until: (value) => value === 2 })
const gated = await gate(
  (feedback) => feedback || 'draft',
  (value) => value === 'fixed' ? { ok: true } : { ok: false, feedback: 'fixed' },
  { attempts: 2 },
)
return { verdict, best, found, piped, retried, gated }`;

  const events: WorkflowRunEvent[] = [];
  const run = await runWorkflowScript(script, {
    agent: async (_prompt, options) => {
      if (options.label?.startsWith("verify ")) return { real: options.label !== "verify 1" };
      if (options.label?.startsWith("judge 2.")) return { score: 0.9 };
      if (options.label?.startsWith("judge ")) return { score: 0.1 };
      return "unused";
    },
    onEvent: (event) => {
      events.push(event);
    },
  });
  const result = JSON.parse(JSON.stringify(run.result)) as {
    verdict: { real: boolean; realCount: number; total: number };
    best: { index: number; score: number; attempt: string };
    found: string[];
    piped: number[];
    retried: number;
    gated: { ok: boolean; value: string; attempts: number };
  };

  assert.deepEqual(result.verdict, {
    real: true,
    realCount: 2,
    total: 3,
    votes: [{ real: false }, { real: true }, { real: true }],
  });
  assert.equal(result.best.index, 1);
  assert.equal(result.best.attempt, "strong");
  assert.equal(result.best.score, 0.9);
  assert.deepEqual(result.found, ["a", "b"]);
  assert.deepEqual(result.piped, [3, 5]);
  assert.equal(result.retried, 2);
  assert.deepEqual(result.gated, { ok: true, value: "fixed", attempts: 2 });
  const snapshot = projectWorkflowRunEvents(events);
  const verifyNode = snapshot.nodes.find((node) => node.kind === "tool" && node.label === "verify");
  const judgePanelNode = snapshot.nodes.find(
    (node) => node.kind === "tool" && node.label === "judgePanel",
  );
  assert.ok(verifyNode, "expected verify helper node");
  assert.ok(judgePanelNode, "expected judgePanel helper node");
  assert.ok(
    verifyNode.children.some((childId) => snapshot.nodesById[childId]?.kind === "parallel_group"),
    "expected verify helper fan-out under the verify node",
  );
  assert.ok(
    judgePanelNode.children.some(
      (childId) => snapshot.nodesById[childId]?.kind === "parallel_group",
    ),
    "expected judgePanel helper fan-out under the judgePanel node",
  );
});

test("spark-workflows enforces run and stage token budgets between agent calls", async () => {
  const runBudgetScript = `export const meta = { name: 'run budget', description: 'run budget test' }
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;
  await assert.rejects(
    () =>
      runWorkflowScript(runBudgetScript, {
        tokenBudget: 1,
        agent: async () => "a long enough output",
      }),
    /workflow token budget exhausted/,
  );

  const stageBudgetScript = `export const meta = { name: 'stage budget', description: 'stage budget test' }
stage('Scan', { budget: 1 })
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;
  await assert.rejects(
    () => runWorkflowScript(stageBudgetScript, { agent: async () => "a long enough output" }),
    /workflow stage budget exhausted: Scan/,
  );
});

test("spark-workflows records real agent telemetry and uses it for token budgets", async () => {
  const script = `export const meta = { name: 'real usage', description: 'real usage budget' }
await agent('first', { label: 'first' })
await agent('second', { label: 'second' })`;
  const tokenEvents: Array<{ tokens: number; spent: number; source: string; costUsd?: number }> =
    [];
  const telemetryStatuses: string[] = [];

  await assert.rejects(
    () =>
      runWorkflowScript(script, {
        tokenBudget: 2,
        agent: async (_prompt, options) => {
          options.reportTelemetry?.({
            runRef: `run:child-${options.index}`,
            lastActivityAt: "2026-06-22T00:00:01.000Z",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              costUsd: 0.01,
              model: "fake-model",
            },
          });
          return "this output is intentionally much longer than two estimated tokens";
        },
        onTokenUsage: (usage) => {
          tokenEvents.push({
            tokens: usage.tokens,
            spent: usage.spent,
            source: usage.usage.source,
            costUsd: usage.usage.costUsd,
          });
        },
        onAgentTelemetry: (telemetry) => {
          telemetryStatuses.push(`${telemetry.index}:${telemetry.status}`);
        },
      }),
    /workflow token budget exhausted/,
  );

  assert.deepEqual(tokenEvents, [{ tokens: 2, spent: 2, source: "actual", costUsd: 0.01 }]);
  assert.deepEqual(telemetryStatuses, ["0:running", "0:succeeded"]);
});

test("spark-workflows marks usage as estimated when agents do not report real usage", async () => {
  const script = `export const meta = { name: 'estimated usage', description: 'estimated usage fallback' }
return await agent('short', { label: 'short' })`;
  const tokenSources: string[] = [];

  await runWorkflowScript(script, {
    agent: async () => "fallback output",
    onTokenUsage: (usage) => {
      tokenSources.push(usage.usage.source);
    },
  });

  assert.deepEqual(tokenSources, ["estimated"]);
});

test("spark-workflows composes one-level nested workflows through a controlled resolver", async () => {
  const parent = `export const meta = { name: 'parent', description: 'parent workflow' }
const child = await workflow('child', { value: 'ok' })
return { child }`;
  const child = `export const meta = { name: 'child', description: 'child workflow' }
return await agent('child ' + args.value, { label: 'child agent' })`;

  const prompts: string[] = [];
  const run = await runWorkflowScript(parent, {
    loadWorkflowScript: (name) => (name === "child" ? child : undefined),
    agent: async (prompt) => {
      prompts.push(prompt);
      return `result:${prompt}`;
    },
  });

  assert.deepEqual(prompts, ["child ok"]);
  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), { child: "result:child ok" });
});

test("Spark dynamic workflow event store appends, tails, lists, and compacts snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-event-store-"));
  try {
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const script = `export const meta = { name: 'event store', description: 'event store workflow' }
return 'ok'`;
    const meta = parseWorkflowScript(script).meta;
    const runRef = "run:event-store" as const;

    const started = await store.startRun({
      runRef,
      source: { kind: "inline", label: "inline workflow" },
      script,
      meta,
      options: { concurrency: 2 },
      now: "2026-06-23T00:00:00.000Z",
    });
    assert.equal(started.status, "running");
    await store.appendEvent(runRef, {
      type: "stage_started",
      nodeId: "stage:Plan",
      parentId: "run",
      nodeKind: "stage",
      title: "Plan",
      stage: "Plan",
      timestamp: "2026-06-23T00:00:01.000Z",
    });
    await store.appendEvent(runRef, {
      type: "stage_finished",
      nodeId: "stage:Plan",
      nodeKind: "stage",
      title: "Plan",
      stage: "Plan",
      status: "succeeded",
      timestamp: "2026-06-23T00:00:02.000Z",
    });
    const terminal = await store.appendEvent(runRef, {
      type: "run_succeeded",
      nodeId: "run",
      nodeKind: "run",
      result: { ok: true },
      timestamp: "2026-06-23T00:00:03.000Z",
    });

    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.runRef, runRef);
    assert.equal((await store.getSnapshot(runRef))?.nodesById["stage:Plan"]?.status, "succeeded");
    assert.deepEqual(
      (await store.tailEvents(runRef, 2)).map((event) => event.type),
      ["stage_finished", "run_succeeded"],
    );
    assert.deepEqual(
      (await store.listSnapshots()).map((snapshot) => snapshot.runRef),
      [runRef],
    );
    assert.equal((await store.compact(runRef))?.status, "succeeded");
    assert.deepEqual(
      (await store.readEvents(runRef)).map((event) => event.sequence),
      [0, 1, 2, 3],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark dynamic workflow run store reconciles stale running records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-dynamic-workflow-stale-"));
  try {
    const store = defaultSparkDynamicWorkflowRunStore(dir);
    const script = `export const meta = { name: 'stale', description: 'stale workflow' }
return 'stale'`;
    const run = await store.start({
      source: { kind: "inline", label: "inline workflow" },
      script,
      meta: parseWorkflowScript(script).meta,
      options: {},
      now: "2026-06-22T00:00:00.000Z",
    });
    assert.equal(run.status, "running");

    const reconciled = await store.reconcileStale({
      now: "2026-06-22T00:00:05.000Z",
      staleAfterMs: 1_000,
    });
    assert.equal(reconciled.runs[0]?.status, "stale");
    assert.match(reconciled.runs[0]?.errorMessage ?? "", /became stale/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
