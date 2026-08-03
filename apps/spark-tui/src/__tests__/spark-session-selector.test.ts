import assert from "node:assert/strict";
import { join } from "node:path";
import { expect, test } from "vitest";

import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { visibleWidth } from "@zendev-lab/spark-tui/text";
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

const sessions: SparkSessionRegistryRecord[] = [
  {
    sessionId: "session-recent",
    title: "Recent conversation",
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    workspaceId: "workspace-1",
    status: "ready",
    model: { providerName: "openai", modelId: "gpt-5" },
    thinkingLevel: "high",
    bindings: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
  },
];

const untitledSession: SparkSessionRegistryRecord = {
  sessionId: "session-untitled",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T02:00:00.000Z",
};

const archivedSession: SparkSessionRegistryRecord = {
  sessionId: "session-archived",
  title: "Archived conversation",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "archived",
  bindings: [],
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T01:00:00.000Z",
};

const channelBindingSession: SparkSessionRegistryRecord = {
  sessionId: "session-channel-bound",
  title: "Ops room",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "ready",
  bindings: [{ kind: "channel", adapter: "feishu", externalKey: "feishu:chat:oc_ops" }],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T02:00:00.000Z",
};

const channelTitleSession: SparkSessionRegistryRecord = {
  sessionId: "session-channel-title",
  title: "channel qqbot:c2c:398418FB5E7F1C597DFFD117597D6500",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T02:00:00.000Z",
};

const otherWorkspaceSession: SparkSessionRegistryRecord = {
  sessionId: "session-other-workspace",
  title: "Other workspace",
  scope: { kind: "workspace", workspaceId: "workspace-2" },
  workspaceId: "workspace-2",
  cwd: "/workspace/other",
  status: "running",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T03:00:00.000Z",
};

const legacyWorkspaceSession: SparkSessionRegistryRecord = {
  sessionId: "session-legacy-workspace",
  title: "Legacy workspace",
  scope: { kind: "workspace", workspaceId: "spark" },
  workspaceId: "spark",
  cwd: "/workspace/spark",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T03:30:00.000Z",
};

const daemonSession: SparkSessionRegistryRecord = {
  sessionId: "session-daemon",
  title: "Daemon conversation",
  scope: { kind: "daemon", daemonId: "daemon-1" },
  cwd: "/daemon",
  status: "ready",
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

test("Spark session selector uses the Cockpit fallback for untitled sessions", () => {
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

test("Spark session selector humanizes user-facing roles and hides task execution sessions", () => {
  const roleSession = {
    ...sessionRecord("technical-role", "role:builtin-worker", "2026-07-20T06:00:00.000Z"),
    role: "role:builtin-worker",
  };
  const taskExecution = {
    ...sessionRecord("task-execution", "role:builtin-worker", "2026-07-20T07:00:00.000Z"),
    role: "role:builtin-worker",
    relation: {
      kind: "task_execution" as const,
      ownerSessionId: "owner-session",
      projectRef: "proj:session-performance",
      taskRef: "task:session-performance",
      runRef: "run:session-performance",
      sessionGoalId: "goal-session-performance",
      roleRef: "role:builtin-worker",
      jobId: "job-session-performance",
      attempt: 1,
    },
  };
  const component = createSparkSessionSelectorComponent({
    sessions: [roleSession, taskExecution],
    workspaces: [workspaces[0]!],
    suggestedWorkspaceId: "workspace-1",
    maxVisible: 10,
    onSelect: () => undefined,
  });

  const rendered = component.render(160).join("\n");
  assert.match(rendered, /Worker session/u);
  assert.doesNotMatch(rendered, /Task execution/u);
  assert.doesNotMatch(rendered, /task-execution/u);
  assert.doesNotMatch(rendered, /role:builtin-worker/u);
  assert.equal(isSelectableSparkSession(taskExecution), false);
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
  assert.match(text, /spark • \/workspace\/spark \(2\)/u);
  assert.match(text, /spore • \/workspace\/other \(1\)/u);
  assert.doesNotMatch(text, /Daemon conversation/u);
  assert.match(text, /Ops room • status=ready • session-channel-bound • feishu/u);
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

const hierarchySessions: SparkSessionRegistryRecord[] = [
  sessionRecord("parent-alpha", "Parent Alpha", "2026-07-20T05:00:00.000Z"),
  sideThreadRecord("alpha-context", "Context research", "parent-alpha", 1, "contextual"),
  sideThreadRecord("alpha-tangent", "Tangent spike", "parent-alpha", 2, "tangent"),
  sessionRecord("parent-beta", "Parent Beta", "2026-07-20T04:00:00.000Z"),
  sideThreadRecord("beta-context", "Verification thread", "parent-beta", 1, "contextual"),
  {
    ...sideThreadRecord("alpha-archived", "Archived thread", "parent-alpha", 3, "tangent"),
    status: "archived",
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
    /└─ Context research.*parent=parent-alpha.*mode=contextual.*generation=1.*status=ready/u,
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
  assert.match(rendered, /status=archived/u);
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
  title: string,
  updatedAt: string,
): SparkSessionRegistryRecord {
  return {
    sessionId,
    title,
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    workspaceId: "workspace-1",
    status: "ready",
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
): SparkSessionRegistryRecord {
  return {
    ...sessionRecord(sessionId, title, `2026-07-20T0${generation}:00:00.000Z`),
    relation: { kind: "side_thread", parentSessionId, generation, mode },
  };
}
