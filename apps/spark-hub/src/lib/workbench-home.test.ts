import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "svelte/server";
import { parse } from "svelte/compiler";
import { describe, expect, it, vi } from "vitest";
import WorkbenchHome from "../routes/(workbench)/+page.svelte";
import { getDictionary } from "./i18n";

const root = dirname(fileURLToPath(import.meta.url));
const workspace = {
  id: "ws_alpha",
  slug: "alpha",
  name: "Alpha Workspace",
  rootPath: "/workspace/alpha",
  runtimeStatus: "online",
  bindingStatus: "connected",
  bindingName: "Local runner",
  pendingInboxCount: 3,
  artifactCount: 7,
  updatedAt: "2026-07-30T00:00:00.000Z",
};

function home(workspaces: unknown[], form: unknown = {}) {
  return render(WorkbenchHome, {
    props: {
      data: { messages: getDictionary("en"), locale: "en", workspaces },
      form,
    } as never,
  });
}

describe("workbench home workspace directory", () => {
  it("renders a standalone workspace directory with setup and access actions", () => {
    const { body, head } = home([]);

    expect(body).toContain('data-testid="workspace-directory"');
    expect(body).toContain('href="/workspaces/new"');
    expect(body).toContain('href="/settings/access"');
    expect(body).not.toContain('href="/login"');
    expect(body).not.toContain("workspace-card");
    expect(head).toContain("<title>");
  });

  it("summarizes and links registered workspaces without redirecting the directory", () => {
    const { body } = home([workspace]);

    expect(body).toContain("Alpha Workspace");
    expect(body).toContain("Local runner");
    expect(body).toContain('href="/alpha/sessions"');
    expect(body).toContain('href="/alpha/settings/registration"');
    expect(body).toContain("3 pending");
    expect(body).toContain("7 artifacts");
    expect(body).toContain('aria-label="Remove Alpha Workspace"');
  });

  it("renders the remove result as an accessible status message", () => {
    const { body } = home([], {
      intent: "removeWorkspace",
      message: "Workspace alpha was removed.",
    });

    expect(body).toContain('role="status"');
    expect(body).toContain("Workspace alpha was removed.");
  });

  it("executes the directory load without redirecting when create is absent", async () => {
    vi.resetModules();
    const loadWorkbenchHome = vi.fn(() => ({ workspaces: [workspace] }));
    vi.doMock("@zendev-lab/spark-hub-coordination/hub-queries", () => ({
      loadWorkbenchHome,
    }));
    vi.doMock("$lib/server/db", () => ({ getDatabase: () => "db" }));
    const pageServer = await import("../routes/(workbench)/+page.server");
    const result = pageServer.load({
      locals: { workspaceId: null },
      url: new URL("http://localhost/"),
    } as never);

    expect(result).toEqual({ workspaces: [workspace] });
    expect(loadWorkbenchHome).toHaveBeenCalledWith("db", {
      forceWorkspaceCreate: false,
      pendingWorkspaceSetup: null,
      authorizedWorkspaceId: null,
    });
    vi.doUnmock("@zendev-lab/spark-hub-coordination/hub-queries");
    vi.doUnmock("$lib/server/db");
  });

  it("keeps the root layout in directory mode without workspace navigation or menu", () => {
    const path = resolve(root, "../routes/(workbench)/+layout.svelte");
    const ast = parse(readFileSync(path, "utf8"), { modern: true });
    const derived = new Map<string, string>();
    const componentAttributes = new Map<string, Map<string, string>>();
    walk(ast, (node) => {
      if (node.type === "VariableDeclarator") {
        const id = node.id as { name?: unknown } | undefined;
        const init = node.init as Record<string, unknown> | undefined;
        if (typeof id?.name === "string" && init?.type === "CallExpression") {
          derived.set(id.name, expressionText((init.arguments as Record<string, unknown>[])[0]));
        }
      }
      if (node.type === "Component" && typeof node.name === "string") {
        const attributes = new Map<string, string>();
        for (const attribute of (node.attributes as Record<string, unknown>[] | undefined) ?? []) {
          if (attribute.type === "Attribute" && typeof attribute.name === "string") {
            attributes.set(attribute.name, expressionText(attribute.value));
          }
        }
        componentAttributes.set(node.name, attributes);
      }
    });

    expect(derived.get("isWorkspaceDirectory")).toBe('page.url.pathname === "/"');
    expect(componentAttributes.get("HubShell")?.get("showNavigation")).toBe(
      "!isWorkspaceDirectory",
    );
    expect(componentAttributes.get("HubShell")?.get("showNavigationToggle")).toBe(
      "!isWorkspaceDirectory",
    );
    expect(componentAttributes.get("HubShell")?.get("showWorkspaceMenu")).toBe(
      "!isWorkspaceDirectory",
    );
  });
});

function expressionText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(expressionText).join("");
  const node = value as Record<string, unknown>;
  if (node.type === "ExpressionTag") return expressionText(node.expression);
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "Literal") return JSON.stringify(node.value);
  if (node.type === "UnaryExpression") {
    const operator = typeof node.operator === "string" ? node.operator : "";
    return `${operator}${expressionText(node.argument)}`;
  }
  if (node.type === "MemberExpression") {
    return `${expressionText(node.object)}.${expressionText(node.property)}`;
  }
  if (node.type === "BinaryExpression") {
    const operator = typeof node.operator === "string" ? node.operator : "";
    return `${expressionText(node.left)} ${operator} ${expressionText(node.right)}`;
  }
  return "";
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) if (key !== "parent") walk(child, visit);
}
