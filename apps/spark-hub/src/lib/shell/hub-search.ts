import { workbenchSessionScope } from "../workbench-session-scope";
import { formatChannelSessionTitle, type ChannelSessionLabels } from "../channel-session-title";
import { workspaceSessionPath } from "../workspace-routes";
import type { SparkSessionProjection } from "@zendev-lab/spark-protocol";

export type HubSearchSession = SparkSessionProjection & { activityStatus?: string };

export interface HubSearchWorkspace {
  id: string;
  slug: string;
  name: string;
}

export interface HubDaemonSummary {
  id: string;
  name: string;
  status: string;
}

export interface HubSearchResult {
  id: string;
  type: "session" | "workspace" | "page";
  title: string;
  description: string | null;
  status?: string;
  href: string;
}

export function buildHubSearchResults(input: {
  query: string;
  sessions: HubSearchSession[];
  workspaces: HubSearchWorkspace[];
  untitledConversationLabel: string;
  channelLabels: ChannelSessionLabels;
  statusLabels: Record<string, string>;
  pages?: HubSearchResult[];
}): HubSearchResult[] {
  const query = input.query.trim().toLowerCase();
  if (!query) return input.pages?.slice(0, 8) ?? [];

  const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const sessionResults = input.sessions
    .filter((session) => {
      const scope = workbenchSessionScope(session);
      // Hub search is workspace-scoped. Daemon-scoped conversations are
      // owned by the session tool / TUI and are not surfaced here.
      if (scope.kind !== "workspace") return false;
      const workspace = workspaceById.get(scope.workspaceId);
      return [session.sessionId, session.name ?? "", workspace?.name ?? "", workspace?.slug ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 6)
    .map((session): HubSearchResult => {
      const scope = workbenchSessionScope(session);
      const workspace =
        scope.kind === "workspace" ? workspaceById.get(scope.workspaceId) : undefined;
      const activityStatus =
        session.activityStatus ??
        session.activity ??
        (session.placement === "archived" ? "archived" : session.lifecycle);
      return {
        id: session.sessionId,
        type: "session",
        title: formatChannelSessionTitle(session.name, {
          labels: input.channelLabels,
          fallback: input.untitledConversationLabel,
        }),
        description: workspace ? workspace.name : null,
        status: activityStatus,
        href: workspace ? workspaceSessionPath(workspace, session.sessionId) : "/sessions",
      };
    });

  const workspaceResults = input.workspaces
    .filter((workspace) =>
      [workspace.name, workspace.slug].join("\n").toLowerCase().includes(query),
    )
    .slice(0, Math.max(0, 8 - sessionResults.length))
    .map((workspace): HubSearchResult => ({
      id: workspace.id,
      type: "workspace",
      title: workspace.name,
      description: `/${workspace.slug}`,
      href: `/${workspace.slug}`,
    }));

  const pageResults = (input.pages ?? [])
    .filter((page) => `${page.title}\n${page.description ?? ""}`.toLowerCase().includes(query))
    .slice(0, Math.max(0, 10 - sessionResults.length - workspaceResults.length));

  return [...sessionResults, ...workspaceResults, ...pageResults];
}
