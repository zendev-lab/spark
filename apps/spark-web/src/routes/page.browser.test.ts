import { render } from "vitest-browser-svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "svelte";

const mocks = vi.hoisted(() => ({ goto: vi.fn(), webRpc: vi.fn() }));

vi.mock("$app/navigation", () => ({ goto: mocks.goto }));
vi.mock("$lib/web-rpc", () => ({ webRpc: mocks.webRpc }));

import { getDictionary } from "$lib/i18n";
import DashboardPage from "./+page.svelte";
import InvocationPage from "./invocations/[invocationId]/+page.svelte";

type DashboardData = ComponentProps<typeof DashboardPage>["data"];
type InvocationData = ComponentProps<typeof InvocationPage>["data"];

afterEach(() => {
  mocks.goto.mockReset();
  mocks.webRpc.mockReset();
});

describe("Spark Web daemon-first routes", () => {
  it("renders Session, Invocation, wait, and Artifact projections on the home page", async () => {
    const screen = await render(DashboardPage, { data: dashboardData() });

    await expect
      .element(screen.getByRole("heading", { name: "Sessions and Invocations" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Child session", exact: true }))
      .toHaveAttribute("href", "/sessions/session-child");
    await expect
      .element(screen.getByRole("link", { name: /inv_Active1/ }))
      .toHaveAttribute("href", "/invocations/inv_Active1");
    await expect.element(screen.getByText("Choose a release target")).toBeVisible();
    await expect.element(screen.getByText("Release notes")).toBeVisible();
    await screen.unmount();
  });

  it("renders one Invocation independently from its Session transcript", async () => {
    const screen = await render(InvocationPage, { data: invocationData() });

    await expect.element(screen.getByRole("heading", { name: "inv_Active1" })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "session-child" }))
      .toHaveAttribute("href", "/sessions/session-child");
    await expect.element(screen.getByText("model.started", { exact: false })).toBeVisible();
    await screen.unmount();
  });
});

function dashboardData(): DashboardData {
  return {
    locale: "en",
    messages: getDictionary("en"),
    launchCwd: "/repo",
    cwdWorkspaceId: "ws-a",
    observedAt: "2026-08-23T00:00:03.000Z",
    invocationTotal: 1,
    artifactTotal: 1,
    artifactUnavailableWorkspaceIds: [],
    workspaces: [{ id: "ws-a", displayName: "Repository A", localPath: "/repo" }],
    sessions: [
      {
        sessionId: "session-root",
        name: "Administrator",
        lifecycle: "open",
        placement: "active",
        activity: "idle",
        lineage: { kind: "root" },
        scope: { kind: "workspace", workspaceId: "ws-a" },
      },
      {
        sessionId: "session-child",
        name: "Child session",
        lifecycle: "open",
        placement: "active",
        activity: "running",
        lineage: { kind: "child", parentSessionId: "session-root" },
        scope: { kind: "workspace", workspaceId: "ws-a" },
      },
    ],
    invocations: [
      {
        invocationId: "inv_Active1",
        sessionId: "session-child",
        status: "running",
        attemptCount: 1,
        retryable: false,
        eventCursor: 1,
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:01.000Z",
      },
    ],
    waits: [
      {
        humanRequestId: "wait-1",
        interactionRequestId: "interaction-1",
        sessionId: "session-child",
        invocationId: "inv_Active1",
        workspaceBindingId: "binding-a",
        workspaceId: "ws-a",
        projectId: "project-a",
        toolCallId: "tool-1",
        delivery: "blocking",
        mode: "decision",
        kind: "ask",
        title: "Release decision",
        prompt: "Choose a release target",
        questions: [],
        context: {},
        contextArtifactRefs: [],
        status: "pending",
        createdAt: "2026-08-23T00:00:01.000Z",
        updatedAt: "2026-08-23T00:00:02.000Z",
      },
    ],
    artifacts: [
      {
        workspaceId: "ws-a",
        ref: "artifact:release-notes",
        kind: "document",
        title: "Release notes",
        format: "markdown",
        mediaType: "text/markdown",
        sizeBytes: 42,
        hash: "a".repeat(64),
        createdAt: "2026-08-23T00:00:01.000Z",
        updatedAt: "2026-08-23T00:00:02.000Z",
      },
    ],
  } as unknown as DashboardData;
}

function invocationData(): InvocationData {
  return {
    locale: "en",
    messages: getDictionary("en"),
    view: {
      status: {
        invocationId: "inv_Active1",
        sessionId: "session-child",
        status: "running",
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:01.000Z",
        startedAt: "2026-08-23T00:00:01.000Z",
        eventCursor: 1,
      },
      result: { invocationId: "inv_Active1", status: "running" },
      events: [
        {
          invocationId: "inv_Active1",
          sequence: 1,
          kind: "model.started",
          payload: { model: "provider/model" },
          createdAt: "2026-08-23T00:00:01.000Z",
        },
      ],
      hasMoreEvents: false,
    },
  } as unknown as InvocationData;
}
