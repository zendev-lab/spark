import { vi } from "vitest";
import type { SparkDaemonClient } from "./daemon-client.js";

const heartbeatTestNow = "2026-07-28T00:00:00.000Z";

const heartbeatTestWorkspace = {
  id: "workspace-1",
  serverUrl: "http://127.0.0.1:4310",
  localWorkspaceKey: "workspace-1",
  displayName: "Workspace 1",
  localPath: "/workspace-1",
  status: "available" as const,
  capabilities: {},
  diagnostics: {},
  updatedAt: heartbeatTestNow,
};

export const heartbeatTestAttachInput = {
  workspaceId: heartbeatTestWorkspace.id,
  clientId: "surface-1",
  kind: "interactive" as const,
  displayName: "Spark TUI",
  leaseTtlMs: 60_000,
  sessionId: "session-1",
  metadata: { surface: "tui" },
};

export function heartbeatClientWithResults(...results: unknown[]): SparkDaemonClient {
  const request = vi.fn();
  for (const result of results) request.mockResolvedValueOnce(result);
  return { request } as SparkDaemonClient;
}

export function heartbeatLeaseResult(
  leaseFence: string | undefined,
  overrides: { sessionId?: string; clientId?: string } = {},
) {
  return {
    client: {
      id: overrides.clientId ?? "surface-1",
      workspaceId: heartbeatTestWorkspace.id,
      kind: "interactive" as const,
      displayName: "Spark TUI",
      status: "connected" as const,
      attachedAt: heartbeatTestNow,
      lastSeenAt: heartbeatTestNow,
      leaseExpiresAt: "2026-07-28T00:01:00.000Z",
      sessionId: overrides.sessionId ?? "session-1",
      ...(leaseFence ? { leaseFence } : {}),
      metadata: { surface: "tui" },
    },
    workspace: heartbeatTestWorkspace,
    observedAt: heartbeatTestNow,
  };
}

export function heartbeatReleasedResult(leaseFence: string) {
  const result = heartbeatLeaseResult(leaseFence);
  return {
    ...result,
    client: {
      ...result.client,
      status: "disconnected" as const,
      releasedAt: heartbeatTestNow,
    },
  };
}
