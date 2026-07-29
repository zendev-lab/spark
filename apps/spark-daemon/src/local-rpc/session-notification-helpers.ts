import { SparkDaemonControlError } from "../control-error.ts";
import {
  deliverSessionNotification,
  type SessionNotificationDeliveryResult,
} from "../session-notification-delivery.ts";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import type { LocalRpcHandlerOptions } from "./types.ts";

export function requireSessionRegistry(options: LocalRpcHandlerOptions): DaemonSessionRegistry {
  if (!options.sessionRegistry) {
    throw new SparkDaemonControlError(
      "session_registry_unavailable",
      "Spark daemon session registry is not available.",
    );
  }
  return options.sessionRegistry;
}

export async function deliverSessionNotificationFromLocalRpc(
  options: LocalRpcHandlerOptions,
  input: { sessionId: string; messageId: string },
): Promise<SessionNotificationDeliveryResult> {
  const mailStore = options.mailStore;
  if (!mailStore?.get || !mailStore.recordChannelDelivery) {
    throw new SparkDaemonControlError(
      "session_mail_store_unavailable",
      "Spark daemon session mail delivery store is unavailable.",
    );
  }
  return await deliverSessionNotification(input, {
    mailStore: {
      get: mailStore.get.bind(mailStore),
      recordChannelDelivery: mailStore.recordChannelDelivery.bind(mailStore),
    },
    sessionRegistry: requireSessionRegistry(options),
    channelIngress: requireChannelIngress(options),
    ...(options.notificationDeliveryQueue
      ? { deliveryQueue: options.notificationDeliveryQueue }
      : {}),
  });
}

export function requireChannelIngress(
  options: LocalRpcHandlerOptions,
): NonNullable<LocalRpcHandlerOptions["channelIngress"]> {
  if (!options.channelIngress) {
    throw new SparkDaemonControlError(
      "channel_runtime_unavailable",
      "Spark daemon channel runtime is not available.",
    );
  }
  return options.channelIngress;
}
