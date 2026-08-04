import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  SPARK_PROTOCOL_VERSION,
  sparkSlashActionBarForInput,
  type SparkLoopStartRequest,
  type SparkInteractionRequest,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import {
  SparkHostRuntime,
  SparkKeybindings,
  SparkModelSelector,
  SparkProviderRegistry,
  SparkSessionStore,
  type ProviderConfig,
  type ProviderModelDefinition,
  type SparkCliHostServices,
} from "../host/index.ts";
import {
  SPARK_NATIVE_KERNEL_SLASH_COMMANDS,
  createSparkNativeLocalControlSlashCommands,
  createSparkNativeRuntimeSlashCommands,
} from "../native-tui.ts";
import { catalogSparkNativeCommands } from "../native-tui/command-presentation.ts";
import { nativeKernelSlashCommandEntries } from "../native-tui/slash-commands.ts";
import { createSparkPiParitySlashCommands } from "../cli/pi-parity-commands.ts";
import type { SparkDaemonModelAuthClient } from "../cli/model-control.ts";
import { SparkSessionMailStore } from "../host/session-mail-store.ts";
import { createSparkTuiActionBarComponent } from "../tui/action-bar.ts";
import type { Component } from "../tui/pi-tui-adapter.ts";
import sparkExtension from "@zendev-lab/spark-extension/extension";
type SparkDaemonLoopControl = NonNullable<Parameters<typeof sparkExtension>[0]["loopControl"]>;
import { createSparkNativeTuiHarness } from "../test-support/spark-native-tui-harness.ts";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function markerIndexes(lines: string[], pattern: RegExp): number[] {
  return lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
}

function firstMarkerIndex(lines: string[], pattern: RegExp): number {
  const index = markerIndexes(lines, pattern).at(0);
  assert.notEqual(index, undefined, `missing marker ${pattern}`);
  return index!;
}

function recordingDriverControl(starts: SparkLoopStartRequest[]): SparkDaemonLoopControl {
  return {
    async start(input) {
      starts.push(input);
      const observedAt = new Date().toISOString();
      return {
        loop: {
          loopId: input.loopId ?? `loop:${input.ownerSessionId}`,
          binding: input.binding ?? {},
          ownerSessionId: input.ownerSessionId,
          status: "scheduled",
          continuity: input.continuity,
          generation: 1,
          dueAt: input.dueAt ?? observedAt,
          attempt: 0,
          reason: input.reason,
        },
        observedAt,
      };
    },
    async list() {
      return { loops: [], observedAt: new Date().toISOString() };
    },
    async stop() {
      throw new Error("unexpected loop.stop");
    },
    async restart() {
      throw new Error("unexpected loop.restart");
    },
    async wake() {
      throw new Error("unexpected loop.wake");
    },
    async schedule() {
      throw new Error("unexpected loop.schedule");
    },
  };
}

test("native TUI composes a bounded conversation frame", () => {
  const harness = createSparkNativeTuiHarness({
    cols: 60,
    rows: 18,
    workspaceSession: {
      mode: "attached",
      workspaceDir: `/workspace/${"long-segment/".repeat(12)}`,
      workspaceHash: "hash-123",
      controlPlaneSessionId: "session-primary",
    },
  });
  harness.session.messages.push(
    { role: "user", text: "older transcript message" },
    { role: "assistant", text: "recent transcript message" },
  );
  harness.app.setWidget(
    "spark-status",
    [
      "◆ Phase: plan",
      "◆ Dynamic workflow error: evidence-independent-reviews · failed · 1/1 nodes",
      "├─ ◇ Session 与 Evidence 边界治理 · tasks 12/14",
      "└─ ◇ Memory 生命周期治理 · tasks 2/6 · ready 2",
      "◆ Goal(●): keep the durable objective visible",
    ],
    { placement: "aboveEditor" },
  );
  harness.app.setEditorText("draft prompt");
  harness.app.invalidate();

  const lines = harness.renderLines();
  const plain = lines.map(stripAnsi);
  assert.ok(lines.length <= 18);
  assert.ok(lines.every((line) => visibleWidth(line) <= 60));
  assert.equal(plain.filter((line) => line.startsWith("Spark · ")).length, 1);
  assert.equal(plain.filter((line) => line.includes("Spark session attached")).length, 1);

  const context = firstMarkerIndex(plain, /Spark session attached/);
  const message = firstMarkerIndex(plain, /recent transcript message/);
  const phase = firstMarkerIndex(plain, /Phase: plan/);
  const workflow = firstMarkerIndex(plain, /Dynamic workflow error/);
  const project = firstMarkerIndex(plain, /Session 与 Evidence 边界治理/);
  const goal = firstMarkerIndex(plain, /Goal\(●\)/);
  const composer = firstMarkerIndex(plain, /draft prompt/);
  assert.ok(message < context && context < phase);
  assert.ok(phase < workflow && workflow < project && project < goal && goal < composer);
});

test("native TUI invalidates its cached frame when terminal height changes", () => {
  const harness = createSparkNativeTuiHarness({ cols: 60, rows: 18 });
  harness.session.messages.push(
    ...Array.from({ length: 20 }, (_, index) => ({
      role: "assistant" as const,
      text: `height-cache-message-${index}`,
    })),
  );
  harness.app.invalidate();
  const tall = harness.renderLines();

  (harness.tui.terminal as { rows: number }).rows = 8;
  const short = harness.renderLines();
  assert.ok(tall.length > short.length);
  assert.ok(short.length <= 8);
  assert.match(short.map(stripAnsi).join("\n"), /height-cache-message-19/);
});

test("native TUI kernel slash commands are minimal and resource slash is extension-owned", async () => {
  assert.deepEqual(
    [...SPARK_NATIVE_KERNEL_SLASH_COMMANDS],
    ["help", "exit", "quit", "clear", "reload"],
  );

  const local = createSparkNativeLocalControlSlashCommands();
  assert.equal(local.tasks?.metadata?.source, "extension");
  assert.equal(local.tasks?.metadata?.plane, "cockpit");
  assert.equal(local.tasks?.metadata?.resource, "task");
  assert.equal(local.tasks?.metadata?.canonicalCliTarget, "spark cockpit task list");
  assert.equal(local.task?.metadata?.canonicalCliTarget, "spark cockpit task list");
  assert.equal(local.artifact?.metadata?.canonicalCliTarget, "spark cockpit artifact list");
  assert.equal(local.review?.metadata?.canonicalCliTarget, "spark cockpit review list");
  assert.equal(local.run?.metadata?.canonicalCliTarget, "spark daemon run list");
  assert.equal(local.stop?.metadata?.canonicalCliTarget, "spark daemon run cancel <run>");
  assert.equal(local.tasks?.metadata?.deprecatedAliasFor, "/task list");
  assert.equal(local.artifacts?.metadata?.deprecatedAliasFor, "/artifact list");
  assert.equal(local.runs?.metadata?.deprecatedAliasFor, "/run list");
  assert.equal(local.reviews?.metadata?.deprecatedAliasFor, "/review list");
  assert.equal(local.task?.metadata?.deprecatedAliasFor, undefined);
  assert.equal(local.artifact?.metadata?.deprecatedAliasFor, undefined);
  assert.equal(local.run?.metadata?.deprecatedAliasFor, undefined);

  const host = new SparkHostRuntime({ cwd: process.cwd() });
  host.registerCommand("goal", {
    description: "Goal command",
    metadata: {
      source: "extension",
      extensionId: "spark-loop",
      plane: "daemon",
      resource: "goal",
      verbs: ["status"],
    },
    handler: () => undefined,
  });
  let workflowCalls = 0;
  host.registerCommand("workflow", {
    description: "Workflow command",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "daemon",
      resource: "workflow",
      verbs: ["list"],
    },
    handler: () => {
      workflowCalls += 1;
    },
  });
  host.registerCommand("workflow-pause", {
    description: "Workflow pause alias",
    argumentHint: "<runRef>",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "daemon",
      resource: "workflow",
      verbs: ["pause"],
      deprecatedAliasFor: "/workflow pause <runRef>",
    },
    handler: () => undefined,
  });
  let workflowsAliasCalls = 0;
  host.registerCommand("workflows", {
    description: "Workflow list alias",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "daemon",
      resource: "workflow",
      verbs: ["list"],
      deprecatedAliasFor: "/workflow list",
    },
    handler: () => {
      workflowsAliasCalls += 1;
    },
  });
  let workflowRunsAliasCalls = 0;
  host.registerCommand("workflow-runs", {
    description: "Workflow runs alias",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "daemon",
      resource: "workflow",
      verbs: ["list"],
      deprecatedAliasFor: "/workflow runs [runRef]",
    },
    handler: () => {
      workflowRunsAliasCalls += 1;
    },
  });
  host.registerCommand("session", {
    description: "Session command",
    argumentHint: "[list]",
    metadata: {
      source: "extension",
      extensionId: "spark-pi-parity",
      plane: "daemon",
      resource: "session",
      verbs: ["show", "list"],
      canonicalCliTarget: "spark daemon session list",
    },
    handler: () => undefined,
  });
  const runtime = createSparkNativeRuntimeSlashCommands(host);
  assert.equal(runtime.goal?.metadata?.source, "extension");
  assert.equal(runtime.goal?.metadata?.extensionId, "spark-loop");
  assert.equal(runtime.goal?.metadata?.plane, "daemon");
  assert.equal(runtime.goal?.metadata?.canonicalCliTarget, undefined);
  const providerCommands = createSparkPiParitySlashCommands({
    runtime: host,
  } as SparkCliHostServices);
  assert.equal(providerCommands.login?.metadata?.resource, "auth");
  assert.equal(
    providerCommands.login?.metadata?.canonicalCliTarget,
    "spark daemon auth login [provider]",
  );
  assert.equal(providerCommands.logout?.metadata?.resource, "auth");
  assert.equal(
    providerCommands.logout?.metadata?.canonicalCliTarget,
    "spark daemon auth logout <provider>",
  );

  const slashFixture = {
    "/session list": runtime.session,
    "/task list": local.task,
    "/goal status": runtime.goal,
    "/workflow list": runtime.workflow,
    "/workflow-pause": runtime["workflow-pause"],
    "/review list": local.review,
    "/artifact list": local.artifact,
    "/run list": local.run,
  } as const;
  const expectedTargets = {
    "/session list": "spark daemon session list",
    "/task list": "spark cockpit task list",
    "/goal status": undefined,
    "/workflow list": undefined,
    "/workflow-pause": undefined,
    "/review list": "spark cockpit review list",
    "/artifact list": "spark cockpit artifact list",
    "/run list": "spark daemon run list",
  } as const;
  for (const [input, command] of Object.entries(slashFixture)) {
    assert.equal(command?.metadata?.source, "extension", `${input} is extension-owned`);
    assert.equal(
      command?.metadata?.canonicalCliTarget,
      expectedTargets[input as keyof typeof expectedTargets],
      `${input} canonical target`,
    );
  }

  const harness = createSparkNativeTuiHarness({
    rows: 120,
    slashCommands: { ...runtime, ...local },
  });
  assert.equal(await harness.submit("/help"), "command");
  let rendered = stripAnsi(harness.render());
  assert.match(rendered, /Spark — start here/);
  assert.match(rendered, /\/help \[commands\|all\]/);
  assert.match(rendered, /\/stop \[reason\]/);
  assert.doesNotMatch(rendered, /\/goal — Goal command/);
  assert.doesNotMatch(rendered, /\/plan —/);

  assert.equal(await harness.submit("/clear"), "command");
  assert.equal(await harness.submit("/help commands"), "command");
  rendered = stripAnsi(harness.render());
  assert.match(rendered, /Common\s+- \/help/);
  assert.match(rendered, /Automation\s+- \/goal — Goal command/);
  assert.match(rendered, /Workflows\s+- \/workflow — Workflow command/);
  assert.match(rendered, /Sessions & context[\s\S]*?- \/session \[list\] — Session command/);
  assert.match(rendered, /\/reload — reload extension-owned slash command state/);
  assert.doesNotMatch(rendered, /\/workflow-pause/);
  assert.doesNotMatch(rendered, /\/tasks —/);
  assert.doesNotMatch(rendered, /\/workflows —/);
  assert.match(rendered, /\d+ compatibility aliases hidden; use \/help all/);

  assert.equal(await harness.submit("/clear"), "command");
  assert.equal(await harness.submit("/help all"), "command");
  rendered = stripAnsi(harness.render());
  assert.match(rendered, /Spark command registry \(diagnostic\)/);
  assert.match(rendered, /\/goal — Goal command \[extension\]/);
  assert.doesNotMatch(rendered, /\/goal — Goal command \[extension\] →/);
  assert.match(
    rendered,
    /\/session \[list\] — Session command \[extension\] → spark daemon session list/,
  );
  assert.match(
    rendered,
    /\/tasks — open the tasks local session panel \[extension\] → spark cockpit task list[\s\S]*?compatibility\s+alias for \/task list/,
  );
  assert.match(
    rendered,
    /\/workflow-pause <runRef> — Workflow pause alias \[extension\][\s\S]*?compatibility\s+alias/,
  );
  assert.doesNotMatch(rendered, /\/task — .*\[system\]/);

  const discoverable = catalogSparkNativeCommands(
    { ...runtime, ...local },
    nativeKernelSlashCommandEntries(),
  );
  assert.equal(
    discoverable.some((entry) => entry.name === "workflow-pause"),
    false,
  );
  assert.equal(
    discoverable.some((entry) => entry.name === "tasks"),
    false,
  );
  assert.equal(runtime["workflow-pause"]?.handler instanceof Function, true);

  assert.equal(await harness.submit("/clear"), "command");
  harness.app.setEditorText("");
  await typeEditorText(harness, "/workflow-");
  await harness.flush();
  assert.equal(harness.app.isShowingAutocomplete(), false);
  assert.doesNotMatch(stripAnsi(harness.render()), /workflow-pause\s+<runRef>/);
  harness.app.setEditorText("");

  assert.equal(await harness.submit("/workflows"), "command");
  assert.equal(await harness.submit("/workflow-runs"), "command");
  assert.equal(workflowsAliasCalls, 1);
  assert.equal(workflowRunsAliasCalls, 1);
  assert.equal(harness.app.actionBarSnapshot(), undefined);

  assert.equal(await harness.submit("/workflow"), "command");
  assert.equal(workflowCalls, 1);
  assert.equal(harness.app.actionBarSnapshot(), undefined);
});

