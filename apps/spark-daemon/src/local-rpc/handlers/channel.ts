import { ChannelRegistryError, type ChannelRegistryErrorCode } from "@zendev-lab/spark-channels";
import type { SparkChannelRpcErrorCode } from "@zendev-lab/spark-protocol/daemon-rpc-errors";
import { SparkDaemonControlError } from "../../control-error.ts";
import { requireChannelIngress } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type ChannelRequest = Extract<
  LocalRpcServiceRequest,
  {
    method: "channel.status" | "channel.configure" | "channel.reload" | "channel.notify";
  }
>;

export async function handleChannelRequest(
  ctx: LocalRpcDispatchContext,
  request: ChannelRequest,
): Promise<LocalRpcServiceOutput<ChannelRequest>> {
  const { options } = ctx;
  try {
    switch (request.method) {
      case "channel.status": {
        const channelIngress = requireChannelIngress(options);
        return channelIngress.status(request.params.workspaceId);
      }
      case "channel.configure": {
        const channelIngress = requireChannelIngress(options);
        const result = await channelIngress.configure(
          request.params.workspaceId,
          request.params.config,
        );
        return result;
      }
      case "channel.reload": {
        const channelIngress = requireChannelIngress(options);
        const result = await channelIngress.reload(request.params.workspaceId);
        return result;
      }
      case "channel.notify": {
        const channelIngress = requireChannelIngress(options);
        const status = channelIngress.status(request.params.workspaceId);
        if (!status.configured) {
          throw new SparkDaemonControlError(
            "channel_not_configured",
            `Channels are not configured for workspace ${request.params.workspaceId}.`,
          );
        }
        const { workspaceId, ...notifyInput } = request.params;
        const result = await channelIngress.notify(workspaceId, notifyInput);
        return result;
      }
    }
  } catch (error) {
    if (error instanceof ChannelRegistryError) {
      throw new SparkDaemonControlError(channelRegistryRpcErrorCode(error.code), error.message);
    }
    throw error;
  }
}

function channelRegistryRpcErrorCode(code: ChannelRegistryErrorCode): SparkChannelRpcErrorCode {
  switch (code) {
    case "route_not_found":
      return "channel_route_not_found";
    case "adapter_exists":
      return "channel_adapter_exists";
    case "adapter_unavailable":
      return "channel_adapter_unavailable";
    case "invalid_action":
      return "channel_invalid_action";
    case "unsupported_operation":
      return "channel_unsupported_operation";
    case "interaction_not_supported":
      return "channel_interaction_not_supported";
    case "unsupported_adapter":
      return "channel_unsupported_adapter";
    case "adapter_not_found":
      return "channel_adapter_not_found";
    case "image_not_supported":
      return "channel_image_not_supported";
    case "adapter_required":
      return "channel_adapter_required";
    case "recipient_required":
      return "channel_recipient_required";
    case "invalid_config":
      return "channel_invalid_config";
  }
}
