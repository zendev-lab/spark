import {
  parkSparkDaemonUplink,
  preferSparkDaemonWorkspaceUplinkWithTransfer,
  sparkDaemonUplinkStatus,
  unparkSparkDaemonUplink,
} from "../../uplink.ts";
import { SparkDaemonLeaseTransferBroker } from "../../core/lease-transfer.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type UplinkRequest = Extract<
  LocalRpcServiceRequest,
  { method: "uplink.park" | "uplink.unpark" | "uplink.prefer" | "uplink.status" }
>;

export async function handleUplinkRequest(
  ctx: LocalRpcDispatchContext,
  request: UplinkRequest,
): Promise<LocalRpcServiceOutput<UplinkRequest>> {
  const { paths, db, options } = ctx;
  switch (request.method) {
    case "uplink.park": {
      const profile = await parkSparkDaemonUplink(paths, request.params.serverUrl);
      options.onUplinkReconfigure?.(profile.serverUrl);
      return { serverUrl: profile.serverUrl, parked: true };
    }
    case "uplink.unpark": {
      const profile = await unparkSparkDaemonUplink(paths, request.params.serverUrl);
      options.onUplinkReconfigure?.(profile.serverUrl);
      return { serverUrl: profile.serverUrl, parked: false };
    }
    case "uplink.prefer": {
      const transfers = options.leaseTransfers ?? new SparkDaemonLeaseTransferBroker();
      const preferred = await preferSparkDaemonWorkspaceUplinkWithTransfer(
        paths,
        db,
        request.params,
        {
          transfers,
          ...(options.humanWaits ? { humanWaits: options.humanWaits } : {}),
          ...(options.onHumanRequestOutboxReady
            ? { onOutboxReady: options.onHumanRequestOutboxReady }
            : {}),
          ...(options.getRuntimeIdForServer ? { getRuntimeId: options.getRuntimeIdForServer } : {}),
          ...(request.params.force === true ? { force: true } : {}),
        },
      );
      if (preferred.previousServerUrl) {
        options.onUplinkReconfigure?.(preferred.previousServerUrl);
      }
      options.onUplinkReconfigure?.(preferred.serverUrl);
      return parseLocalRpcServiceOutput(request.method, preferred);
    }
    case "uplink.status":
      return sparkDaemonUplinkStatus(paths, db);
  }
}