test("Spark native TUI /inbox reads durable session mail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-mail-"));
  const sparkHome = join(dir, "spark-home");
  try {
    const sessionStore = new SparkSessionStore({ cwd: join(dir, "workspace-b"), sparkHome });
    await sessionStore.save(
      sessionStore.createSession({ id: "session-b", timestamp: "2026-07-08T00:00:00.000Z" }),
    );
    const services = { cwd: join(dir, "workspace-b"), sessionStore } as never;
    const mailStore = new SparkSessionMailStore({ sparkHome });
    const inboxCalls: string[] = [];
    const harness = createSparkNativeTuiHarness({
      slashCommands: createSparkPiParitySlashCommands(services, undefined, {
        currentSessionId: "session-b",
        list: async (sessionId) => {
          inboxCalls.push(`list:${sessionId}`);
          return await mailStore.list(sessionId);
        },
        read: async (sessionId, messageId) => {
          inboxCalls.push(`read:${sessionId}:${messageId}`);
          return await mailStore.read(sessionId, messageId);
        },
        ack: async (sessionId, messageId) => {
          inboxCalls.push(`ack:${sessionId}:${messageId}`);
          return await mailStore.ack(sessionId, messageId);
        },
      }),
    });
    const sent = await mailStore.send({
      toSessionId: "session-b",
      fromSessionId: "session-a",
      kind: "request",
      body: "hello",
    });

    assert.equal(await harness.submit("/inbox"), "command");
    assert.match(stripAnsi(harness.render()), /hello/);
    assert.deepEqual(inboxCalls, ["list:session-b"]);
    const messageId = sent.message.id;

    assert.equal(await harness.submit(`/inbox ack ${messageId}`), "command");
    assert.match(stripAnsi(harness.render()), /Acknowledged mail:/);
    assert.deepEqual(inboxCalls, ["list:session-b", `ack:session-b:${messageId}`]);
    const messages = await mailStore.list("session-b");
    assert.equal(messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark native TUI harness submits input and drives exit keys without a real terminal", async () => {
  const harness = createSparkNativeTuiHarness({
    responder: (input) => `ack:${input}`,
  });

  assert.equal(await harness.submit("hello Spark"), "started");
  await harness.flush();

  assert.equal(
    harness.session.messages.some((message) => message.role === "user"),
    true,
  );
  assert.equal(
    harness.session.messages.some(
      (message) => message.role === "assistant" && message.text === "ack:hello Spark",
    ),
    true,
  );
  assert.match(stripAnsi(harness.render()), /spark> ack:hello Spark/);

  await harness.press("\x03");
  assert.equal(harness.state.exited, true);
  assert.equal(harness.state.renderRequests.length > 0, true);
});

test("Spark native TUI keeps one submission identity across an ACK-loss retry", async () => {
  const seen: Array<{ input: string; submissionId?: string }> = [];
  let failFirst = true;
  const harness = createSparkNativeTuiHarness({
    responder: (input, context) => {
      seen.push({ input, submissionId: context.submissionId });
      if (failFirst) {
        failFirst = false;
        throw new Error("daemon ACK lost");
      }
      return `ack:${input}`;
    },
  });

  assert.equal(await harness.submit("retry-safe prompt"), "started");
  await harness.flush();
  assert.equal(await harness.submit("/retry"), "command");
  await harness.flush();
  assert.equal(await harness.submit("fresh prompt"), "started");
  await harness.flush();

  assert.match(seen[0]?.submissionId ?? "", /^idem_[a-f0-9]{32}$/u);
  assert.equal(seen[1]?.submissionId, seen[0]?.submissionId);
  assert.notEqual(seen[2]?.submissionId, seen[0]?.submissionId);
  assert.deepEqual(
    seen.map(({ input }) => input),
    ["retry-safe prompt", "retry-safe prompt", "fresh prompt"],
  );
});

test("native TUI defaults to workspace session selector when no session target is provided", () => {
  const harness = createSparkNativeTuiHarness({
    cols: 180,
    workspaceSession: {
      mode: "select",
      workspaceDir: "/workspaces/current",
      workspaceHash: "hash-current",
      controlPlaneSessionId: "client-current",
    },
  });
  const rendered = stripAnsi(harness.render());

  assert.match(rendered, /Select Spark session/);
  assert.match(rendered, /workspace: \/workspaces\/current/);
  assert.match(rendered, /workspace hash: hash-current/);
  assert.match(rendered, /control-plane session: client-current/);
  assert.doesNotMatch(rendered, /Spark daemon session validation/);
});

test("native TUI keeps project UI placement when session selector is shown", () => {
  const harness = createSparkNativeTuiHarness({
    cols: 180,
    workspaceSession: {
      mode: "select",
      workspaceDir: "/workspaces/current",
      workspaceHash: "hash-current",
      controlPlaneSessionId: "client-current",
    },
  });
  harness.app.setWidget("project", [
    "Project: Spark daemon session UX",
    "Goal: improve the session workflow",
    "Ready: @project-ui-placement",
  ]);

  const lines = stripAnsi(harness.render()).split("\n");
  const sessionLines = markerIndexes(lines, /Select Spark session/);
  const projectLine = firstMarkerIndex(lines, /Project: Spark daemon session UX/);
  const goalLine = firstMarkerIndex(lines, /Goal: improve the session workflow/);
  const readyLine = firstMarkerIndex(lines, /Ready: @project-ui-placement/);

  assert.equal(sessionLines.length, 1);
  assert.equal(sessionLines[0], projectLine - 1);
  assert.equal(goalLine, projectLine + 1);
  assert.equal(readyLine, goalLine + 1);
});

test("native TUI renders compact session status before project UI", () => {
  const harness = createSparkNativeTuiHarness({
    cols: 180,
    workspaceSession: {
      mode: "attached",
      workspaceDir: "/workspaces/current",
      workspaceHash: "hash-current",
      controlPlaneSessionId: "client-current",
      attachTarget: "session:attached",
    },
  });
  harness.app.setWidget("project", [
    "Project: Spark daemon session UX",
    "Goal: improve the session workflow",
    "Ready: @zellij-driven-session-harness",
  ]);

  assert.equal(harness.state.exited, false);
  const lines = stripAnsi(harness.render()).split("\n");
  const sessionLine = firstMarkerIndex(lines, /Spark session attached/);
  const projectLine = firstMarkerIndex(lines, /Project: Spark daemon session UX/);
  assert.equal(projectLine, sessionLine + 1);
  assert.equal(
    lines.filter((line) =>
      /Spark session attached|workspace hash: hash-current|attach target: session:attached/.test(
        line,
      ),
    ).length,
    1,
  );
});

test("native TUI construction does not mutate session lifecycle state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-session-lifecycle-"));
  const goalPath = join(dir, "goal.json");
  const statePath = join(dir, "state.json");
  await writeFile(goalPath, JSON.stringify({ status: "active", goalId: "goal-1" }), "utf8");
  await writeFile(statePath, JSON.stringify({ currentProjectRef: "proj:1" }), "utf8");
  const beforeGoal = await readFile(goalPath, "utf8");
  const beforeState = await readFile(statePath, "utf8");
  try {
    const harness = createSparkNativeTuiHarness({
      workspaceSession: {
        mode: "select",
        workspaceDir: dir,
        workspaceHash: "hash-lifecycle",
        controlPlaneSessionId: "client-lifecycle",
      },
    });
    harness.render();

    assert.equal(await readFile(goalPath, "utf8"), beforeGoal);
    assert.equal(await readFile(statePath, "utf8"), beforeState);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark native TUI renders theme color and live widget animation frames", async () => {
  const harness = createSparkNativeTuiHarness();
  let frame = 0;
  let widgetRequestRender: (() => void) | undefined;

  harness.app.setWidget(
    "animated",
    (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }) => {
      widgetRequestRender = () => tui.requestRender();
      return {
        render: () => [theme.fg("accent", `frame:${frame}`)],
        invalidate() {},
      };
    },
  );

  const firstRender = harness.render();
  assert.match(firstRender, ANSI_PATTERN);
  assert.match(stripAnsi(firstRender), /frame:0/);

  frame = 1;
  widgetRequestRender?.();
  assert.equal(harness.state.renderRequests.length > 0, true);
  assert.match(stripAnsi(harness.render()), /frame:1/);
});

