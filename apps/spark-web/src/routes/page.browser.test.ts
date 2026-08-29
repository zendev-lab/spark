import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
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

describe("Spark Web conversation-first routes", () => {
  it("creates a durable Session from the first chat message", async () => {
    mocks.webRpc.mockImplementation(async (method: string) => {
      if (method === "session.create") return { sessionId: "session-created" };
      if (method === "turn.submit") return { invocationId: "inv-created" };
      throw new Error(`unexpected RPC ${method}`);
    });
    const screen = await render(DashboardPage, { data: dashboardData() });

    await expect
      .element(screen.getByRole("heading", { name: "What should we work on?" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: /Child session/ }))
      .toHaveAttribute("href", "/sessions/session-child");
    await expect.element(screen.getByText("Local daemon")).not.toBeInTheDocument();
    await screen.getByRole("textbox", { name: "First message" }).fill("Prepare the release notes");
    await screen.getByRole("button", { name: "Start conversation" }).click();

    await expect
      .poll(() => mocks.webRpc)
      .toHaveBeenCalledWith(
        "session.create",
        expect.objectContaining({
          scope: { kind: "workspace", workspaceId: "ws-a" },
          supervisorSessionId: "session-root",
          name: "Prepare the release notes",
        }),
      );
    await expect
      .poll(() => mocks.webRpc)
      .toHaveBeenCalledWith(
        "turn.submit",
        expect.objectContaining({
          sessionId: "session-created",
          prompt: "Prepare the release notes",
        }),
      );
    await expect.poll(() => mocks.goto).toHaveBeenCalledWith("/sessions/session-created");
    await screen.unmount();
  });

  it("keeps execution topology out of the Chinese conversation surface", async () => {
    const data = dashboardData();
    data.locale = "zh-CN";
    data.messages = getDictionary("zh-CN");
    const screen = await render(DashboardPage, { data });

    await expect
      .element(screen.getByRole("heading", { name: "想和 Spark 一起做什么？" }))
      .toBeVisible();
    await expect.element(screen.getByText("本机 daemon")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("keeps the Chinese conversation path inside a mobile viewport", async () => {
    await page.viewport(390, 844);
    const data = dashboardData();
    data.locale = "zh-CN";
    data.messages = getDictionary("zh-CN");
    const screen = await render(DashboardPage, { data });

    try {
      const home = screen.container.querySelector<HTMLElement>(".conversation-home");
      expect(home).not.toBeNull();
      expect(home?.scrollWidth).toBeLessThanOrEqual(home?.clientWidth ?? 0);
      await expect.element(screen.getByRole("textbox", { name: "第一条消息" })).toBeVisible();
      await expect.element(screen.getByRole("link", { name: "全部对话" })).toBeVisible();
    } finally {
      await screen.unmount();
      await page.viewport(1280, 720);
    }
  });

  it("keeps a created conversation recoverable when the first message fails", async () => {
    mocks.webRpc.mockImplementation(async (method: string) => {
      if (method === "session.create") return { sessionId: "session-created" };
      if (method === "turn.submit") throw new Error("submission rejected");
      throw new Error(`unexpected RPC ${method}`);
    });
    const screen = await render(DashboardPage, { data: dashboardData() });

    await screen.getByRole("textbox", { name: "First message" }).fill("Investigate the failure");
    await screen.getByRole("button", { name: "Start conversation" }).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "The conversation was created, but the first message was not accepted: submission rejected",
      );
    await expect
      .element(screen.getByRole("link", { name: "Open the created conversation" }))
      .toHaveAttribute("href", "/sessions/session-created");
    expect(mocks.webRpc.mock.calls.filter(([method]) => method === "session.create")).toHaveLength(
      1,
    );
    expect(mocks.goto).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("renders one Invocation independently from its Session transcript", async () => {
    const screen = await render(InvocationPage, { data: invocationData() });

    await expect.element(screen.getByRole("heading", { name: "Run details" })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "session-child" }))
      .toHaveAttribute("href", "/sessions/session-child");
    await expect.element(screen.getByText("inv_Active1")).not.toBeVisible();
    await expect.element(screen.getByText("model.started", { exact: false })).not.toBeVisible();
    await screen.getByText("Technical details", { exact: true }).click();
    await expect.element(screen.getByText("inv_Active1")).toBeVisible();
    await screen.getByText("Technical events", { exact: false }).click();
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
        roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
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
