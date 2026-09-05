import { render } from "vitest-browser-svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  webRpc: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: mocks.goto }));
vi.mock("$lib/web-rpc", () => ({ webRpc: mocks.webRpc }));

import { getDictionary } from "$lib/i18n";
import WorkspacePage from "./+page.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function workspaceData(workspaceId: string) {
  return {
    messages: getDictionary("en"),
    workspace: {
      id: workspaceId,
      displayName: `Workspace ${workspaceId}`,
      localPath: `/workspaces/${workspaceId}`,
    },
    sessions: [
      {
        sessionId: `${workspaceId}-administrator`,
        scope: { kind: "workspace", workspaceId },
        lineage: { kind: "root" },
        roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
      },
    ],
    artifactCatalog: {
      total: 1,
      artifacts: [
        {
          ref: `artifact:${workspaceId}`,
          kind: "git_change",
          title: `Artifact ${workspaceId}`,
          format: "text",
          sizeBytes: 8,
        },
      ],
    },
    roleCatalog: {
      roles: [
        {
          ref: "role:builtin-executor",
          id: "executor",
          source: "builtin",
        },
      ],
    },
    roleModelSettings: { entries: [] },
    skillCatalog: { skills: [] },
    modelCatalog: { providers: [] },
  } as never;
}

afterEach(() => {
  mocks.goto.mockReset();
  mocks.webRpc.mockReset();
  vi.restoreAllMocks();
});