function nativeAskRequest(
  requestId: string,
  overrides: Partial<Extract<SparkInteractionRequest, { kind: "askFlow" }>> = {},
): Extract<SparkInteractionRequest, { kind: "askFlow" }> {
  return {
    version: SPARK_PROTOCOL_VERSION,
    requestId,
    kind: "askFlow",
    title: "Choose an implementation path",
    prompt: "The turn remains paused until this is answered.",
    mode: "decision",
    questions: [
      {
        id: "path",
        prompt: "Which path should Spark take?",
        type: "single",
        required: true,
        defaultValues: [],
        options: [
          { value: "safe", label: "Safe path" },
          { value: "fast", label: "Fast path" },
        ],
      },
    ],
    metadata: {},
    ...overrides,
  };
}

test("native custom synchronous done never presents or leaks a component", async () => {
  for (const withOverlay of [false, true]) {
    const harness = createSparkNativeTuiHarness({ withOverlay });
    const component: Component = {
      render: () => ["must not become visible"],
      handleInput: () => {},
      invalidate: () => {},
    };
    const result = await harness.app.custom<string>(
      (_tui, _theme, _keybindings, done) => {
        done("synchronous-result");
        return component;
      },
      { overlay: true },
    );
    assert.equal(result, "synchronous-result");
    assert.equal(harness.state.overlays.length, 0);
    assert.equal(harness.state.children.length, 0);
    assert.equal(harness.state.focused, harness.app);
    assert.equal(markerIndexes(harness.renderLines().map(stripAnsi), /Ask pending/).length, 0);
    assert.equal(harness.state.renderRequests.length, 1);
  }
});

test("native ask lifecycle cache bounds replay and transcript dedup together", async () => {
  const harness = createSparkNativeTuiHarness({ withOverlay: true });
  const responses = new Map<
    string,
    Awaited<ReturnType<typeof harness.app.handleInteractionRequest>>
  >();
  for (let index = 0; index <= 32; index += 1) {
    const request = nativeAskRequest(`ask-bounded-${index}`);
    const responsePromise = harness.app.handleInteractionRequest(request);
    await harness.flush();
    const overlay = harness.state.overlays.at(-1);
    assert.ok(overlay);
    overlay.component.handleInput?.("\r");
    overlay.component.handleInput?.("\r");
    responses.set(request.requestId, await responsePromise);
  }
  assert.equal(harness.state.overlays.length, 33);

  const newest = nativeAskRequest("ask-bounded-32");
  const newestReplay = await harness.app.handleInteractionRequest(newest);
  assert.deepEqual(newestReplay, responses.get(newest.requestId));
  assert.equal(harness.state.overlays.length, 33);

  const evicted = nativeAskRequest("ask-bounded-0");
  const evictedPresentation = harness.app.handleInteractionRequest(evicted);
  await harness.flush();
  assert.equal(harness.state.overlays.length, 34);
  const replacement = harness.state.overlays.at(-1)!;
  assert.equal(replacement.visible, true);
  assert.equal(
    markerIndexes(harness.renderLines().map(stripAnsi), /Ask pending · ask-bounded-0/).length,
    1,
  );
  replacement.component.handleInput?.("\r");
  replacement.component.handleInput?.("\r");
  await evictedPresentation;

  const markers = harness.session.messages.filter(
    (message) =>
      message.customType === "interaction-request" &&
      (message.details as { request?: { requestId?: string } } | undefined)?.request?.requestId ===
        "ask-bounded-0",
  );
  assert.equal(markers.length, 2);
});

test("native ask overlay geometry fits terminal variants and renders within its width", async () => {
  for (const [cols, rows] of [
    [60, 18],
    [80, 24],
    [120, 30],
  ] as const) {
    const harness = createSparkNativeTuiHarness({ cols, rows, withOverlay: true });
    const promise = harness.app.handleInteractionRequest(nativeAskRequest(`ask-geometry-${cols}`));
    await harness.flush();
    const overlay = harness.state.overlays.at(-1);
    assert.ok(overlay?.options);
    assert.equal(overlay.options.anchor, "center");
    assert.ok(overlay.options.margin);
    assert.equal(typeof overlay.options.width, "number");
    assert.ok((overlay.options.width as number) <= cols - 2);
    assert.ok((overlay.options.minWidth as number) <= (overlay.options.width as number));
    assert.ok((overlay.options.maxHeight as number) <= rows);
    const renderWidth = overlay.options.width as number;
    const lines = overlay.component.render(renderWidth);
    assert.ok(lines.every((line) => visibleWidth(line) <= renderWidth));
    assert.ok(lines.length <= (overlay.options.maxHeight as number) * 2);
    overlay.component.handleInput?.("\x1b[B");
    overlay.component.handleInput?.("\r");
    overlay.component.handleInput?.("\r");
    await promise;
  }
});

test("native ask pending state is unique in the main frame and clears after answer", async () => {
  const harness = createSparkNativeTuiHarness({ withOverlay: true });
  const request = nativeAskRequest("ask-pending-visible");
  const first = harness.app.handleInteractionRequest(request);
  const second = harness.app.handleInteractionRequest(request);
  await harness.flush();
  assert.equal(harness.state.overlays.length, 1);
  assert.equal(
    markerIndexes(harness.renderLines().map(stripAnsi), /Ask pending · ask-pending-visible/).length,
    1,
  );
  const overlay = harness.state.overlays[0]!;
  overlay.component.handleInput?.("\r");
  overlay.component.handleInput?.("\r");
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.deepEqual(firstResponse, secondResponse);
  assert.equal(markerIndexes(harness.renderLines().map(stripAnsi), /Ask pending/).length, 0);
  assert.equal(overlay.visible, false);
  assert.equal(harness.state.focused, harness.app);

  const replay = await harness.app.handleInteractionRequest(request);
  assert.deepEqual(replay, firstResponse);
  assert.equal(harness.state.overlays.length, 1);
  assert.equal(
    harness.session.messages.filter((message) =>
      message.text.includes("Choose an implementation path"),
    ).length,
    1,
  );
});

test("native ask fallback child closes on answer and permits a different request", async () => {
  const harness = createSparkNativeTuiHarness();
  const first = harness.app.handleInteractionRequest(nativeAskRequest("ask-child-answer"));
  await harness.flush();
  assert.equal(harness.state.children.length, 1);
  const child = harness.state.children[0]!;
  child.handleInput?.("\r");
  child.handleInput?.("\r");
  const answered = await first;
  assert.equal(answered.status, "answered");
  assert.equal(harness.state.children.length, 0);
  assert.equal(harness.state.focused, harness.app);

  const next = harness.app.handleInteractionRequest(nativeAskRequest("ask-child-next"));
  await harness.flush();
  assert.equal(harness.state.children.length, 1);
  harness.state.children[0]!.handleInput?.("\t");
  harness.state.children[0]!.handleInput?.("3");
  const cancelled = await next;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.metadata.timedOut, undefined);
  assert.equal(harness.state.children.length, 0);
});

test("native ask fallback timeout cleans up and replays without recreating UI", async () => {
  const harness = createSparkNativeTuiHarness();
  const request = nativeAskRequest("ask-child-timeout", { timeoutMs: 20 });
  const response = await harness.app.handleInteractionRequest(request);
  assert.equal(response.status, "cancelled");
  assert.equal(response.metadata.timedOut, true);
  assert.equal(harness.state.children.length, 0);
  assert.equal(harness.state.focused, harness.app);
  assert.equal(markerIndexes(harness.renderLines().map(stripAnsi), /Ask pending/).length, 0);
  assert.ok(harness.state.renderRequests.length > 0);
  const replay = await harness.app.handleInteractionRequest(request);
  assert.deepEqual(replay, response);
  assert.equal(harness.state.children.length, 0);
});

test("native ask answer wins a timeout race without timedOut metadata", async () => {
  const harness = createSparkNativeTuiHarness({ withOverlay: true });
  const promise = harness.app.handleInteractionRequest(
    nativeAskRequest("ask-answer-timeout-race", { timeoutMs: 100 }),
  );
  await harness.flush();
  const overlay = harness.state.overlays.at(-1)!;
  overlay.component.handleInput?.("\r");
  overlay.component.handleInput?.("\r");
  const response = await promise;
  assert.equal(response.status, "answered");
  assert.equal(response.metadata.timedOut, undefined);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(overlay.visible, false);
});

test("native TUI renders daemon ask flow and every question has a custom reply fallback", async () => {
  const harness = createSparkNativeTuiHarness({ withOverlay: true });
  const responsePromise = harness.app.handleInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "ask-native-custom",
    kind: "askFlow",
    title: "Choose an implementation path",
    prompt: "The turn remains paused until this is answered.",
    mode: "decision",
    questions: [
      {
        id: "path",
        prompt: "Which path should Spark take?",
        type: "single",
        required: true,
        defaultValues: [],
        options: [
          { value: "safe", label: "Safe path" },
          { value: "fast", label: "Fast path" },
        ],
      },
    ],
    metadata: {},
  });
  await harness.flush();

  const overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  assert.equal(overlay.visible, true);
  assert.match(stripAnsi(overlay.component.render(88).join("\n")), /Type your own|输入自定义/);

  overlay.component.handleInput?.("\x1b[B");
  overlay.component.handleInput?.("\x1b[B");
  for (const character of "use a guarded migration") overlay.component.handleInput?.(character);
  overlay.component.handleInput?.("\r");
  overlay.component.handleInput?.("\r");

  const response = await responsePromise;
  assert.equal(response.kind, "askFlow");
  assert.equal(response.status, "answered");
  assert.deepEqual(response.answers.path, {
    values: [],
    customText: "use a guarded migration",
  });
  assert.equal(overlay.visible, false);
  assert.equal(harness.state.focused, harness.app);
  assert.equal(harness.app.cockpitSnapshot().interactions, 0);
});

