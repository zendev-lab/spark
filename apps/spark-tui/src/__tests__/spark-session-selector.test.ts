import assert from "node:assert/strict";
import { join } from "node:path";
import { expect, test } from "vitest";

import type { SparkSessionProjection } from "@zendev-lab/spark-protocol";
import { visibleWidth } from "@zendev-lab/spark-tui-adapter/text";
import type { Component } from "../tui/pi-tui-adapter.ts";
import {
  createSparkSessionSelectorComponent,
  formatSparkSessionListByWorkspace,
  isSelectableSparkSession,
  selectSparkSessionFromCustomUi,
  type SparkSessionSelectorSelection,
  type SparkSessionSelectorWorkspace,
} from "../tui/session-selector.ts";
import type {
  SparkModelSelectorCustomUi,
  SparkModelSelectorTheme,
  SparkModelSelectorTuiLike,
} from "../tui/model-selector.ts";

const workspaces: SparkSessionSelectorWorkspace[] = [
  {
    id: "workspace-1",
    canonicalId: "workspace-1",
    displayName: "spark",
    localPath: "/workspace/spark",
    registration: "registered",
  },
  {
    id: "spark",
    canonicalId: "workspace-1",
    displayName: "spark",
    localPath: "/workspace/spark",
    registration: "registered",
  },
  {
    id: "workspace-2",
    canonicalId: "workspace-2",
    displayName: "spore",
    localPath: "/workspace/other",
    registration: "registered",
  },
];

const sessions: SparkSessionProjection[] = [
  {
    ...sessionRecord("session-recent", "Recent conversation", "2026-07-13T01:00:00.000Z"),
    model: { providerName: "openai", modelId: "gpt-5" },
    thinkingLevel: "high",
  },
];

const untitledSession = sessionRecord("session-untitled", undefined, "2026-07-13T02:00:00.000Z");

const archivedSession = {
  ...sessionRecord("session-archived", "Archived conversation", "2026-07-12T01:00:00.000Z"),
  placement: "archived" as const,
};

const channelBindingSession: SparkSessionProjection = {
  ...sessionRecord("session-channel-bound", "Ops room", "2026-07-13T02:00:00.000Z"),
  bindings: [{ kind: "channel", adapter: "feishu", externalKey: "feishu:chat:oc_ops" }],
};

const channelTitleSession = sessionRecord(
  "session-channel-title",
  "channel qqbot:c2c:398418FB5E7F1C597DFFD117597D6500",
  "2026-07-13T02:00:00.000Z",
);

const otherWorkspaceSession: SparkSessionProjection = {
  ...sessionRecord("session-other-workspace", "Other workspace", "2026-07-13T03:00:00.000Z"),
  scope: { kind: "workspace", workspaceId: "workspace-2" },
  owner: { kind: "session", supervisorSessionId: "administrator:workspace-2" },
  cwd: "/workspace/other",
  activity: "running",
};

const legacyWorkspaceSession: SparkSessionProjection = {
  ...sessionRecord("session-legacy-workspace", "Legacy workspace", "2026-07-13T03:30:00.000Z"),
  scope: { kind: "workspace", workspaceId: "spark" },
  owner: { kind: "session", supervisorSessionId: "administrator:spark" },
  cwd: "/workspace/spark",
};

const taskExecutionSession: SparkSessionProjection = {
  ...sessionRecord("session-task-worker", undefined, "2026-07-13T04:00:00.000Z"),
  roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
  owner: {
    kind: "task_run",
    supervisorSessionId: "session-recent",
    projectRef: "proj:demo",
    taskRef: "task:demo",
    runRef: "run:demo",
    sessionGoalId: "goal-demo",
    roleRef: "role:builtin-executor",
    jobId: "job-demo",
    attempt: 1,
  },
};

const fleetWorkerSession: SparkSessionProjection = {
  ...sessionRecord("session-fleet-worker", undefined, "2026-07-13T04:00:00.000Z"),
  roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
  owner: { kind: "session", supervisorSessionId: "session-recent" },
  stateBinding: { kind: "session", ref: "session-recent" },
  visibility: "internal",
  retention: "retain",
  purpose: "fleet_worker",
  fleetWorker: {
    ownerSessionId: "session-recent",
    projectRef: "proj:demo",
    roleRef: "role:builtin-executor",
    laneKey: "fleet:lane",
    primaryArtifactRef: "artifact:repo",
    writableArtifactRefs: ["artifact:repo"],
  },
};

