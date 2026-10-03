import type {
  SparkArtifactCatalogEntry,
  SparkInvocationSummary,
  SparkSessionProjection,
} from "@zendev-lab/spark-protocol";
import type { SparkLocalRpcOutput } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";

import { listSparkWebSessions } from "./session-list.ts";
import { invokeSparkWebRpc, type SparkWebDaemonInvoker } from "./rpc.ts";

export type SparkWebDashboardWorkspace =
  SparkLocalRpcOutput<"workspace.list">["workspaces"][number];
export type SparkWebDashboardWait = SparkLocalRpcOutput<"human.interaction.list">["waits"][number];
export type SparkWebDashboardArtifact = SparkArtifactCatalogEntry & { workspaceId: string };

export interface SparkWebDashboard {
  workspaces: SparkWebDashboardWorkspace[];
  sessions: SparkSessionProjection[];
  invocations: SparkInvocationSummary[];
  invocationTotal: number;
  waits: SparkWebDashboardWait[];
  artifacts: SparkWebDashboardArtifact[];
  artifactTotal: number;
  artifactUnavailableWorkspaceIds: string[];
  observedAt: string;
}

/**
 * Build the daemon-wide native Web projection. Workspace APIs are used only to
 * resolve Artifact owners and labels; they do not gate Session or Invocation
 * discovery.
 */
export async function loadSparkWebDashboard(
  invoke?: SparkWebDaemonInvoker,
): Promise<SparkWebDashboard> {
  const [workspacePage, sessions, invocationPage, humanPage] = await Promise.all([
    invokeSparkWebRpc("workspace.list", {}, invoke),
    listSparkWebSessions({}, invoke),
    invokeSparkWebRpc("invocation.list", { limit: 100, offset: 0 }, invoke),
    invokeSparkWebRpc("human.interaction.list", {}, invoke),
  ]);

  const artifactPages = await Promise.all(
    workspacePage.workspaces.map(async (workspace) => {
      try {
        const page = await invokeSparkWebRpc(
          "artifact.list",
          { workspaceId: workspace.id, limit: 20 },
          invoke,
        );
        return {
          workspaceId: workspace.id,
          available: true as const,
          total: page.total,
          artifacts: page.artifacts.map((artifact) => ({ ...artifact, workspaceId: workspace.id })),
        };
      } catch {
        return { workspaceId: workspace.id, available: false as const };
      }
    }),
  );
  const availableArtifactPages = artifactPages.filter((page) => page.available);

  return {
    workspaces: workspacePage.workspaces,
    sessions,
    invocations: invocationPage.invocations,
    invocationTotal: invocationPage.total,
    waits: humanPage.waits,
    artifacts: availableArtifactPages
      .flatMap((page) => page.artifacts)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 40),
    artifactTotal: availableArtifactPages.reduce((total, page) => total + page.total, 0),
    artifactUnavailableWorkspaceIds: artifactPages
      .filter((page) => !page.available)
      .map((page) => page.workspaceId),
    observedAt: invocationPage.observedAt,
  };
}