test("native TUI closes the human ask overlay when its wait times out", async () => {
  const harness = createSparkNativeTuiHarness({ withOverlay: true });
  const responsePromise = harness.app.handleInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "ask-native-timeout",
    kind: "askFlow",
    title: "Choose before timeout",
    mode: "decision",
    timeoutMs: 250,
    questions: [
      {
        id: "path",
        prompt: "Which path should Spark take?",
        type: "single",
        required: true,
        defaultValues: [],
        options: [
          { value: "safe", label: "Safe path" },
          { value: "fast", label: "Fast path" },
        ],
      },
    ],
    metadata: {},
  });
  await harness.flush();

  const overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  assert.equal(overlay.visible, true);

  const response = await responsePromise;
  assert.equal(response.status, "cancelled");
  assert.equal(response.metadata.timedOut, true);
  assert.equal(overlay.visible, false);
  assert.equal(harness.state.focused, harness.app);
  assert.equal(markerIndexes(harness.renderLines().map(stripAnsi), /Ask pending/).length, 0);
  assert.equal(harness.app.cockpitSnapshot().interactions, 0);
});

test("native TUI falls back to a custom reply when a choice question has no options", async () => {
  const harness = createSparkNativeTuiHarness({ withOverlay: true });
  const responsePromise = harness.app.handleInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "ask-native-custom-only",
    kind: "askFlow",
    title: "Describe the preview choice",
    mode: "decision",
    questions: [
      {
        id: "preview-only",
        prompt: "What should replace the generated preview?",
        type: "preview",
        required: true,
        defaultValues: [],
        options: [],
      },
    ],
    metadata: {},
  });
  await harness.flush();

  const overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  assert.match(stripAnsi(overlay.component.render(88).join("\n")), /Type your own|输入自定义/);

  for (const character of "show the migration diff") overlay.component.handleInput?.(character);
  overlay.component.handleInput?.("\r");
  overlay.component.handleInput?.("\r");

  const response = await responsePromise;
  assert.equal(response.kind, "askFlow");
  assert.equal(response.status, "answered");
  assert.equal(response.nextAction, "resume");
  assert.deepEqual(response.answers["preview-only"], {
    values: [],
    customText: "show the migration diff",
  });
});

test("native TUI replays a settled daemon ask without duplicating UI or transcript", async () => {
  const harness = createSparkNativeTuiHarness({ withOverlay: true });
  const request = nativeAskRequest("ask-native-replay", {
    title: "Retry this answer",
    questions: [
      {
        id: "retry-answer",
        prompt: "What should Spark do?",
        type: "freeform",
        required: true,
        defaultValues: [],
        options: [],
      },
    ],
  });

  const responsePromise = harness.app.handleInteractionRequest(request);
  await harness.flush();
  const overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  for (const character of "first attempt") overlay.component.handleInput?.(character);
  overlay.component.handleInput?.("\r");
  overlay.component.handleInput?.("\r");
  const response = await responsePromise;
  assert.equal(response.status, "answered");

  const replay = await harness.app.handleInteractionRequest(request);
  assert.deepEqual(replay, response);
  assert.equal(harness.state.overlays.length, 1);
  assert.equal(
    harness.session.messages.filter((message) => message.customType === "interaction-request")
      .length,
    1,
  );
});

test("Spark native TUI editor path submits slash commands from real keystrokes", async () => {
  const invoked: Array<{ name: string; args: string }> = [];
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-native-slash-test", hasUI: true });
  host.registerCommand("plan", {
    description: "Enter Spark plan mode for the current project",
    handler: (args, ctx) => {
      invoked.push({ name: "plan", args });
      ctx.ui?.notify?.(`planned:${args}`, "info");
    },
  });
  host.registerCommand("goal", {
    description: "Set or inspect the current Spark goal",
    handler: (_args, ctx) => ctx.ui?.notify?.("goal routed", "success"),
  });

  const harness = createSparkNativeTuiHarness({
    withOverlay: true,
    slashCommands: createSparkNativeRuntimeSlashCommands(host),
  });
  host.setUiTransport({
    notify: (message, level) => harness.session.addSystemMessage(`${level}:${message}`),
  });

  await typeEditorText(harness, "/");
  await harness.flush();
  assert.equal(harness.app.isShowingAutocomplete(), true);
  assert.match(stripAnsi(harness.render()), /plan\s+Enter Spark plan mode for the current project/);
  assert.match(stripAnsi(harness.render()), /goal\s+Set or inspect the current Spark goal/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/help commands");
  assert.match(
    stripAnsi(harness.render()),
    /\/plan — Enter Spark plan mode for the current project/,
  );
  assert.match(stripAnsi(harness.render()), /\/goal — Set or inspect the current Spark goal/);

  await submitEditorText(harness, "/plan close slash gap");
  assert.deepEqual(invoked, [{ name: "plan", args: "close slash gap" }]);
  assert.match(stripAnsi(harness.render()), /system> info:planned:close slash gap/);
});

test("working native TUI executes local slash commands instead of queueing them", async () => {
  let finishTurn: ((result: string) => void) | undefined;
  const invoked: Array<{ name: string; args: string }> = [];
  const command = (name: string) => ({
    description: `${name} command`,
    handler: (args: string) => {
      invoked.push({ name, args });
    },
  });
  const harness = createSparkNativeTuiHarness({
    withOverlay: true,
    slashCommands: {
      model: command("model"),
      plan: command("plan"),
    },
    responder: () =>
      new Promise<string>((resolve) => {
        finishTurn = resolve;
      }),
  });

  assert.equal(await harness.submit("long-running turn"), "started");
  await harness.flush();
  assert.equal(harness.session.isProcessing, true);

  await submitEditorText(harness, "/model");
  assert.deepEqual(harness.app.actionBarSnapshot(), {
    id: "model",
    selectedActionId: "select-model",
    focused: false,
  });
  assert.equal(harness.session.queuedCount, 0);
  const modelOverlay = harness.state.overlays.at(-1);
  assert.ok(modelOverlay);
  modelOverlay.component.handleInput?.("\r");
  await harness.flush();
  assert.deepEqual(invoked.at(-1), { name: "model", args: "" });
  assert.equal(harness.session.isProcessing, true);
  assert.equal(harness.session.queuedCount, 0);

  await submitEditorText(harness, "/plan keep control local");
  assert.deepEqual(invoked.at(-1), { name: "plan", args: "keep control local" });
  assert.equal(harness.session.isProcessing, true);
  assert.equal(harness.session.queuedCount, 0);

  finishTurn?.("turn complete");
  await harness.flush();
  assert.equal(harness.session.isProcessing, false);
});

test("native TUI Shift+Tab cycles thinking effort with visible feedback", async () => {
  const keybindings = new SparkKeybindings();
  const levels: SparkThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  let current: SparkThinkingLevel = "high";
  let harness: ReturnType<typeof createSparkNativeTuiHarness>;
  keybindings.register({
    id: "app.thinking.cycle",
    defaultKey: "shift+tab",
    description: "Cycle thinking effort",
    handler: () => {
      current = levels[(levels.indexOf(current) + 1) % levels.length]!;
      harness.session.addSystemMessage(`Thinking effort: ${current}`);
    },
  });
  harness = createSparkNativeTuiHarness({ keybindings });

  await harness.press("\x1b[Z");
  assert.equal(current, "xhigh");
  assert.match(stripAnsi(harness.render()), /Thinking effort: xhigh/);

  await harness.press("\x1b[Z");
  assert.equal(current, "off");
  assert.match(stripAnsi(harness.render()), /Thinking effort: off/);
});

test("Spark native TUI routes /model through native slash command and model selector overlay", async () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider(
    "fake",
    fakeProvider("fake", [fakeModel("model-a"), fakeModel("model-b")]),
  );
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const selector = new SparkModelSelector({
    registry,
    config: { extensions: [], providers: [] },
    saveConfig: () => undefined,
    picker: async (state) => {
      assert.equal(state.active?.modelId, "model-a");
      return { providerName: "fake", modelId: "model-b" };
    },
  });
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-native-model-command", hasUI: true });
  host.registerCommand("model", {
    description: "Switch or inspect the active Spark model",
    argumentHint: "[model-id]",
    getArgumentCompletions: (prefix) =>
      selector
        .getPickerState()
        .items.map((item) => ({
          value: item.value,
          label: `${item.modelLabel}${item.active ? " (active)" : ""}`,
          description: item.description,
        }))
        .filter((item) => item.value.includes(prefix)),
    async handler(args, ctx) {
      const requested = args.trim();
      const selection = requested
        ? await selector.select(
            requested.includes("/")
              ? {
                  providerName: requested.slice(0, requested.indexOf("/")),
                  modelId: requested.slice(requested.indexOf("/") + 1),
                }
              : { providerName: "fake", modelId: requested },
          )
        : await selector.openPicker(ctx as Parameters<typeof selector.openPicker>[0]);
      ctx.ui?.notify?.(`Model: ${selection?.providerName}/${selection?.modelId}`, "info");
    },
  });
  const harness = createSparkNativeTuiHarness({
    withOverlay: true,
    slashCommands: createSparkNativeRuntimeSlashCommands(host),
  });
  host.setUiTransport({
    notify: (message, level) => harness.session.addSystemMessage(`${level}:${message}`),
    custom: <T>() => ({ providerName: "fake", modelId: "model-b" }) as T,
  });

  await typeEditorText(harness, "/model ");
  await harness.flush();
  assert.equal(harness.app.isShowingAutocomplete(), true);
  assert.match(stripAnsi(harness.render()), /model-a \(active\)/);
  assert.match(stripAnsi(harness.render()), /route fake/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/model");
  (harness.state.focused as { handleInput?: (input: string) => void }).handleInput?.("\r");
  await harness.flush();
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-b" });
  assert.match(stripAnsi(harness.render()), /system> info:Model: fake\/model-b/);

  await submitEditorText(harness, "/model fake/model-a");
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-a" });
  assert.doesNotMatch(stripAnsi(harness.render()), /Unknown command: \/model/);
});

test("Spark native Pi parity slash commands are discoverable and route representative side effects", async () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider("fake", [fakeModel("model-a")]));
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const selector = new SparkModelSelector({
    registry,
    config: { extensions: ["ext-a"], providers: ["provider-a"], activeThinkingLevel: "low" },
    saveConfig: async () => undefined,
  });
  const keybindings = new SparkKeybindings();
  const dir = "/tmp/spark-native-pi-parity-commands";
  const slashCommands = createSparkPiParitySlashCommands({
    cwd: dir,
    config: { extensions: ["ext-a"], providers: ["provider-a"], activeThinkingLevel: "low" },
    saveConfig: async () => undefined,
    runtime: new SparkHostRuntime({ cwd: dir, hasUI: true, keybindings }),
    keybindings,
    providerRegistry: registry,
    modelSelector: selector,
    sessionStore: new SparkSessionStore({
      cwd: dir,
      sessionsRoot: "/tmp/spark-native-pi-parity-sessions",
    }),
    skillResolver: {} as never,
    agentLoop: {} as never,
    extensionLoadResult: { outcomes: [] } as never,
    providerLoadResult: { outcomes: [] } as never,
    diagnostics: [],
  });
  const harness = createSparkNativeTuiHarness({
    rows: 120,
    slashCommands,
    autocompleteBasePath: dir,
  });
  harness.session.appendAssistantChunk("assistant reply to copy");
  harness.session.finishAssistantMessage();

  await typeEditorText(harness, "/s");
  await harness.flush();
  assert.equal(harness.app.isShowingAutocomplete(), true);
  assert.match(stripAnsi(harness.render()), /settings\s+\[set thinking/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/help commands");
  for (const command of [
    "settings",
    "scoped-models",
    "export",
    "import",
    "share",
    "copy",
    "name",
    "session",
    "changelog",
    "hotkeys",
    "clone",
    "tree",
    "trust",
    "login",
    "logout",
    "new",
    "compact",
    "resume",
    "reload",
  ]) {
    assert.match(stripAnsi(harness.render()), new RegExp(`/${command}(?: \\[| <| )?.* —`, "u"));
  }
  assert.match(
    stripAnsi(harness.render()),
    /\/reload — reload extension-owned slash command state/,
  );
  assert.match(stripAnsi(harness.render()), /\/resume \[session-id\|path\] —/u);
  assert.doesNotMatch(stripAnsi(harness.render()), /\/fork —/u);

  await submitEditorText(harness, "/clear");
  await submitEditorText(harness, "/help all");
  assert.match(
    stripAnsi(harness.render()),
    /\/fork — [\s\S]*?compatibility\s+alias for \/session fork --current/u,
  );
  harness.session.appendAssistantChunk("assistant reply to copy");
  harness.session.finishAssistantMessage();

  await submitEditorText(harness, "/settings inspect");
  assert.match(stripAnsi(harness.render()), /Spark settings:/);
  assert.match(stripAnsi(harness.render()), /active model: fake\/model-a/);

  await submitEditorText(harness, "/settings set thinking high");
  assert.match(stripAnsi(harness.render()), /thinking level set.*high/i);

  await submitEditorText(harness, "/scoped-models inspect");
  assert.match(stripAnsi(harness.render()), /fake/);
  assert.match(stripAnsi(harness.render()), /model-a/);

  await submitEditorText(harness, "/name parity session");
  assert.match(stripAnsi(harness.render()), /Session name set: parity session/);

  await submitEditorText(harness, "/copy");
  assert.match(stripAnsi(harness.render()), /assistant reply to copy/);

  await submitEditorText(harness, "/hotkeys inspect");
  assert.match(stripAnsi(harness.render()), /app.exit/);

  await submitEditorText(harness, "/new transcript");
  assert.match(stripAnsi(harness.render()), /Started a new Spark native transcript/);
  assert.doesNotMatch(stripAnsi(harness.render()), /Unknown command: \/settings/);
});

test("Spark native runtime slash bridge preserves editor helpers and deterministic command errors", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-native-slash-bridge", hasUI: true });
  const sent: string[] = [];
  host.registerCommand("implement", {
    description: "Enter Spark implement mode",
    async handler(args, ctx) {
      await ctx.sendUserMessage?.(`implement:${args}`);
    },
  });
  host.registerCommand("prompt", {
    description: "Prefill editor prompt",
    handler: (_args, ctx) =>
      (ctx.ui as { setEditorText?: (text: string) => void } | undefined)?.setEditorText?.("/plan "),
  });
  host.registerCommand("explode", {
    description: "Raise a command failure",
    handler: () => {
      throw new Error("boom");
    },
  });

  const harness = createSparkNativeTuiHarness({
    slashCommands: createSparkNativeRuntimeSlashCommands(host, {
      sendUserMessage: (content) => void sent.push(content),
    }),
  });
  host.setUiTransport({
    setEditorText: (text) => harness.app.setEditorText(text),
  });

  await submitEditorText(harness, "/implement task frontier");
  assert.deepEqual(sent, ["implement:task frontier"]);

  await submitEditorText(harness, "/prompt");
  assert.match(stripAnsi(harness.render()), /\/plan /);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/explode");
  assert.match(stripAnsi(harness.render()), /Command \/explode failed: boom/);
});

