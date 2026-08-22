import { render } from "vitest-browser-svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  webRpc: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: mocks.goto }));
vi.mock("$lib/live-events", () => ({ attachWebSessionEvents: () => () => undefined }));
vi.mock("$lib/web-rpc", () => ({ webRpc: mocks.webRpc }));

import SessionPage from "./+page.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function sessionData(sessionId: string) {
  const updatedAt = "2026-08-22T00:00:00.000Z";
  return {
    window: {
      snapshot: {
        sessionId,
        status: "idle",
        updatedAt,
        pendingTurns: [],
        messages: [],
        tools: [],
        runs: [],
        tasks: [],
        artifacts: [
          {
            ref: `artifact:${sessionId}`,
            title: `Artifact ${sessionId}`,
            kind: "document",
            format: "text",
            metadata: {},
          },
        ],
        evidence: [],
        metadata: {},
      },
      history: {
        totalMessages: 0,
        loadedMessages: 0,
        hiddenMessages: 0,
        earlierMessages: 0,
        laterMessages: 0,
        hasEarlierMessages: false,
      },
    },
    catalog: { providers: [] },
    sessions: [
      {
        sessionId,
        name: `Session ${sessionId}`,
        lifecycle: "open",
        placement: "active",
        activity: "idle",
        scope: { kind: "workspace", workspaceId: `workspace-${sessionId}` },
        lineage: { kind: "root" },
      },
    ],
  } as never;
}

afterEach(() => {
  mocks.goto.mockReset();
  mocks.webRpc.mockReset();
  vi.restoreAllMocks();
});

describe("Session page owner state", () => {
  it("drops an Artifact response from the previous Session", async () => {
    mocks.webRpc.mockResolvedValue({ waits: [] });
    const response = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const screen = await render(SessionPage, { data: sessionData("a") });

    await screen.getByRole("tab", { name: "Details" }).click();
    await screen.getByRole("button", { name: "Open" }).click();
    await screen.rerender({ data: sessionData("b") });
    response.resolve(new Response("private Session A content"));

    await expect.element(screen.getByRole("link", { name: /Session b/ })).toBeVisible();
    expect(screen.container.textContent).not.toContain("private Session A content");
    expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
    await screen.unmount();
  });

  it("drops an Artifact failure from the previous Session", async () => {
    mocks.webRpc.mockResolvedValue({ waits: [] });
    const response = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const screen = await render(SessionPage, { data: sessionData("a") });

    await screen.getByRole("tab", { name: "Details" }).click();
    await screen.getByRole("button", { name: "Open" }).click();
    await screen.rerender({ data: sessionData("b") });
    response.reject(new Error("private Session A failure"));

    await expect.element(screen.getByRole("link", { name: /Session b/ })).toBeVisible();
    expect(screen.container.textContent).not.toContain("private Session A failure");
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    await screen.unmount();
  });
});