const daemonSession: SparkSessionProjection = {
  sessionId: "session-daemon",
  name: "Daemon conversation",
  scope: { kind: "daemon", daemonId: "daemon-1" },
  cwd: "/daemon",
  lifecycle: "closed",
  placement: "active",
  activity: "idle",
  roleBinding: { kind: "none" },
  incarnation: 1,
  owner: {
    kind: "invocation",
    invocationId: "migration:session-daemon",
    supervisorSessionId: "migration:closed-daemon-audit",
  },
  stateBinding: { kind: "session", ref: "migration:closed-daemon-audit" },
  visibility: "internal",
  retention: "audit",
  purpose: "migration_audit",
  lifetime: "ephemeral",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T04:00:00.000Z",
};

test("Spark session selector renders explicit workspace creation and managed session choices", () => {
  const selected: SparkSessionSelectorSelection[] = [];
  const component = createSparkSessionSelectorComponent({
    sessions,
    workspaces,
    suggestedWorkspaceId: "workspace-1",
    onSelect: (value) => selected.push(value),
  });

  const lines = component.render(96);
  assert.equal(
    lines.some((line) => line.includes("Open Spark Session")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("+ New session")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("openai/gpt-5")),
    true,
  );
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 96),
    true,
  );

  component.handleInput?.("\r");
  assert.deepEqual(selected, [{ kind: "create", workspaceId: "workspace-1" }]);
});

test("Spark session selector presents an unregistered cwd as a workspace creation action", () => {
  const component = createSparkSessionSelectorComponent({
    sessions: [],
    workspaces: [
      {
        id: "__spark_launch_cwd_workspace__",
        canonicalId: "__spark_launch_cwd_workspace__",
        displayName: "new-project",
        localPath: "/workspace/new-project",
        registration: "suggested",
      },
      workspaces[0]!,
    ],
    suggestedWorkspaceId: "__spark_launch_cwd_workspace__",
    onSelect: () => undefined,
  });

  const rendered = component.render(120).join("\n");
  assert.match(rendered, /\[Create workspace\]/u);
  assert.match(rendered, /\+ Create workspace/u);
  assert.match(rendered, /Use \/workspace\/new-project, then open a new session/u);
  assert.doesNotMatch(rendered, /Launch cwd|Create workspace \(0\)|new-project \(0\)/u);
  assert.match(rendered, /spark \(0\)/u);
  assert.doesNotMatch(rendered, /spark • \/workspace\/spark/u);
});

test("Spark session selector uses the Hub fallback for untitled sessions", () => {
  const component = createSparkSessionSelectorComponent({
    sessions: [untitledSession],
    workspaces,
    suggestedWorkspaceId: "workspace-1",
    onSelect: () => undefined,
  });

  const lines = component.render(96);
  assert.equal(
    lines.some((line) => line.includes("New conversation")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("session-untitled")),
    true,
  );
});

test("Spark session selector hides internal task execution sessions and leaked builtin RoleRefs", () => {
  const legacyRoleSession = {
    ...sessionRecord("technical-role", "role:builtin-executor", "2026-07-20T06:00:00.000Z"),
    role: "role:builtin-executor",
  };
  const component = createSparkSessionSelectorComponent({
    sessions: [legacyRoleSession, taskExecutionSession, untitledSession],
    workspaces: [workspaces[0]!],
    suggestedWorkspaceId: "workspace-1",
    maxVisible: 10,
    onSelect: () => undefined,
  });

  const rendered = component.render(160).join("\n");
  assert.doesNotMatch(rendered, /technical-role|session-task-worker|role:builtin-executor/u);
  assert.match(rendered, /New conversation/u);
  assert.equal(isSelectableSparkSession(legacyRoleSession), false);
  assert.equal(isSelectableSparkSession(taskExecutionSession), false);
  assert.equal(isSelectableSparkSession(fleetWorkerSession), false);
});

test("Spark session selector keeps 10,000 internal task transcripts out of the interactive list", () => {
  const internalSessions = Array.from({ length: 10_000 }, (_, index) => ({
    ...taskExecutionSession,
    sessionId: `session-task-worker-${index}`,
  }));
  const component = createSparkSessionSelectorComponent({
    sessions: internalSessions,
    workspaces: [workspaces[0]!],
    suggestedWorkspaceId: "workspace-1",
    onSelect: () => undefined,
  });

  const rendered = component.render(96).join("\n");
  assert.doesNotMatch(rendered, /session-task-worker|role:builtin-executor/u);
  assert.match(rendered, /\+ New session/u);
});