test("native /plan reaches the daemon-managed responder instead of the local runtime loop", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-native-plan-daemon-bridge-"));
  try {
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, "README.md"), "# Existing project\n", "utf8");
    const host = new SparkHostRuntime({ cwd, hasUI: true });
    sparkExtension(host as never);
    const forwarded: string[] = [];
    const responderInputs: string[] = [];
    const slashCommands = createSparkNativeRuntimeSlashCommands(host, {
      sendUserMessage: async (content, context) => {
        forwarded.push(content);
        await context.session.submit(content);
      },
    });
    const harness = createSparkNativeTuiHarness({
      slashCommands,
      responder: (input) => {
        responderInputs.push(input);
        return "daemon-visible-plan-response";
      },
    });
    host.setUiTransport({
      notify: (message, level) => harness.session.addSystemMessage(`${level}:${message}`),
    });

    await submitEditorText(harness, "/plan Trace the daemon turn bridge");
    await waitForNativeCondition(
      () => forwarded.length === 1,
      "the native /plan command to reach the daemon-managed responder",
    );
    await harness.flush();

    assert.equal(forwarded.length, 1);
    assert.deepEqual(responderInputs, forwarded);
    assert.match(forwarded[0] ?? "", /## Planning focus\nTrace the daemon turn bridge/u);
    assert.equal(host.peekOutbox().length, 0);
    assert.match(stripAnsi(harness.render()), /daemon-visible-plan-response/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native /goal starts the daemon-owned driver instead of entering the local runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-native-goal-daemon-bridge-"));
  try {
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, "README.md"), "# Existing project\n", "utf8");
    const host = new SparkHostRuntime({ cwd, hasUI: true });
    host.setSessionId("sess_goal_bridge");
    const driverStarts: SparkLoopStartRequest[] = [];
    Object.assign(host, { loopControl: recordingDriverControl(driverStarts) });
    sparkExtension(host as never);
    const forwarded: string[] = [];
    const responderInputs: string[] = [];
    const slashCommands = createSparkNativeRuntimeSlashCommands(host, {
      sendUserMessage: async (content, context) => {
        forwarded.push(content);
        await context.session.submit(content);
      },
    });
    const harness = createSparkNativeTuiHarness({
      slashCommands,
      responder: (input) => {
        responderInputs.push(input);
        return "daemon-visible-goal-response";
      },
    });
    host.setUiTransport({
      notify: (message, level) => harness.session.addSystemMessage(`${level}:${message}`),
    });

    await submitEditorText(harness, "/goal Ship the daemon goal bridge");
    await waitForNativeCondition(
      () => driverStarts.length === 1,
      "the native /goal command to start the daemon-owned driver",
    );
    await harness.flush();

    assert.equal(driverStarts.length, 1);
    assert.ok(driverStarts[0]?.binding?.goalId);
    assert.equal(driverStarts[0]?.ownerSessionId, "sess_goal_bridge");
    assert.equal(driverStarts[0]?.continuity, "session");
    assert.match(driverStarts[0]?.prompt ?? "", /Ship the daemon goal bridge/u);
    assert.deepEqual(forwarded, []);
    assert.deepEqual(responderInputs, []);
    assert.equal(host.peekOutbox().length, 0);
    assert.match(stripAnsi(harness.render()), /Ship the daemon goal bridge/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("TUI action bar renders disabled and danger states and confirms danger actions", () => {
  const view = sparkSlashActionBarForInput("/queue");
  assert.ok(view);
  const actions: string[] = [];
  let cancelled = 0;
  const component = createSparkTuiActionBarComponent({
    view,
    theme: {
      fg: (color, text) => `<${color}>${text}</${color}>`,
    },
    resolveAvailability: (action) =>
      action.intent === "turn.retry"
        ? { disabled: true, reason: "no previous prompt to retry" }
        : { disabled: false },
    onAction: (action) => {
      actions.push(action.id);
    },
    onCancel: () => {
      cancelled += 1;
    },
  });

  component.handleInput("\x1b[C");
  assert.equal(component.selectedAction?.id, "retry-turn");
  assert.equal(component.selectedAvailability.disabled, true);
  component.handleInput("\r");
  assert.deepEqual(actions, []);
  assert.match(component.render(200).join("\n"), /Retry unavailable/);
  assert.match(component.render(200).join("\n"), /Unavailable: no previous prompt to retry/);

  component.handleInput("\x1b[C");
  assert.equal(component.selectedAction?.id, "stop-turn");
  assert.match(component.render(200).join("\n"), /<error>\[Stop and restore\]<\/error>/);
  component.handleInput("\r");
  assert.equal(component.pendingDangerActionId, "stop-turn");
  assert.deepEqual(actions, []);
  assert.match(component.render(200).join("\n"), /Confirm Stop and restore/);

  component.handleInput("\x1b[D");
  assert.equal(component.pendingDangerActionId, undefined);
  component.handleInput("\x1b[C");
  component.handleInput("\r");
  component.handleInput(ESC);
  assert.equal(cancelled, 1);
  assert.equal(component.pendingDangerActionId, undefined);
  assert.deepEqual(actions, []);

  component.handleInput("\r");
  component.handleInput("\r");
  assert.deepEqual(actions, ["stop-turn"]);
});

test("TUI action bar dispatches a normal action once even when Enter repeats", async () => {
  const view = sparkSlashActionBarForInput("/status");
  assert.ok(view);
  let resolveAction: (() => void) | undefined;
  const actions: string[] = [];
  const component = createSparkTuiActionBarComponent({
    view,
    onAction: (action) =>
      new Promise<void>((resolve) => {
        actions.push(action.id);
        resolveAction = resolve;
      }),
  });

  component.handleInput("\r");
  component.handleInput("\r");
  assert.equal(actions.length, 1);
  resolveAction?.();
  await Promise.resolve();
});

test("bare catalog slash opens a focused bottom action bar without writing transcript", async () => {
  const harness = createSparkNativeTuiHarness({
    withOverlay: true,
    slashCommands: {
      settings: { description: "Settings", handler: () => "legacy settings output" },
    },
  });
  const messageCount = harness.session.messages.length;

  assert.equal(await harness.submit("/settings"), "command");
  assert.equal(harness.session.messages.length, messageCount);
  assert.deepEqual(harness.app.actionBarSnapshot(), {
    id: "settings",
    selectedActionId: "inspect-settings",
    focused: false,
  });

  const overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  assert.equal(overlay.visible, true);
  assert.equal(overlay.options?.anchor, "bottom-center");
  assert.equal(harness.state.focused, overlay.component);
  assert.match(stripAnsi(overlay.component.render(72).join("\n")), /\[Overview\]/);

  overlay.component.handleInput?.("\x1b[C");
  assert.equal(harness.app.actionBarSnapshot()?.selectedActionId, "inspect-providers");
  overlay.component.handleInput?.(ESC);
  assert.equal(overlay.visible, false);
  assert.equal(harness.app.actionBarSnapshot(), undefined);
  assert.equal(harness.state.focused, harness.app);
  assert.equal(harness.session.messages.length, messageCount);
});

test("TUI host disables unavailable action-bar operations and enables them from live state", async () => {
  const harness = createSparkNativeTuiHarness({
    withOverlay: true,
    responder: (input) => `ack:${input}`,
  });
  let messageCount = harness.session.messages.length;

  await harness.submit("/queue");
  let overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  let rendered = stripAnsi(overlay.component.render(100).join("\n"));
  assert.match(rendered, /Retry unavailable/);
  assert.match(rendered, /Stop and restore unavailable/);
  overlay.component.handleInput?.("\x1b[C");
  overlay.component.handleInput?.("\r");
  await harness.flush();
  assert.equal(overlay.visible, true);
  assert.equal(harness.session.messages.length, messageCount);
  overlay.component.handleInput?.(ESC);

  await harness.submit("retryable prompt");
  await harness.flush();
  await harness.submit("/queue");
  overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  overlay.component.handleInput?.("\x1b[C");
  rendered = stripAnsi(overlay.component.render(100).join("\n"));
  assert.match(rendered, /\[Retry\]/);
  assert.doesNotMatch(rendered, /Retry unavailable/);
  overlay.component.handleInput?.("\r");
  await harness.flush();
  assert.match(stripAnsi(harness.render()), /Retrying: retryable prompt/);

  messageCount = harness.session.messages.length;
  await harness.submit("/workflow-runs");
  overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  overlay.component.handleInput?.("\x1b[C");
  rendered = stripAnsi(overlay.component.render(100).join("\n"));
  assert.match(rendered, /Inspect selected unavailable/);
  assert.match(rendered, /\/workflow-inspect is not registered/);
  overlay.component.handleInput?.("\r");
  await harness.flush();
  assert.equal(overlay.visible, true);
  assert.equal(harness.session.messages.length, messageCount);
  overlay.component.handleInput?.(ESC);

  await harness.submit("/settings");
  overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  rendered = stripAnsi(overlay.component.render(100).join("\n"));
  assert.match(rendered, /Overview unavailable/);
  assert.match(rendered, /\/settings is not registered/);
  overlay.component.handleInput?.("\r");
  await harness.flush();
  assert.equal(overlay.visible, true);
  assert.equal(harness.session.messages.length, messageCount);
  overlay.component.handleInput?.(ESC);

  let finishTurn: ((result: string) => void) | undefined;
  const busyHarness = createSparkNativeTuiHarness({
    withOverlay: true,
    responder: () =>
      new Promise<string>((resolve) => {
        finishTurn = resolve;
      }),
  });
  await busyHarness.submit("long turn");
  await busyHarness.submit("/queue");
  const busyOverlay = busyHarness.state.overlays.at(-1);
  assert.ok(busyOverlay);
  busyOverlay.component.handleInput?.("\x1b[C");
  busyOverlay.component.handleInput?.("\x1b[C");
  rendered = stripAnsi(busyOverlay.component.render(100).join("\n"));
  assert.doesNotMatch(rendered, /Stop and restore unavailable/);
  busyOverlay.component.handleInput?.("\r");
  assert.equal(busyHarness.session.isProcessing, true);
  assert.equal(busyOverlay.visible, true);
  assert.match(stripAnsi(busyOverlay.component.render(100).join("\n")), /Confirm Stop and restore/);
  busyOverlay.component.handleInput?.("\r");
  await busyHarness.flush();
  assert.equal(busyHarness.session.isProcessing, false);
  assert.equal(busyOverlay.visible, false);
  finishTurn?.("late response");
  await busyHarness.flush();
  assert.doesNotMatch(stripAnsi(busyHarness.render()), /late response/);
});

test("action bar executes semantic actions and only explicit inspection emits legacy text", async () => {
  const calls: Array<{ name: string; args: string }> = [];
  const command = (name: string) => ({
    description: name,
    handler: (args: string) => {
      calls.push({ name, args });
      return `legacy:${name}:${args || "empty"}`;
    },
  });
  const harness = createSparkNativeTuiHarness({
    withOverlay: true,
    slashCommands: {
      settings: command("settings"),
      model: command("model"),
      goal: command("goal"),
      hotkeys: command("hotkeys"),
      session: command("session"),
      sessions: command("sessions"),
      new: command("new"),
    },
  });
  const pressFocused = async (data: string) => {
    const focused = harness.state.focused as { handleInput?: (input: string) => void };
    assert.equal(typeof focused.handleInput, "function");
    focused.handleInput?.(data);
    await harness.flush();
  };

  let messageCount = harness.session.messages.length;
  await harness.submit("/thinking");
  await pressFocused("\x1b[C");
  await pressFocused("\r");
  assert.deepEqual(calls.at(-1), { name: "settings", args: "set thinking minimal" });
  assert.equal(harness.session.messages.length, messageCount);

  await harness.submit("/scoped-models");
  await pressFocused("\r");
  assert.deepEqual(calls.at(-1), { name: "model", args: "" });
  assert.equal(harness.session.messages.length, messageCount);

  await harness.submit("/settings");
  await pressFocused("\r");
  assert.deepEqual(calls.at(-1), { name: "settings", args: "inspect" });
  assert.equal(harness.session.messages.length, messageCount + 1);
  assert.match(harness.session.messages.at(-1)?.text ?? "", /legacy:settings:inspect/);

  messageCount = harness.session.messages.length;
  await harness.submit("/goal");
  await pressFocused("\x1b[C");
  await pressFocused("\r");
  assert.deepEqual(calls.at(-1), { name: "goal", args: "start" });
  assert.equal(harness.session.messages.length, messageCount);

  await harness.submit("/goal");
  await pressFocused("\r");
  assert.deepEqual(calls.at(-1), { name: "goal", args: "status" });
  assert.equal(harness.session.messages.length, messageCount + 1);
  assert.match(harness.session.messages.at(-1)?.text ?? "", /legacy:goal:status/);

  const transcriptBeforeNewSession = harness.session.messages.map(({ role, text }) => ({
    role,
    text,
  }));
  await harness.submit("/session");
  await pressFocused("\x1b[C");
  await pressFocused("\r");
  assert.deepEqual(calls.at(-1), { name: "sessions", args: "" });
  assert.equal(
    calls.some(({ name }) => name === "new"),
    false,
  );
  assert.deepEqual(
    harness.session.messages.map(({ role, text }) => ({ role, text })),
    transcriptBeforeNewSession,
  );

  messageCount = harness.session.messages.length;
  await harness.submit("/workflow-runs");
  await pressFocused("\r");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "runs");
  assert.equal(harness.session.messages.length, messageCount);

  await harness.submit("/inspect runs");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "runs");
  assert.equal(harness.session.messages.length, messageCount);
});