describe("Workspace page owner state", () => {
  it("keeps the current workspace busy when a previous Artifact request fails", async () => {
    const previousResponse = deferred<Response>();
    const currentResponse = deferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(previousResponse.promise)
      .mockReturnValueOnce(currentResponse.promise);
    const screen = await render(WorkspacePage, { data: workspaceData("a") });

    await screen.getByRole("button", { name: "Preview" }).click();
    await screen.rerender({ data: workspaceData("b") });
    await screen.getByRole("button", { name: "Preview" }).click();
    await expect.element(screen.getByRole("button", { name: "Preview" })).toBeDisabled();

    previousResponse.reject(new Error("private workspace A failure"));

    await expect.element(screen.getByRole("heading", { name: "Workspace b" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.container.textContent).not.toContain("private workspace A failure");

    currentResponse.resolve(new Response("workspace B content"));
    await expect.element(screen.getByText("workspace B content")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    await screen.unmount();
  });

  it("drops stale Role completion without clearing the current workspace request", async () => {
    const previousResponse = deferred<{
      created: boolean;
      role: { ref: string };
    }>();
    const currentResponse = deferred<{
      created: boolean;
      role: { ref: string };
    }>();
    mocks.webRpc
      .mockReturnValueOnce(previousResponse.promise)
      .mockReturnValueOnce(currentResponse.promise);
    const screen = await render(WorkspacePage, { data: workspaceData("a") });

    await screen.getByText("Create project Role").click();
    await screen.getByLabelText("Role id").fill("role-a");
    await screen.getByLabelText("Description").fill("Role A");
    await screen.getByLabelText("System prompt").fill("Act as role A.");
    await screen.getByRole("button", { name: "Create Role" }).click();

    await screen.rerender({ data: workspaceData("b") });
    await screen.getByLabelText("Role id").fill("role-b");
    await screen.getByLabelText("Description").fill("Role B");
    await screen.getByLabelText("System prompt").fill("Act as role B.");
    await screen.getByRole("button", { name: "Create Role" }).click();
    await expect.element(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();

    previousResponse.reject(new Error("private workspace A role failure"));

    await expect.element(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.container.textContent).not.toContain("private workspace A role failure");

    currentResponse.resolve({ created: true, role: { ref: "role:project/role-b" } });
    await expect.element(screen.getByRole("status")).toHaveTextContent("role:project/role-b");
    await expect.element(screen.getByRole("button", { name: "Create Role" })).toBeEnabled();
    await screen.unmount();
  });

  it("drops a previous workspace model response without clearing the current request", async () => {
    const previousResponse = deferred<{
      role: { id: string };
      setting: { model: string; source: "project" } | null;
    }>();
    const currentResponse = deferred<{
      role: { id: string };
      setting: { model: string; source: "project" } | null;
    }>();
    mocks.webRpc
      .mockReturnValueOnce(previousResponse.promise)
      .mockReturnValueOnce(currentResponse.promise);
    const screen = await render(WorkspacePage, { data: workspaceData("a") });

    await screen.getByRole("button", { name: "Inspect" }).click();
    await screen.rerender({ data: workspaceData("b") });
    await screen.getByRole("button", { name: "Inspect" }).click();
    await expect.element(screen.getByRole("button", { name: "Inspect" })).toBeDisabled();

    previousResponse.reject(new Error("private workspace A model failure"));

    await expect.element(screen.getByRole("button", { name: "Inspect" })).toBeDisabled();
    expect(screen.container.textContent).not.toContain("private workspace A model failure");

    currentResponse.resolve({
      role: { id: "executor" },
      setting: { model: "provider/model-b", source: "project" },
    });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("executor: provider/model-b · project");
    await expect.element(screen.getByRole("button", { name: "Inspect" })).toBeEnabled();
    await screen.unmount();
  });

  it("keeps a partially configured Session recoverable without creating a duplicate", async () => {
    mocks.webRpc.mockImplementation(async (method: string) => {
      if (method === "session.create") return { sessionId: "created-session" };
      if (method === "session.thinking.set") throw new Error("thinking policy rejected");
      throw new Error(`unexpected RPC ${method}`);
    });
    const screen = await render(WorkspacePage, { data: workspaceData("a") });

    await screen.getByRole("button", { name: "New session" }).click();
    await screen.getByRole("button", { name: "Create Session" }).click();

    await expect
      .element(screen.getByRole("link", { name: "Open created Session" }))
      .toHaveAttribute("href", "/sessions/created-session");
    await expect.element(screen.getByText(/was created, but its model or thinking/)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create Session" })).toBeDisabled();
    expect(mocks.webRpc.mock.calls.filter(([method]) => method === "session.create")).toHaveLength(
      1,
    );
    expect(mocks.goto).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("keeps a selected GitChange root with its relative Session directory", async () => {
    let createInput: Record<string, unknown> | undefined;
    mocks.webRpc.mockImplementation(async (method: string, input: Record<string, unknown>) => {
      if (method === "workspace.directory.list") {
        return {
          workspaceId: "a",
          rootRef: "directory-root:git-change",
          cwdArtifactRef: "artifact:a",
          current: { ref: "directory:nested", relativePath: "nested" },
          entries: [],
          truncated: false,
          observedAt: "2026-08-22T00:00:00.000Z",
        };
      }
      if (method === "session.create") {
        createInput = input;
        return { sessionId: "created-in-worktree" };
      }
      if (method === "session.thinking.set") throw new Error("stop after create");
      throw new Error(`unexpected RPC ${method}`);
    });
    const screen = await render(WorkspacePage, { data: workspaceData("a") });

    await screen.getByRole("button", { name: "New session" }).click();
    await screen.getByRole("button", { name: "Working directory" }).click();
    await screen.getByRole("option", { name: /Artifact a/ }).click();
    await screen.getByRole("button", { name: "Browse subdirectory" }).click();
    await screen.getByRole("button", { name: "Use this directory" }).click();
    await screen.getByRole("button", { name: "Create Session" }).click();

    expect(createInput).toMatchObject({ cwdArtifactRef: "artifact:a", cwd: "nested" });
    await screen.unmount();
  });

  it("surfaces the first directory read failure", async () => {
    mocks.webRpc.mockRejectedValue(new Error("directory owner unavailable"));
    const screen = await render(WorkspacePage, { data: workspaceData("a") });

    await screen.getByRole("button", { name: "New session" }).click();
    await screen.getByRole("button", { name: "Browse subdirectory" }).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("directory owner unavailable");
    await screen.unmount();
  });
});
