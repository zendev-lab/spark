import type { IconName } from "@zendev-lab/spark-ui";

export type ConsoleNavCopy = {
  createWorkspace: string;
  webAccess: string;
  workspaceDetails: string;
  channels: string;
  registration: string;
  modelsProviders: string;
  invocationDiagnostics: string;
  updateStatus: string;
};

export type ConsoleNavGroupCopy = {
  hub: string;
  daemon: string;
  workspace: string;
};

export type ConsoleNavItem = {
  href: string;
  label: string;
  icon: IconName;
};

export type ConsoleNavGroup = {
  id: keyof ConsoleNavGroupCopy;
  label: string;
  items: ConsoleNavItem[];
};

/** Independent control-plane settings — not tied to daemon or workspace. */
export function isControlPlanePath(pathname: string): boolean {
  if (pathname === "/workspaces/new" || pathname.startsWith("/workspaces/new/")) {
    return true;
  }
  if (pathname === "/settings/access" || pathname.startsWith("/settings/access/")) {
    return true;
  }
  if (pathname === "/settings/update" || pathname.startsWith("/settings/update/")) {
    return true;
  }
  return false;
}

/** @deprecated Prefer isControlPlanePath. */
export function isGlobalConsolePath(pathname: string): boolean {
  return isControlPlanePath(pathname);
}

export const HUB_SETTINGS_HREF = "/settings/access";

export function buildConsoleNavGroups(input: {
  nav: ConsoleNavCopy;
  groups: ConsoleNavGroupCopy;
  workspaceHrefPrefix: string | null;
  workspaceSlug?: string | null;
  includeControlPlaneNav?: boolean;
  includeWorkspaceNav?: boolean;
  includeDaemonNav?: boolean;
}): ConsoleNavGroup[] {
  const includeControlPlaneNav = input.includeControlPlaneNav ?? true;
  const includeWorkspaceNav = input.includeWorkspaceNav ?? true;
  const includeDaemonNav = input.includeDaemonNav ?? true;
  const groups: ConsoleNavGroup[] = [];

  if (includeControlPlaneNav) {
    groups.push({
      id: "hub",
      label: input.groups.hub,
      items: [
        { href: "/workspaces/new", label: input.nav.createWorkspace, icon: "plus" },
        { href: HUB_SETTINGS_HREF, label: input.nav.webAccess, icon: "user" },
        { href: "/settings/update", label: input.nav.updateStatus, icon: "retry" },
      ],
    });
  }

  if (includeWorkspaceNav && input.workspaceHrefPrefix) {
    const prefix = input.workspaceHrefPrefix;
    groups.push({
      id: "workspace",
      label: input.groups.workspace,
      items: [
        { href: `${prefix}/settings`, label: input.nav.workspaceDetails, icon: "folder" },
        { href: `${prefix}/settings/registration`, label: input.nav.registration, icon: "play" },
      ],
    });
  }

  if (includeDaemonNav) {
    const workspaceQuery = input.workspaceSlug
      ? `?workspace=${encodeURIComponent(input.workspaceSlug)}`
      : "";
    groups.push({
      id: "daemon",
      label: input.groups.daemon,
      items: [
        {
          href: "/settings/channels",
          label: input.nav.channels,
          icon: "activity",
        },
        {
          href: `/settings/models${workspaceQuery}`,
          label: input.nav.modelsProviders,
          icon: "spark",
        },
        {
          href: `/settings/invocations${workspaceQuery}`,
          label: input.nav.invocationDiagnostics,
          icon: "activity",
        },
      ],
    });
  }

  return groups;
}

export function isConsoleNavItemActive(input: { pathname: string; href: string }): boolean {
  if (!input.href) return false;
  const href = input.href.split("?", 1)[0]!;

  if (href === "/settings") {
    return input.pathname === "/settings";
  }

  if (href === "/settings/access") {
    return input.pathname === href || input.pathname.startsWith(`${href}/`);
  }

  if (href.endsWith("/settings/channels") || href === "/settings/channels") {
    return (
      input.pathname === href ||
      input.pathname.startsWith(`${href}/`) ||
      input.pathname === "/settings/channels" ||
      input.pathname.startsWith("/settings/channels/")
    );
  }

  if (href === "/workspaces/new") {
    return input.pathname === "/workspaces/new";
  }

  if (href.endsWith("/settings/registration")) {
    return input.pathname === href || input.pathname.startsWith(`${href}/`);
  }

  if (href.endsWith("/settings")) {
    return (
      input.pathname === href ||
      (input.pathname.startsWith(`${href}/`) &&
        !input.pathname.startsWith(`${href}/registration`) &&
        !input.pathname.startsWith(`${href}/channels`))
    );
  }

  return input.pathname === href || input.pathname.startsWith(`${href}/`);
}

export function currentConsolePageLabel(input: {
  pathname: string;
  nav: ConsoleNavCopy;
  createWorkspaceFallback?: string;
}): string {
  const segments = input.pathname.split("/").filter(Boolean);
  const top = segments[0] ?? "";

  if (top === "settings") {
    if (segments[1] === "access") return input.nav.webAccess;
    if (segments[1] === "channels") return input.nav.channels;
    if (segments[1] === "models") return input.nav.modelsProviders;
    if (segments[1] === "invocations") return input.nav.invocationDiagnostics;
    if (segments[1] === "update") return input.nav.updateStatus;
    return input.nav.modelsProviders;
  }

  if (top === "workspaces" && segments[1] === "new") {
    return input.nav.createWorkspace;
  }

  if (segments[1] === "settings") {
    if (segments[2] === "registration") return input.nav.registration;
    if (segments[2] === "channels") return input.nav.channels;
    return input.nav.workspaceDetails;
  }

  return input.createWorkspaceFallback ?? input.nav.modelsProviders;
}