test("thinking action updates a daemon-managed session without changing the global default", async () => {
  const config: SparkCliHostServices["config"] = {
    extensions: [],
    providers: [],
    activeThinkingLevel: "low",
  };
  let savedDefaults = 0;
  const sessionLevels: SparkThinkingLevel[] = [];
  const services = {
    config,
    saveConfig: async () => {
      savedDefaults += 1;
    },
  } as unknown as SparkCliHostServices;
  const modelControl = {
    sessionId: "session:thinking-action",
    setSessionThinkingLevel: async (thinkingLevel: SparkThinkingLevel) => {
      sessionLevels.push(thinkingLevel);
      return { thinkingLevel } as never;
    },
  } as unknown as SparkDaemonModelAuthClient;
  const harness = createSparkNativeTuiHarness({
    withOverlay: true,
    slashCommands: createSparkPiParitySlashCommands(services, modelControl),
  });

  await harness.submit("/thinking");
  const overlay = harness.state.overlays.at(-1);
  assert.ok(overlay);
  overlay.component.handleInput?.("\x1b[C");
  overlay.component.handleInput?.("\r");
  await harness.flush();

  assert.deepEqual(sessionLevels, ["minimal"]);
  assert.equal(config.activeThinkingLevel, "low");
  assert.equal(savedDefaults, 0);
});

test("Spark native TUI surfaces command availability, queued work, stop, and turn errors", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const harness = createSparkNativeTuiHarness({
    slashCommands: {
      plan: { description: "Enter Spark plan mode", handler: () => "plan routed" },
      status: { description: "Show daemon status", handler: () => "daemon ok" },
      ...createSparkNativeLocalControlSlashCommands(),
    },
    responder: (input) => {
      if (input === "first") {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (input === "fail") throw new Error("daemon unavailable");
      return `ack:${input}`;
    },
  });

  assert.match(stripAnsi(harness.render()), /session local • state idle • 2 registered commands/);
  assert.equal(await harness.submit("/help commands"), "command");
  assert.match(stripAnsi(harness.render()), /Spark commands/);
  assert.match(stripAnsi(harness.render()), /\/plan — Enter Spark plan mode/);

  assert.equal(await harness.submit("first"), "started");
  await harness.flush();
  assert.equal(await harness.submit("second"), "queued");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /session local • state running • queue steer=1 follow-up=0/,
  );
  assert.match(stripAnsi(harness.render()), /◆ Input queue · local 1/);
  assert.match(stripAnsi(harness.render()), /└─ 1\. steer · second/);
  assert.doesNotMatch(stripAnsi(harness.render()), /Queued steering message/);

  assert.equal(await harness.submit("/stop dogfood"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /Stopped current Spark turn \(dogfood\)\. Restored 1 queued input\(s\) to the editor/,
  );
  releaseFirst?.("late response ignored");
  await harness.flush();
  assert.doesNotMatch(stripAnsi(harness.render()), /late response ignored/);

  assert.equal(await harness.submit("fail"), "started");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /system> Spark turn failed: daemon unavailable\. Use \/retry to resubmit or \/status to inspect the\s+daemon\./,
  );
});

test("Spark native TUI shows Working only while a turn is active", async () => {
  let finishTurn: ((value: string) => void) | undefined;
  const harness = createSparkNativeTuiHarness({
    responder: () =>
      new Promise<string>((resolve) => {
        finishTurn = resolve;
      }),
  });

  assert.doesNotMatch(stripAnsi(harness.render()), /Working\.\.\./);

  assert.equal(await harness.submit("long-running task"), "started");
  assert.equal(harness.session.isProcessing, true);
  assert.match(stripAnsi(harness.render()), /⠼ Working\.\.\. • Enter steer/);
  await waitForNativeCondition(
    () => /[⠴⠦⠧⠇⠏⠋⠙⠹⠸] Working\.\.\./u.test(stripAnsi(harness.render())),
    "the Working spinner to advance",
  );

  finishTurn?.("completed response");
  await waitForNativeCondition(
    () => !harness.session.isProcessing,
    "the deferred Spark turn to finish",
  );

  const completed = stripAnsi(harness.render());
  assert.match(completed, /spark> completed response/);
  assert.doesNotMatch(completed, /Working\.\.\./);

  const renderRequestsAfterCompletion = harness.state.renderRequests.length;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(harness.state.renderRequests.length, renderRequestsAfterCompletion);
});