test("Spark session selector switches workspace groups horizontally", () => {
  const selected: SparkSessionSelectorSelection[] = [];
  const component = createSparkSessionSelectorComponent({
    sessions: [
      ...sessions,
      archivedSession,
      channelBindingSession,
      channelTitleSession,
      otherWorkspaceSession,
      legacyWorkspaceSession,
      daemonSession,
    ],
    workspaces,
    suggestedWorkspaceId: "workspace-1",
    maxVisible: 20,
    onSelect: (value) => selected.push(value),
  });

  let lines = component.render(120);
  assert.equal(
    lines.some((line) => line.includes("[spark (4)]")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("spore (1)")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Daemon conversation")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Legacy workspace")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Archived conversation")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("Ops room")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("feishu")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Other workspace")),
    false,
  );

  component.handleInput?.("\u001b[C");
  lines = component.render(120);
  assert.equal(
    lines.some((line) => line.includes("[spore (1)]")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Other workspace")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    false,
  );

  component.handleInput?.("\u001b[C");
  lines = component.render(120);
  assert.equal(
    lines.some((line) => line.includes("[spark (4)]")),
    true,
  );
  assert.equal(
    lines.some((line) => line.includes("Archived conversation")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("Recent conversation")),
    true,
  );
  assert.deepEqual(selected, []);
});

test("isSelectableSparkSession admits active workspace sessions only", () => {
  assert.equal(isSelectableSparkSession(sessions[0]!), true);
  assert.equal(isSelectableSparkSession(archivedSession), false);
  assert.equal(isSelectableSparkSession(channelBindingSession), true);
  assert.equal(isSelectableSparkSession(channelTitleSession), true);
  assert.equal(isSelectableSparkSession(daemonSession), false);
});

test("Spark session list text uses the same workspace groups as the selector", () => {
  const text = formatSparkSessionListByWorkspace({
    sessions: [...sessions, channelBindingSession, otherWorkspaceSession, daemonSession],
    workspaces,
    suggestedWorkspaceId: "workspace-1",
  });

  assert.match(text, /^Spark workspace sessions:/u);
  assert.match(text, /^spark \(2\)$/mu);
  assert.match(text, /^spore \(1\)$/mu);
  assert.doesNotMatch(text, /\/workspace\/(?:spark|other)/u);
  assert.doesNotMatch(text, /Daemon conversation/u);
  assert.match(text, /Ops room • session-channel-bound • feishu • lifecycle=open • activity=idle/u);
});

test("Spark session selector custom UI returns an existing workspace session", async () => {
  let overlayEnabled = false;
  let rendered = false;
  const selected = {
    kind: "session" as const,
    sessionId: "session-recent",
    workspaceId: "workspace-1",
  };
  const customUi: SparkModelSelectorCustomUi = {
    custom<T>(
      factory: (
        tui: SparkModelSelectorTuiLike,
        theme: SparkModelSelectorTheme,
        keybindings: unknown,
        done: (value: T) => void,
      ) => Component,
      options?: unknown,
    ): T {
      overlayEnabled =
        typeof options === "object" &&
        options !== null &&
        (options as { overlay?: unknown }).overlay === true;
      const component = factory(
        { requestRender: () => undefined },
        {},
        undefined,
        (_value: T) => undefined,
      );
      rendered = component.render(96).some((line) => line.includes("Recent conversation"));
      return selected as T;
    },
  };

  const selection = await selectSparkSessionFromCustomUi(customUi, {
    sessions,
    workspaces,
    suggestedWorkspaceId: "workspace-1",
  });
  assert.equal(rendered, true);
  assert.equal(overlayEnabled, true);
  assert.deepEqual(selection, selected);
});

const hierarchySessions: SparkSessionProjection[] = [
  sessionRecord("parent-alpha", "Parent Alpha", "2026-07-20T05:00:00.000Z"),
  sideThreadRecord("alpha-context", "Context research", "parent-alpha", 1, "contextual"),
  sideThreadRecord("alpha-tangent", "Tangent spike", "parent-alpha", 2, "tangent"),
  sessionRecord("parent-beta", "Parent Beta", "2026-07-20T04:00:00.000Z"),
  sideThreadRecord("beta-context", "Verification thread", "parent-beta", 1, "contextual"),
  {
    ...sideThreadRecord("alpha-archived", "Archived thread", "parent-alpha", 3, "tangent"),
    placement: "archived",
  },
];

