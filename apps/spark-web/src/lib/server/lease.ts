import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";

export type SparkWebLease = {
  clientId: string;
  workspaceId: string;
  leaseFence?: string;
  cwd: string;
};

export async function attachSparkWebLease(input: {
  localPath: string;
  displayName?: string;
}): Promise<SparkWebLease> {
  const workspace = await requestSparkDaemon("workspace.ensure-local", {
    localPath: input.localPath,
  });
  const attached = await requestSparkDaemon("workspace.client.attach", {
    workspaceId: workspace.id,
    kind: "interactive",
    displayName: input.displayName ?? "Spark Web",
    metadata: { surface: "web" },
  });
  return {
    clientId: attached.client.id,
    workspaceId: attached.workspace.id,
    ...(attached.client.leaseFence ? { leaseFence: attached.client.leaseFence } : {}),
    cwd: attached.workspace.localPath,
  };
}

export async function heartbeatSparkWebLease(lease: SparkWebLease): Promise<void> {
  await requestSparkDaemon("workspace.client.heartbeat", {
    clientId: lease.clientId,
    ...(lease.leaseFence ? { leaseFence: lease.leaseFence } : {}),
  });
}

export async function releaseSparkWebLease(lease: SparkWebLease): Promise<void> {
  await requestSparkDaemon("workspace.client.release", {
    clientId: lease.clientId,
    ...(lease.leaseFence ? { leaseFence: lease.leaseFence } : {}),
  });
}
