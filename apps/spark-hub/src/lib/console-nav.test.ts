import { describe, expect, it } from "vitest";
import {
  buildConsoleNavGroups,
  HUB_SETTINGS_HREF,
  currentConsolePageLabel,
  isConsoleNavItemActive,
  isControlPlanePath,
  isGlobalConsolePath,
  type ConsoleNavCopy,
  type ConsoleNavGroupCopy,
} from "./console-nav";

const nav: ConsoleNavCopy = {
  modelsProviders: "Models & providers",
  invocationDiagnostics: "Invocation diagnostics",
  updateStatus: "Updates",
  channels: "Message platforms",
  workspaceDetails: "Basics",
  registration: "Runtime registration",
  webAccess: "Browser access",
  createWorkspace: "Create workspace",
};

const groups: ConsoleNavGroupCopy = {
  hub: "Hub",
  daemon: "Daemon",
  workspace: "Workspace · Local",
};

describe("console nav", () => {
  it("shows control-plane, workspace, and daemon settings together for an owner", () => {
    const result = buildConsoleNavGroups({
      workspaceHrefPrefix: "/local",
      workspaceSlug: "local",
      includeControlPlaneNav: true,
      includeWorkspaceNav: true,
      nav,
      groups,
    });

    expect(result.map((group) => [group.id, group.label])).toEqual([
      ["hub", "Hub"],
      ["workspace", "Workspace · Local"],
      ["daemon", "Daemon"],
    ]);
    expect(result[1]?.items.map((item) => item.href)).toEqual([
      "/local/settings",
      "/local/settings/registration",
    ]);
    expect(result[2]?.items.map((item) => item.href)).toEqual([
      "/settings/channels",
      "/settings/models?workspace=local",
      "/settings/invocations?workspace=local",
    ]);
  });

  it("shows only workspace settings without control-plane permission", () => {
    const result = buildConsoleNavGroups({
      workspaceHrefPrefix: "/local",
      workspaceSlug: "local",
      includeControlPlaneNav: false,
      includeWorkspaceNav: true,
      includeDaemonNav: false,
      nav,
      groups,
    });
    expect(result.map((group) => group.id)).toEqual(["workspace"]);
  });

  it("shows only control-plane items on independent Hub settings pages", () => {
    const result = buildConsoleNavGroups({
      workspaceHrefPrefix: "/local",
      includeControlPlaneNav: true,
      includeWorkspaceNav: false,
      includeDaemonNav: false,
      nav,
      groups,
    });
    expect(result.map((group) => group.id)).toEqual(["hub"]);
    expect(result[0]?.items.map((item) => item.href)).toEqual([
      "/workspaces/new",
      HUB_SETTINGS_HREF,
      "/settings/update",
    ]);
  });

  it("identifies control-plane paths (not workspace daemon settings)", () => {
    expect(isControlPlanePath("/settings/access")).toBe(true);
    expect(isControlPlanePath("/workspaces/new")).toBe(true);
    expect(isControlPlanePath("/settings/update")).toBe(true);
    expect(isControlPlanePath("/settings/invocations")).toBe(false);
    expect(isControlPlanePath("/settings/models")).toBe(false);
    expect(isControlPlanePath("/local/settings/registration")).toBe(false);
    expect(isGlobalConsolePath("/settings/access")).toBe(true);
    expect(isGlobalConsolePath("/settings/models")).toBe(false);
  });

  it("keeps Hub and workspace active states distinct", () => {
    expect(isConsoleNavItemActive({ pathname: "/workspaces/new", href: "/workspaces/new" })).toBe(
      true,
    );
    expect(isConsoleNavItemActive({ pathname: "/settings/models", href: "/workspaces/new" })).toBe(
      false,
    );
    expect(isConsoleNavItemActive({ pathname: "/settings/access", href: "/settings/access" })).toBe(
      true,
    );
    expect(isConsoleNavItemActive({ pathname: "/settings/models", href: "/settings/models" })).toBe(
      true,
    );
    expect(
      isConsoleNavItemActive({ pathname: "/local/settings/channels", href: "/settings/models" }),
    ).toBe(false);
    expect(
      isConsoleNavItemActive({
        pathname: "/settings/channels",
        href: "/settings/channels",
      }),
    ).toBe(true);
    expect(
      isConsoleNavItemActive({
        pathname: "/settings/models",
        href: "/settings/models?workspace=local",
      }),
    ).toBe(true);
    expect(isConsoleNavItemActive({ pathname: "/local/settings", href: "/local/settings" })).toBe(
      true,
    );
    expect(
      isConsoleNavItemActive({
        pathname: "/local/settings/registration",
        href: "/local/settings",
      }),
    ).toBe(false);
  });

  it("labels console pages by their settings scope", () => {
    expect(currentConsolePageLabel({ pathname: "/settings/channels", nav })).toBe(
      "Message platforms",
    );
    expect(currentConsolePageLabel({ pathname: "/settings/access", nav })).toBe("Browser access");
    expect(currentConsolePageLabel({ pathname: "/settings/models", nav })).toBe(
      "Models & providers",
    );
    expect(currentConsolePageLabel({ pathname: "/settings/invocations", nav })).toBe(
      "Invocation diagnostics",
    );
    expect(currentConsolePageLabel({ pathname: "/workspaces/new", nav })).toBe("Create workspace");
    expect(currentConsolePageLabel({ pathname: "/local/settings", nav })).toBe("Basics");
    expect(currentConsolePageLabel({ pathname: "/local/settings/registration", nav })).toBe(
      "Runtime registration",
    );
  });
});