test("Spark session selector renders parent and Side Thread hierarchy snapshot", async () => {
  const component = createSparkSessionSelectorComponent({
    sessions: hierarchySessions,
    workspaces: [workspaces[0]!],
    suggestedWorkspaceId: "workspace-1",
    maxVisible: 20,
    onSelect: () => undefined,
  });
  const rendered = `${component.render(180).join("\n")}\n`;
  await expect(rendered).toMatchFileSnapshot(
    join(import.meta.dirname, "snapshots", "spark-session-selector-hierarchy.md"),
  );
  assert.match(rendered, /\[spark \(5\)\]/u);
  assert.match(
    rendered,
    /└─ Context research.*parent=parent-alpha.*mode=contextual.*generation=1.*lifecycle=open.*activity=idle/u,
  );
  assert.ok(rendered.indexOf("Parent Alpha") < rendered.indexOf("Context research"));
  assert.ok(rendered.indexOf("Context research") < rendered.indexOf("Tangent spike"));
  assert.ok(rendered.indexOf("Parent Beta") < rendered.indexOf("Verification thread"));
});

test("Spark session selector Show archived toggles 5 to 6 to 5 without breaking hierarchy", () => {
  const component = createSparkSessionSelectorComponent({
    sessions: hierarchySessions,
    workspaces: [workspaces[0]!],
    suggestedWorkspaceId: "workspace-1",
    maxVisible: 20,
    onSelect: () => undefined,
  });

  let rendered = component.render(180).join("\n");
  assert.match(rendered, /\[spark \(5\)\]/u);
  assert.match(rendered, /Show archived \(1\)/u);
  assert.doesNotMatch(rendered, /Archived thread/u);

  component.handleInput?.("a");
  rendered = component.render(180).join("\n");
  assert.match(rendered, /\[spark \(6\)\]/u);
  assert.match(rendered, /Archived thread \[archived\]/u);
  assert.match(rendered, /lifecycle=open.*activity=idle/u);
  assert.ok(rendered.indexOf("Tangent spike") < rendered.indexOf("Archived thread"));
  assert.ok(rendered.indexOf("Archived thread") < rendered.indexOf("Parent Beta"));

  component.handleInput?.("a");
  rendered = component.render(180).join("\n");
  assert.match(rendered, /\[spark \(5\)\]/u);
  assert.doesNotMatch(rendered, /Archived thread/u);
});

test("Spark session selector isolates orphan Side Threads in a diagnostic group", () => {
  const orphan = sideThreadRecord(
    "orphan-thread",
    "Orphan thread",
    "missing-parent",
    1,
    "contextual",
  );
  const component = createSparkSessionSelectorComponent({
    sessions: [...hierarchySessions, orphan],
    workspaces: [workspaces[0]!],
    suggestedWorkspaceId: "workspace-1",
    maxVisible: 20,
    onSelect: () => undefined,
  });
  let rendered = component.render(180).join("\n");
  assert.match(rendered, /Orphans \(1\)/u);
  component.handleInput?.("\u001b[C");
  rendered = component.render(180).join("\n");
  assert.match(rendered, /\[Orphans \(1\)\]/u);
  assert.match(rendered, /orphan=missing-parent/u);
});

function sessionRecord(
  sessionId: string,
  name: string | undefined,
  updatedAt: string,
): SparkSessionProjection {
  return {
    sessionId,
    ...(name ? { name } : {}),
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    lifecycle: "open",
    placement: "active",
    activity: "idle",
    roleBinding: { kind: "none" },
    incarnation: 1,
    owner: { kind: "session", supervisorSessionId: "administrator:workspace-1" },
    stateBinding: { kind: "session", ref: "administrator:workspace-1" },
    visibility: "public",
    retention: "retain",
    purpose: "interactive",
    lifetime: "scoped",
    bindings: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt,
  };
}

function sideThreadRecord(
  sessionId: string,
  title: string,
  parentSessionId: string,
  generation: number,
  mode: "contextual" | "tangent",
): SparkSessionProjection {
  return {
    ...sessionRecord(sessionId, title, `2026-07-20T0${generation}:00:00.000Z`),
    roleBinding: { kind: "inherit" },
    owner: { kind: "side_thread", parentSessionId, generation },
    sideThreadMode: mode,
  };
}