test("Spark native editor expands @file/image refs and bang commands through real submit path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-editor-input-"));
  try {
    await writeFile(join(dir, "note.txt"), "file body from @ reference", "utf8");
    await writeFile(join(dir, "screen.png"), "not-a-real-png-but-path-reference-is-enough", "utf8");
    const submitted: string[] = [];
    const harness = createSparkNativeTuiHarness({
      autocompleteBasePath: dir,
      responder: (input) => {
        submitted.push(input);
        return `ack:${input}`;
      },
    });

    await submitEditorText(harness, "Read @note.txt");
    await harness.flush();
    assert.match(
      submitted.at(-1) ?? "",
      /<file name=".*note\.txt">\nfile body from @ reference\n<\/file>/s,
    );

    await submitEditorText(harness, "Read @note.txt and @screen.png");
    await harness.flush();
    assert.match(
      submitted.at(-1) ?? "",
      /<file name=".*note\.txt">\nfile body from @ reference\n<\/file>/s,
    );
    assert.match(
      submitted.at(-1) ?? "",
      /<image name=".*screen\.png" mime="image\/png" bytes="\d+">data:image\/png;base64,/s,
    );
    assert.match(stripAnsi(harness.render()), /\[inline image data omitted\]/);

    await submitEditorText(harness, `Dragged ${join(dir, "screen.png")}`);
    await harness.flush();
    assert.match(
      submitted.at(-1) ?? "",
      /Dragged <image name=".*screen\.png" mime="image\/png" bytes="\d+">data:image\/png;base64,/s,
    );

    const tooWidePng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(tooWidePng, 0);
    tooWidePng.writeUInt32BE(5000, 16);
    tooWidePng.writeUInt32BE(1, 20);
    await writeFile(join(dir, "too-wide.png"), tooWidePng);
    const beforeTooWide = submitted.length;
    await submitEditorText(harness, "Inspect @too-wide.png");
    await harness.flush();
    assert.equal(submitted.length, beforeTooWide);
    assert.match(stripAnsi(harness.render()), /max dimension is 4096px/);

    const bangOutputPattern = /\$ printf spark-bang\nexit: 0\nspark-bang/;
    const beforeBang = submitted.length;
    await submitEditorText(harness, "!printf spark-bang");
    await harness.flush();
    await waitForNativeCondition(
      () => submitted.slice(beforeBang).some((message) => bangOutputPattern.test(message)),
      "the bang command output to reach the submit path",
    );
    assert.match(
      submitted.slice(beforeBang).find((message) => bangOutputPattern.test(message)) ?? "",
      bangOutputPattern,
    );

    const beforeHidden = submitted.length;
    await submitEditorText(harness, "!!printf hidden-bang");
    await harness.flush();
    assert.equal(submitted.length, beforeHidden);
    await waitForNativeCondition(
      () =>
        harness.session.messages.some(
          (message) =>
            message.role === "tool" &&
            message.toolName === "shell" &&
            message.toolStatus === "succeeded",
        ),
      "the hidden shell command to reach a terminal tool state",
    );
    assert.match(stripAnsi(harness.render()), /tool:shell \[succeeded\]/);
    harness.app.toggleTools();
    assert.match(stripAnsi(harness.render()), /\[hidden shell command completed\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark native editor supports multiline and Pi-style busy queue restore keys", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const submitted: string[] = [];
  const harness = createSparkNativeTuiHarness({
    responder: (input) => {
      submitted.push(input);
      if (input === "first") {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return `ack:${input}`;
    },
  });

  await typeEditorText(harness, "line one");
  await harness.press("\u001b[13;2u");
  await typeEditorText(harness, "line two");
  await harness.press("\r");
  await harness.flush();
  assert.equal(submitted.at(-1), "line one\nline two");

  await submitEditorText(harness, "first");
  await harness.flush();
  harness.app.setEditorText("follow-up text");
  await harness.press("\u001b\r");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /◆ Input queue · local 1[\s\S]*└─ 1\. follow-up · follow-up text/,
  );

  await harness.press("\u001bp");
  await harness.flush();
  assert.match(stripAnsi(harness.render()), /Restored queued input to the editor/);
  assert.match(stripAnsi(harness.render()), /follow-up text/);

  harness.app.setEditorText("steer then escape");
  await harness.press("\r");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /◆ Input queue · local 1[\s\S]*└─ 1\. steer · steer then escape/,
  );
  await harness.press("\u001b");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /Stopped current Spark turn \(escape\)\. Restored 1 queued input\(s\) to the editor/,
  );
  assert.match(stripAnsi(harness.render()), /steer then escape/);
  releaseFirst?.("done");
  await harness.flush();
});

test("Spark native busy queue delivers steering separately from follow-up turns", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  let releaseSteer: ((value: string) => void) | undefined;
  const submitted: string[] = [];
  const harness = createSparkNativeTuiHarness({
    responder: (input) => {
      submitted.push(input);
      if (input === "first") {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (input.startsWith("Steering update for the previous Spark turn.")) {
        return new Promise<string>((resolve) => {
          releaseSteer = resolve;
        });
      }
      return `ack:${input}`;
    },
  });

  await submitEditorText(harness, "first");
  harness.app.setEditorText("steer one");
  await harness.press("\r");
  await harness.flush();
  harness.app.setEditorText("follow next");
  await harness.press("\u001b\r");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /◆ Input queue · local 2[\s\S]*1\. steer · steer one[\s\S]*2\. follow-up · follow next/,
  );

  releaseFirst?.("done");
  await waitForNativeCondition(() => submitted.length >= 2, "the steering queue item to start");
  await harness.flush();

  assert.equal(submitted[0], "first");
  assert.match(submitted[1] ?? "", /^Steering update for the previous Spark turn\./);
  assert.match(submitted[1] ?? "", /Steering 1:\nsteer one/);
  assert.match(
    stripAnsi(harness.render()),
    /◆ Input queue · local 1[\s\S]*└─ 1\. follow-up · follow next/,
  );
  assert.doesNotMatch(stripAnsi(harness.render()), /steer · steer one/);

  releaseSteer?.("steered");
  await waitForNativeCondition(() => submitted.length >= 3, "the follow-up queue item to start");
  await waitForNativeCondition(() => !harness.session.isProcessing, "the follow-up turn to finish");
  await harness.flush();

  assert.equal(submitted[2], "follow next");
  assert.doesNotMatch(stripAnsi(harness.render()), /◆ Input queue/);
});

test("Spark native TUI harness captures resize-safe golden render sections", () => {
  const harness = createSparkNativeTuiHarness({ cols: 34 });
  harness.session.appendAssistantChunk(
    "streaming response with enough content to wrap across narrow widths",
  );
  harness.session.addToolMessage({
    toolName: "read",
    toolCallId: "tc-1",
    status: "success",
    text: "first line\nsecond line with wider details",
  });
  harness.session.addThinking("hidden chain of implementation notes");

  const narrowLines = harness.renderLines(34);
  assert.equal(
    narrowLines.every((line) => visibleWidth(line) <= 34),
    true,
    "narrow render should respect the requested width",
  );
  assert.match(stripAnsi(narrowLines.join("\n")), /spark> streaming response/);
  assert.match(stripAnsi(narrowLines.join("\n")), /✓ tool:read \[succeeded\] — first\.\.\./);
  assert.match(stripAnsi(narrowLines.join("\n")), /thinking • hidden/);

  harness.app.toggleTools();
  harness.app.toggleThinking();
  const wideLines = harness.renderLines(88);
  const wideText = stripAnsi(wideLines.join("\n"));
  assert.equal(
    wideLines.every((line) => visibleWidth(line) <= 88),
    true,
    "wide render should respect the requested width",
  );
  assert.match(wideText, /┌─ ✓ tool:read \[succeeded\] · tc-1/);
  assert.match(wideText, /│ first line/);
  assert.match(wideText, /│ second line with wider details/);
  assert.match(wideText, /thinking> hidden chain of implementation notes/);
});

test("Spark native TUI preserves the complete latest logical message at release sizes", () => {
  const body =
    "LATEST_MESSAGE_BEGIN alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau LATEST_MESSAGE_END";
  const harness = createSparkNativeTuiHarness({ cols: 160, rows: 40 });
  harness.session.addSystemMessage("older transcript entry must remain available");
  harness.session.appendAssistantChunk(body);

  for (const [width, height] of [
    [60, 18],
    [80, 24],
    [120, 30],
    [160, 40],
  ] as const) {
    const lines = harness.renderLines(width);
    const rendered = stripAnsi(lines.join("\n"));
    assert.equal(
      lines.every((line) => visibleWidth(line) <= width),
      true,
      `${width}x${height} render must stay within the terminal width`,
    );
    assert.match(rendered, /older transcript entry must remain available/u);
    assert.match(rendered, /LATEST_MESSAGE_BEGIN/u);
    assert.match(rendered, /LATEST_MESSAGE_END/u);
  }
});

test("Spark native TUI labels channel users and cross-session agents", () => {
  const harness = createSparkNativeTuiHarness({ cols: 88 });
  harness.app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "session:channel-senders",
      status: "idle",
      messages: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "session-agent",
          role: "user",
          text: "delegated request",
          status: "done",
          metadata: {
            origin: { kind: "session", sessionId: "session:worker-a" },
            sessionMail: { fromSessionId: "session:worker-a" },
          },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "channel-user",
          role: "user",
          text: "群消息",
          status: "done",
          metadata: {
            channel: { senderName: "徐晓健", senderId: "xuxiaojian" },
          },
          parts: [
            {
              id: "channel-user:part:0",
              type: "text",
              text: "群消息",
              status: "complete",
              metadata: {},
            },
          ],
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "channel-quote",
          role: "user",
          text: "请继续",
          status: "done",
          metadata: {
            channel: {
              senderName: "Alice",
              messageReference: {
                messageId: "m-source",
                preview: "被引用原文",
                senderName: "Bob",
                source: "embedded",
              },
            },
          },
          parts: [
            {
              id: "channel-quote:part:0",
              type: "text",
              text: "请继续",
              status: "complete",
              metadata: {},
            },
          ],
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "local-user",
          role: "user",
          text: "网页消息",
          status: "done",
          metadata: {},
        },
      ],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:01.000Z",
      metadata: {},
    },
  });

  const rendered = stripAnsi(harness.render());
  assert.match(rendered, /徐晓健> 群消息/);
  assert.match(rendered, /agent:worker-a> delegated request/);
  assert.match(rendered, /│ Bob/);
  assert.match(rendered, /│ 被引用原文/);
  assert.match(rendered, /Alice> 请继续/);
  assert.match(rendered, /you> 网页消息/);
});

