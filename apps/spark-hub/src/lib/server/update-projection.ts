import { readSparkUpdateStatus } from "@zendev-lab/spark-deployment";

export interface HubUpdateProjection {
  managed: boolean;
  installation:
    | "managed"
    | "vp"
    | "pnpm"
    | "yarn"
    | "bun"
    | "npm"
    | "container"
    | "source"
    | "unknown";
  automaticUpdates: boolean;
  updateCommand: string | null;
  policy: "manual" | "notify" | "auto";
  channel: "latest" | "next";
  checkIntervalHours: number;
  current: string | null;
  available: string | null;
  pending: string | null;
  quarantined: Array<{ version: string; reason: string; quarantinedAt: string }>;
  lastCheckAt: string | null;
  nextRetryAt: string | null;
  repairCommand: string | null;
}

/** Read-only Hub projection. Installation and rollback remain updater-owned. */
export async function readHubUpdateProjection(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<HubUpdateProjection> {
  const status = await readSparkUpdateStatus({ env: options.env });
  return {
    managed: status.managed,
    installation: status.installation.method,
    automaticUpdates: status.installation.automaticUpdates,
    updateCommand: status.installation.updateCommand ?? null,
    policy: status.config.policy,
    channel: status.config.channel,
    checkIntervalHours: status.config.checkIntervalHours,
    current: status.state.currentVersion ?? null,
    available: status.state.availableVersion ?? null,
    pending: status.state.pendingVersion ?? null,
    quarantined: status.state.quarantined,
    lastCheckAt: status.state.lastCheckAt ?? null,
    nextRetryAt: status.state.failure?.nextRetryAt ?? null,
    repairCommand: status.repairCommand ?? null,
  };
}
