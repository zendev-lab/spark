import { render } from "vitest-browser-svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "svelte";

const mocks = vi.hoisted(() => ({
  attachWebSessionEvents: vi.fn(() => () => undefined),
  goto: vi.fn(),
  webRpc: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: mocks.goto }));
vi.mock("$lib/live-events", () => ({
  attachWebSessionEvents: mocks.attachWebSessionEvents,
}));
vi.mock("$lib/web-rpc", () => ({ webRpc: mocks.webRpc }));

import { getDictionary } from "$lib/i18n";
import SessionPage from "./+page.svelte";

type SessionPageData = ComponentProps<typeof SessionPage>["data"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function sessionData(sessionId: string, requestedMessageId: string | null = null): SessionPageData {
  const updatedAt = "2026-08-22T00:00:00.000Z";
  return {
    messages: getDictionary("en"),
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
    requestedMessageId,
  } as unknown as SessionPageData;
}

function sessionDataWithEarlierHistory(sessionId: string, requestedMessageId: string) {
  const data = sessionData(sessionId, requestedMessageId);
  data.window.snapshot.messages = [
    {
      version: 4,
      id: "latest",
      role: "assistant",
      text: "latest message",
      status: "done",
      metadata: {},
    },
  ];
  data.window.history = {
    totalMessages: 3,
    loadedMessages: 1,
    hiddenMessages: 2,
    earlierMessages: 2,
    laterMessages: 0,
    hasEarlierMessages: true,
    nextBeforeMessageId: "latest",
  };
  return data;
}

function sessionDataWithMemoryRef(sessionId: string) {
  const data = sessionData(sessionId);
  data.window.snapshot.messages = [
    {
      version: 4,
      id: `memory-${sessionId}`,
      role: "assistant",
      text: "Use memory:shared",
      status: "done",
      metadata: {},
    },
  ];
  data.window.history.loadedMessages = 1;
  data.window.history.totalMessages = 1;
  return data;
}

function sessionDataWithModels(sessionId: string) {
  const data = sessionData(sessionId);
  data.window.snapshot.model = {
    providerName: "provider",
    modelId: "owner",
    modelLabel: "Owner",
  };
  data.catalog = {
    diagnostics: [],
    providers: [
      {
        providerName: "provider",
        label: "Provider",
        auth: { providerName: "provider", kind: "none", configured: true },
        models: [
          {
            model: { providerName: "provider", modelId: "owner", modelLabel: "Owner" },
            reasoning: false,
            input: ["text"],
            available: true,
          },
          {
            model: {
              providerName: "provider",
              modelId: "candidate",
              modelLabel: "Candidate",
            },
            reasoning: false,
            input: ["text"],
            available: true,
          },
        ],
      },
    ],
  };
  return data;
}

function earlierPage(sessionId: string, messageId: string, text: string) {
  const page = sessionData(sessionId);
  page.window.snapshot.messages = [
    {
      version: 4,
      id: messageId,
      role: "assistant",
      text,
      status: "done",
      metadata: {},
    },
  ];
  page.window.history = {
    totalMessages: 3,
    loadedMessages: 1,
    hiddenMessages: 1,
    earlierMessages: 1,
    laterMessages: 1,
    hasEarlierMessages: true,
    nextBeforeMessageId: messageId,
  };
  return page.window;
}

afterEach(() => {
  mocks.attachWebSessionEvents.mockClear();
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

  it("keeps concurrent file reads within the attachment count boundary", async () => {
    mocks.webRpc.mockResolvedValue({ waits: [] });
    const firstRead = deferred<ArrayBuffer>();
    const secondRead = deferred<ArrayBuffer>();
    const screen = await render(SessionPage, { data: sessionData("a") });
    const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;

    const selectFiles = (files: File[]) => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const file = (name: string, read?: Promise<ArrayBuffer>) => {
      const selected = new File(["x"], name, { type: "text/plain" });
      if (read) Object.defineProperty(selected, "arrayBuffer", { value: () => read });
      return selected;
    };

    selectFiles([
      file("a-1.txt", firstRead.promise),
      file("a-2.txt"),
      file("a-3.txt"),
      file("a-4.txt"),
      file("a-5.txt"),
    ]);
    selectFiles([
      file("b-1.txt", secondRead.promise),
      file("b-2.txt"),
      file("b-3.txt"),
      file("b-4.txt"),
    ]);

    firstRead.resolve(Uint8Array.of(1).buffer);
    await expect.element(screen.getByText(/a-5\.txt/u)).toBeVisible();
    secondRead.resolve(Uint8Array.of(1).buffer);
    await expect.element(screen.getByRole("alert")).toHaveTextContent("at most 8 attachments");
    expect(screen.container.textContent).not.toContain("b-1.txt");
    await screen.unmount();
  });

  it("uses the latest same-Session message query when pages resolve out of order", async () => {
    const firstPage = deferred<ReturnType<typeof earlierPage>>();
    const secondPage = deferred<ReturnType<typeof earlierPage>>();
    let snapshotRequests = 0;
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "session.snapshot-page") {
        snapshotRequests += 1;
        return snapshotRequests === 1 ? firstPage.promise : secondPage.promise;
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, {
      data: sessionDataWithEarlierHistory("a", "message-a"),
    });
    await expect.poll(() => snapshotRequests).toBe(1);
    await screen.getByRole("textbox", { name: "Prompt" }).fill("preserve this draft");
    const attachmentInput = screen.container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "keep.txt", { type: "text/plain" }));
    attachmentInput.files = transfer.files;
    attachmentInput.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(screen.getByText(/keep\.txt/u)).toBeVisible();

    await screen.rerender({ data: sessionDataWithEarlierHistory("a", "message-b") });
    await expect.poll(() => snapshotRequests).toBe(2);
    secondPage.resolve(earlierPage("a", "message-b", "newer query result"));
    await expect.element(screen.getByText("newer query result")).toBeVisible();
    firstPage.resolve(earlierPage("a", "message-a", "stale query result"));
    await expect.element(screen.getByText("newer query result")).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Prompt" }))
      .toHaveValue("preserve this draft");
    await expect.element(screen.getByText(/keep\.txt/u)).toBeVisible();
    expect(mocks.attachWebSessionEvents).toHaveBeenCalledTimes(1);
    expect(screen.container.textContent).not.toContain("stale query result");
    await screen.unmount();
  });

  it("does not let an old feedback request overwrite a newer request after A to B to A", async () => {
    const previousResponse = deferred<{ invocationId: string }>();
    const currentResponse = deferred<{ invocationId: string }>();
    let feedbackSubmits = 0;
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "turn.submit") {
        feedbackSubmits += 1;
        return feedbackSubmits === 1 ? previousResponse.promise : currentResponse.promise;
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, { data: sessionDataWithMemoryRef("a") });
    const helpfulButton = () =>
      screen.getByRole("button", {
        name: "Mark memory reference helpful: memory:shared",
      });

    await helpfulButton().click();
    await screen.rerender({ data: sessionDataWithMemoryRef("b") });
    await screen.rerender({ data: sessionDataWithMemoryRef("a") });
    await helpfulButton().click();
    await expect.poll(() => feedbackSubmits).toBe(2);
    await expect.element(helpfulButton()).toBeDisabled();

    previousResponse.resolve({ invocationId: "stale-a-feedback" });

    await expect.element(helpfulButton()).toBeDisabled();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Sending memory feedback…");

    currentResponse.resolve({ invocationId: "current-a-feedback" });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Memory feedback submitted as a visible Session turn.");
    await expect.element(helpfulButton()).toBeEnabled();
    await screen.unmount();
  });

  it("applies the enabled Plan action to its owning Session", async () => {
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "session.mode.set") {
        return Promise.resolve({ sessionId: "a", mode: "plan" });
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, { data: sessionData("a") });

    await screen.getByRole("textbox", { name: "Prompt" }).fill("/plan");
    const enterPlan = screen.getByRole("button", { name: "Enter Plan" });
    await expect.element(enterPlan).toBeEnabled();
    await enterPlan.click();

    await expect
      .poll(() =>
        mocks.webRpc.mock.calls.some(
          ([method, input]) =>
            method === "session.mode.set" && input.sessionId === "a" && input.mode === "plan",
        ),
      )
      .toBe(true);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Session mode set to plan.");
    await screen.unmount();
  });

  it("does not let an old mode response overwrite a newer A to B to A request", async () => {
    const previousResponse = deferred<{ sessionId: string; mode: "plan" }>();
    const currentResponse = deferred<{ sessionId: string; mode: "fleet" }>();
    let modeSubmits = 0;
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "session.mode.set") {
        modeSubmits += 1;
        return modeSubmits === 1 ? previousResponse.promise : currentResponse.promise;
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, { data: sessionData("a") });

    await screen.getByRole("textbox", { name: "Prompt" }).fill("/plan");
    await screen.getByRole("button", { name: "Enter Plan" }).click();
    await screen.rerender({ data: sessionData("b") });
    await screen.rerender({ data: sessionData("a") });
    await screen.getByRole("textbox", { name: "Prompt" }).fill("/fleet");
    await screen.getByRole("button", { name: "Enter Fleet" }).click();
    await expect.poll(() => modeSubmits).toBe(2);

    currentResponse.resolve({ sessionId: "a", mode: "fleet" });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Session mode set to fleet.");
    previousResponse.reject(new Error("stale Plan failure"));

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Session mode set to fleet.");
    expect(screen.container.textContent).not.toContain("stale Plan failure");
    await screen.unmount();
  });

  it("does not let an old mode response overwrite a newer status action", async () => {
    const modeResponse = deferred<{ sessionId: string; mode: "plan" }>();
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "session.mode.set") return modeResponse.promise;
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, { data: sessionData("a") });

    await screen.getByRole("textbox", { name: "Prompt" }).fill("/plan");
    await screen.getByRole("button", { name: "Enter Plan" }).click();
    await screen.getByRole("textbox", { name: "Prompt" }).fill("/status");
    await screen.getByRole("button", { name: "Refresh status" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Session status: idle.");

    modeResponse.reject(new Error("stale Plan failure"));

    await expect.element(screen.getByRole("status")).toHaveTextContent("Session status: idle.");
    expect(screen.container.textContent).not.toContain("stale Plan failure");
    await screen.unmount();
  });

  it("does not let an old mode response overwrite a newer compaction", async () => {
    const modeResponse = deferred<{ sessionId: string; mode: "plan" }>();
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "session.mode.set") return modeResponse.promise;
      if (method === "session.compact") {
        return Promise.resolve({ invocationId: "compact-current" });
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, { data: sessionData("a") });

    await screen.getByRole("textbox", { name: "Prompt" }).fill("/plan");
    await screen.getByRole("button", { name: "Enter Plan" }).click();
    await screen.getByRole("textbox", { name: "Prompt" }).fill("/compact");
    await screen.getByRole("button", { name: "Send" }).click();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Compaction queued as compact-current.");

    modeResponse.reject(new Error("stale Plan failure"));

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Compaction queued as compact-current.");
    expect(screen.container.textContent).not.toContain("stale Plan failure");
    await screen.unmount();
  });

  it("does not let an old mode response overwrite a newer control failure", async () => {
    const modeResponse = deferred<{ sessionId: string; mode: "plan" }>();
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "session.mode.set") return modeResponse.promise;
      if (method === "session.retry-target") {
        return Promise.reject(new Error("current retry failure"));
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, { data: sessionData("a") });

    await screen.getByRole("textbox", { name: "Prompt" }).fill("/plan");
    await screen.getByRole("button", { name: "Enter Plan" }).click();
    await screen.getByRole("button", { name: "Retry" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("current retry failure");

    modeResponse.resolve({ sessionId: "a", mode: "plan" });

    await expect.element(screen.getByRole("alert")).toHaveTextContent("current retry failure");
    expect(screen.container.textContent).not.toContain("Session mode set to plan.");
    await screen.unmount();
  });

  it("keeps a newer model failure and restores the owner selection", async () => {
    const modeResponse = deferred<{ sessionId: string; mode: "plan" }>();
    const modelResponse = deferred<unknown>();
    mocks.webRpc.mockImplementation((method: string) => {
      if (method === "human.interaction.list") return Promise.resolve({ waits: [] });
      if (method === "session.mode.set") return modeResponse.promise;
      if (method === "session.model.set") return modelResponse.promise;
      throw new Error(`Unexpected RPC method: ${method}`);
    });
    const screen = await render(SessionPage, { data: sessionDataWithModels("a") });

    await screen.getByRole("textbox", { name: "Prompt" }).fill("/plan");
    await screen.getByRole("button", { name: "Enter Plan" }).click();
    await screen.getByRole("button", { name: "Model", exact: true }).click();
    await screen.getByText("Candidate", { exact: true }).click();
    modelResponse.reject(new Error("current model failure"));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("current model failure");
    await expect
      .element(screen.getByRole("button", { name: "Model", exact: true }))
      .toHaveAttribute("title", "Owner");

    modeResponse.resolve({ sessionId: "a", mode: "plan" });

    await expect.element(screen.getByRole("alert")).toHaveTextContent("current model failure");
    expect(screen.container.textContent).not.toContain("Session mode set to plan.");
    await screen.unmount();
  });
});