test("Spark cockpit renders shared workflow, run, task, artifact, review, and Graft view models", async () => {
  const harness = createSparkNativeTuiHarness({
    cols: 120,
    slashCommands: createSparkNativeLocalControlSlashCommands(),
  });

  harness.app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "session:dogfood",
      title: "Dogfood cockpit session",
      status: "streaming",
      messages: [],
      tools: [],
      runs: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "run:release-readiness",
          kind: "workflow",
          title: "Release readiness workflow",
          status: "running",
          progress: 0.5,
          evidenceRefs: [],
          artifactRefs: [],
          metadata: { selector: "builtin:review" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "role:reviewer",
          kind: "role",
          title: "Reviewer pass",
          status: "running",
          progress: 0.4,
          evidenceRefs: ["evidence:review-ok"],
          artifactRefs: [],
          metadata: { reviewer: "goal", outcome: "approved" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "task:graft-apply",
          kind: "task",
          title: "Apply Graft patch",
          status: "succeeded",
          evidenceRefs: ["evidence:graft-patch"],
          artifactRefs: [],
          metadata: { patchRef: "patch:abc", graftStatus: "admitted" },
        },
      ],
      tasks: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "task:spark-cockpit-superpowers",
          name: "spark-cockpit-superpowers",
          title: "Spark cockpit superpowers",
          kind: "implement",
          status: "running",
          projectRef: "proj:demo",
          todos: [
            { id: "map", content: "Map data surfaces", status: "done", notes: [] },
            { id: "render", content: "Render cockpit panels", status: "in_progress", notes: [] },
          ],
          runRefs: ["run:release-readiness"],
          evidenceRefs: ["evidence:review-ok"],
          artifactRefs: [],
          metadata: {},
        },
      ],
      artifacts: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "evidence:review-ok",
          title: "Reviewer verdict for cockpit task",
          kind: "record",
          format: "json",
          status: "approved",
          producer: "review",
          preview: "reviewer approved task finish evidence",
          metadata: { outcome: "approved", reviewer: "spark-reviewer" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "evidence:graft-patch",
          title: "Graft patch provenance",
          kind: "record",
          format: "json",
          status: "admitted",
          producer: "task",
          preview: "candidate:abc patch:abc",
          metadata: {
            candidateRef: "candidate:abc",
            patchRef: "patch:abc",
            graftStatus: "admitted",
          },
        },
      ],
      evidence: [],
      metadata: {},
    },
  });

  assert.deepEqual(harness.app.cockpitSnapshot(), {
    activePanel: undefined,
    sessionId: "session:dogfood",
    sessionStatus: "streaming",
    workflows: 1,
    workflowRuns: 1,
    roleRuns: 1,
    tasks: 1,
    artifacts: 0,
    evidence: 2,
    reviews: 2,
    graftItems: 2,
    interactions: 0,
  });

  assert.equal(harness.app.toggleCockpitPanel("overview"), true);
  assert.match(
    stripAnsi(harness.render()),
    /Workflow picker\/progress: 1 option\(s\), 1 workflow run\(s\)/,
  );
  assert.match(stripAnsi(harness.render()), /Role-run board: 1 role run\(s\), 0 interaction\(s\)/);

  assert.equal(await harness.submit("/inspect runs"), "command");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "runs");
  assert.match(
    stripAnsi(harness.render()),
    /role role:reviewer \[running\] 40% evidence=1 Reviewer pass/,
  );
  assert.match(
    stripAnsi(harness.render()),
    /workflow run:release-readiness \[running\] 50% Release readiness workflow/,
  );
  assert.match(stripAnsi(harness.render()), /Actions: \/workflow inspect run:release-readiness/);
  assert.match(stripAnsi(harness.render()), /\/workflow pause run:release-readiness/);
  assert.match(stripAnsi(harness.render()), /\/workflow stop run:release-readiness/);
  assert.match(stripAnsi(harness.render()), /\/workflow save run:release-readiness/);

  assert.equal(await harness.submit("/tasks"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /task:spark-cockpit-superpowers \[running\] todos=1\/2 evidence=1 Spark cockpit superpowers/,
  );

  assert.equal(await harness.submit("/artifacts"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /evidence:review-ok \[record\/json\] producer=review status=approved Reviewer verdict/,
  );
  assert.match(
    stripAnsi(harness.render()),
    /evidence:graft-patch \[record\/json\] producer=task status=admitted Graft patch provenance/,
  );

  assert.equal(await harness.submit("/reviews"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /evidence:review-ok \[approved\] Reviewer verdict for cockpit task/,
  );
  assert.match(stripAnsi(harness.render()), /role:role:reviewer \[approved\] Reviewer pass/);

  assert.equal(await harness.submit("/graft"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /evidence:graft-patch patch=patch:abc candidate=candidate:abc status=admitted/,
  );
  assert.match(
    stripAnsi(harness.render()),
    /task:task:graft-apply patch=patch:abc status=admitted/,
  );
});

test("Spark cockpit supports selectable workflow run keyboard controls", async () => {
  const invoked: Array<{ name: string; args: string }> = [];
  const slashCommands = Object.fromEntries(
    ["inspect", "pause", "resume", "stop", "restart", "save", "ack"].map((action) => [
      `workflow-${action}`,
      {
        description: `Workflow ${action}`,
        handler: (args: string) => {
          invoked.push({ name: `workflow-${action}`, args });
          return `handled:${action}:${args}`;
        },
      },
    ]),
  );
  const harness = createSparkNativeTuiHarness({
    cols: 140,
    slashCommands: { ...createSparkNativeLocalControlSlashCommands(), ...slashCommands },
  });
  harness.app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "session:workflow-controls",
      status: "idle",
      messages: [],
      tools: [],
      runs: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "run:first",
          kind: "workflow",
          title: "First workflow",
          status: "running",
          progress: 0.25,
          evidenceRefs: [],
          artifactRefs: [],
          metadata: { dynamicStatus: "running" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "run:second",
          kind: "workflow",
          title: "Second workflow",
          status: "running",
          progress: 0.75,
          evidenceRefs: [],
          artifactRefs: [],
          metadata: { dynamicStatus: "paused" },
        },
      ],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {},
    },
  });

  assert.equal(await harness.submit("/inspect runs"), "command");
  assert.match(stripAnsi(harness.render()), /▸─ workflow run:first \[running\] 25% First workflow/);
  assert.match(stripAnsi(harness.render()), /Keys: ↑\/↓ or j\/k select workflow run/);

  await harness.press("j");
  assert.match(stripAnsi(harness.render()), /Selected: run:second \[paused\]/);
  assert.match(
    stripAnsi(harness.render()),
    /▸─ workflow run:second \[paused\] 75% Second workflow/,
  );
  assert.match(stripAnsi(harness.render()), /\/workflow resume run:second/);

  await harness.press("i");
  assert.deepEqual(invoked.at(-1), { name: "workflow-inspect", args: "run:second" });
  await harness.press("u");
  assert.deepEqual(invoked.at(-1), { name: "workflow-resume", args: "run:second" });
  await harness.press("x");
  assert.deepEqual(invoked.at(-1), { name: "workflow-stop", args: "run:second" });

  await harness.press("k");
  assert.match(stripAnsi(harness.render()), /Selected: run:first \[running\]/);
  await harness.press("p");
  assert.deepEqual(invoked.at(-1), { name: "workflow-pause", args: "run:first" });
  await harness.press("r");
  assert.deepEqual(invoked.at(-1), { name: "workflow-restart", args: "run:first" });
  await harness.press("s");
  assert.deepEqual(invoked.at(-1), { name: "workflow-save", args: "run:first" });
  await harness.press("a");
  assert.deepEqual(invoked.at(-1), { name: "workflow-ack", args: "run:first" });

  await harness.press("\x1B");
  assert.equal(harness.app.cockpitSnapshot().activePanel, undefined);
});

test("Spark cockpit records workflow picker requests and exposes slash command navigation", async () => {
  const harness = createSparkNativeTuiHarness({
    cols: 110,
    slashCommands: createSparkNativeLocalControlSlashCommands(),
  });

  const response = await harness.app.handleInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "pick-workflow",
    kind: "workflowPicker",
    title: "Choose a Spark workflow",
    prompt: "Pick a workflow for the next foreground step.",
    source: "test",
    options: [
      {
        selector: "builtin:research",
        label: "Research",
        description: "Gather context before implementation.",
        phaseCount: 5,
        metadata: {},
      },
      {
        selector: "builtin:review",
        label: "Review",
        description: "Audit implementation evidence.",
        phaseCount: 4,
        metadata: {},
      },
    ],
    metadata: {},
  });

  assert.equal(response.status, "blocked");
  assert.equal(response.kind, "workflowPicker");
  assert.deepEqual(harness.app.cockpitSnapshot(), {
    activePanel: undefined,
    sessionId: undefined,
    sessionStatus: undefined,
    workflows: 2,
    workflowRuns: 0,
    roleRuns: 0,
    tasks: 0,
    artifacts: 0,
    evidence: 0,
    reviews: 0,
    graftItems: 0,
    interactions: 1,
  });

  assert.equal(await harness.submit("/inspect workflows"), "command");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "workflows");
  const workflows = harness.render();
  assert.match(workflows, /picker pick-workflow: Choose a Spark workflow \(2 option\(s\)\)/);
  assert.match(
    workflows,
    /picker builtin:research: Research — Gather context before implementation\./,
  );
  assert.match(workflows, /picker builtin:review: Review — Audit implementation evidence\./);

  assert.equal(harness.app.cycleCockpitPanel(), "runs");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "runs");

  assert.equal(await harness.submit("/inspect off"), "command");
  assert.equal(harness.app.cockpitSnapshot().activePanel, undefined);

  assert.equal(await harness.submit("/help commands"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /\/inspect \[overview\|workflows\|runs\|tasks\|artifacts\|reviews\|graft\|off\]/,
  );
  assert.doesNotMatch(stripAnsi(harness.render()), /\/cockpit \[overview/);
  assert.doesNotMatch(stripAnsi(harness.render()), /Ctrl\+K — toggle Spark cockpit overview/);
});

async function typeEditorText(
  harness: ReturnType<typeof createSparkNativeTuiHarness>,
  text: string,
): Promise<void> {
  for (const char of text) await harness.press(char);
}

async function submitEditorText(
  harness: ReturnType<typeof createSparkNativeTuiHarness>,
  text: string,
): Promise<void> {
  harness.app.setEditorText(text);
  await harness.press("\r");
  await waitForNativeTimers();
  await harness.flush();
}

async function waitForNativeTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function waitForNativeCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

const fakeStream: ProviderConfig["streamSimple"] = () => ({}) as unknown;

function fakeModel(id: string): ProviderModelDefinition {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

function fakeProvider(name: string, models: ProviderModelDefinition[]): ProviderConfig {
  return {
    name,
    baseUrl: `https://${name}.test`,
    api: "anthropic-messages",
    streamSimple: fakeStream,
    models,
  };
}

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "gu");

function visibleWidth(line: string): number {
  return line.replace(ANSI_ESCAPE_PATTERN, "").length;
}

test("Spark native TUI harness exercises fallback modal stack lifecycle", async () => {
  const harness = createSparkNativeTuiHarness();
  const modal = {
    render: () => ["approval modal"],
    invalidate: () => undefined,
  };

  const result = harness.app.custom<string>(
    (_tui, _theme, _keybindings, done) => {
      queueMicrotask(() => done("approved"));
      return modal;
    },
    { overlay: false },
  );

  assert.deepEqual(harness.state.children, [modal]);
  assert.equal(harness.state.focused, modal);

  assert.equal(await result, "approved");
  assert.deepEqual(harness.state.children, []);
  assert.equal(harness.state.focused, harness.app);
  assert.equal(harness.state.renderRequests.length > 0, true);
});
