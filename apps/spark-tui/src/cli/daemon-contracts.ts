export type SparkWorkspaceClientKind = "interactive" | "headless" | "executor";

export interface SparkWorkspaceClientProjection {
  clientId: string;
  kind: SparkWorkspaceClientKind;
  status: "connected" | "disconnected";
  displayName?: string;
  sessionId?: string;
  attachedAt?: string;
  lastSeenAt?: string;
}

export interface SparkDaemonWorkspace {
  id: string;
  serverWorkspaceId?: string;
  serverUrl: string;
  localWorkspaceKey: string;
  displayName: string;
  localPath: string;
  status: string;
  workspaceClients?: SparkWorkspaceClientProjection[];
  updatedAt?: string;
}
