import { requireModelControl } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type ModelRequest = Extract<
  LocalRpcServiceRequest,
  {
    method:
      | "model.catalog"
      | "model.default.set"
      | "model.enabled.set"
      | "provider.auth.api-key.set"
      | "provider.auth.import.pi"
      | "provider.auth.logout"
      | "provider.auth.login.start"
      | "provider.auth.login.status"
      | "provider.auth.login.respond"
      | "provider.auth.login.cancel";
  }
>;

export async function handleModelRequest(
  ctx: LocalRpcDispatchContext,
  request: ModelRequest,
): Promise<LocalRpcServiceOutput<ModelRequest>> {
  const { options } = ctx;
  switch (request.method) {
    case "model.catalog": {
      const snapshot = await requireModelControl(options).snapshot(request.params.sessionId);
      return snapshot;
    }
    case "model.default.set": {
      const snapshot = await requireModelControl(options).setDefaultModel(request.params.model);
      return snapshot;
    }
    case "model.enabled.set": {
      const snapshot = await requireModelControl(options).setEnabledModels(request.params.models);
      return snapshot;
    }
    case "provider.auth.api-key.set": {
      const snapshot = await requireModelControl(options).setApiKey(
        request.params.providerName,
        request.params.apiKey,
      );
      return snapshot;
    }
    case "provider.auth.import.pi": {
      return await requireModelControl(options).importPiAuth(request.params);
    }
    case "provider.auth.logout": {
      const result = await requireModelControl(options).logout(request.params.providerName);
      return result;
    }
    case "provider.auth.login.start": {
      const flow = await requireModelControl(options).startOAuth(request.params.providerName);
      return flow;
    }
    case "provider.auth.login.status": {
      const flow = await requireModelControl(options).oauthStatus(request.params.flowId);
      return flow;
    }
    case "provider.auth.login.respond": {
      const flow = await requireModelControl(options).respondOAuth(
        request.params.flowId,
        request.params.promptId,
        request.params.value,
      );
      return flow;
    }
    case "provider.auth.login.cancel": {
      const flow = await requireModelControl(options).cancelOAuth(request.params.flowId);
      return flow;
    }
  }
}
