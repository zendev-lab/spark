import { error as kitError, fail } from "@sveltejs/kit";
import {
  getCurrentUserIdBySessionToken,
  loadWorkspaceSettings,
} from "@zendev-lab/spark-hub-coordination/hub-queries";
import type { SparkQqbotQrAuthFlow } from "@zendev-lab/spark-protocol";
import { renderSVG } from "uqr";
import {
  isMessagePlatformAdapter,
  workspaceMessagePlatformConnections,
  type MessagePlatformAdapter,
  type MessagePlatformFormValues,
} from "$lib/message-platform";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { formText } from "$lib/server/form-data";
import {
  channelAdapterCredentialsComplete,
  channelEditorValuesFromProjection,
  DEFAULT_INFOFLOW_ENDPOINT,
  loadChannelStatusForHub,
  mergeMessagePlatformCredentials,
  saveChannelsConfigForHub,
  type HubChannelEditorValues,
  type MessagePlatformCredentialPatch,
} from "$lib/server/channel-status";
import { getDatabase } from "$lib/server/db";
import { createHubRuntimeModelChannelClient } from "$lib/server/hub-runtime-model-channel-client";
import { requireSecretRequestContext } from "$lib/server/secret-request-context";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export type { MessagePlatformFormValues } from "$lib/message-platform";

export const load: PageServerLoad = async ({ params }) => {
  const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
  if (!workspace) throw kitError(404, "Workspace not found.");

  const channelStatus = await loadChannelStatusForHub(workspace.id);
  const editor = channelEditorValuesFromProjection(channelStatus.configuration);
  return {
    workspace,
    settingsPath: workspacePath(workspace, "/settings"),
    channelStatus,
    editor,
    platforms: workspaceMessagePlatformConnections(editor, channelStatus.adapters),
    defaults: {
      infoflowEndpoint: DEFAULT_INFOFLOW_ENDPOINT,
      adapter: defaultMessagePlatformAdapter(editor),
    },
  };
};

export const actions: Actions = {
  savePlatform: async (event) => {
    const { cookies, request, params } = event;
    const workspace = loadWorkspaceSettings(getDatabase(), params.workspaceId);
    if (!workspace) throw kitError(404, "Workspace not found.");

    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).channelsSettings;
    const formData = await request.formData();
    const values = readMessagePlatformForm(formData);
    const status = await loadChannelStatusForHub(workspace.id);
    const previous = channelEditorValuesFromProjection(status.configuration);

    const credentialError = await saveMessagePlatformCredentials(
      workspace.id,
      values,
      previous,
      requireSecretRequestContext(event),
      t,
    );
    if (credentialError) {
      return fail(credentialError.status, {
        intent: "savePlatform",
        message: credentialError.message,
        values,
      });
    }

    return {
      intent: "savePlatform",
      message: t.savePlatformSuccess,
      values,
    };
  },
  startQqbotQrAuth: async (event) => {
    const workspace = requireWorkspace(event.params.workspaceId);
    const t = channelMessages(event);
    try {
      const flow = await createHubRuntimeModelChannelClient().startQqbotQrAuth({
        workspaceId: workspace.id,
        requestedByUserId: currentUserId(event.locals.sessionToken),
      });
      return qqbotQrActionResult(flow);
    } catch {
      return fail(500, { intent: "qqbotQrAuth", message: t.qqbotQrStartFailed });
    }
  },
  qqbotQrAuthStatus: async (event) => {
    const workspace = requireWorkspace(event.params.workspaceId);
    const flowId = formText(await event.request.formData(), "flowId");
    if (!flowId) {
      return fail(400, { intent: "qqbotQrAuth", message: channelMessages(event).qqbotQrNotFound });
    }
    try {
      const flow = await createHubRuntimeModelChannelClient().qqbotQrAuthStatus({
        workspaceId: workspace.id,
        flowId,
      });
      return qqbotQrActionResult(flow);
    } catch {
      return fail(404, {
        intent: "qqbotQrAuth",
        message: channelMessages(event).qqbotQrNotFound,
      });
    }
  },
  cancelQqbotQrAuth: async (event) => {
    const workspace = requireWorkspace(event.params.workspaceId);
    const flowId = formText(await event.request.formData(), "flowId");
    if (!flowId) {
      return fail(400, { intent: "qqbotQrAuth", message: channelMessages(event).qqbotQrNotFound });
    }
    try {
      const flow = await createHubRuntimeModelChannelClient().cancelQqbotQrAuth({
        workspaceId: workspace.id,
        flowId,
        requestedByUserId: currentUserId(event.locals.sessionToken),
      });
      return qqbotQrActionResult(flow);
    } catch {
      return fail(404, {
        intent: "qqbotQrAuth",
        message: channelMessages(event).qqbotQrNotFound,
      });
    }
  },
};

function requireWorkspace(workspaceId: string) {
  const workspace = loadWorkspaceSettings(getDatabase(), workspaceId);
  if (!workspace) throw kitError(404, "Workspace not found.");
  return workspace;
}

function currentUserId(sessionToken: string | null): string | undefined {
  return getCurrentUserIdBySessionToken(getDatabase(), sessionToken) ?? undefined;
}

function channelMessages(event: Parameters<NonNullable<Actions[string]>>[0]) {
  return getRequestDictionary({
    cookieLocale: event.cookies.get(localeCookieName),
    acceptLanguage: event.request.headers.get("accept-language"),
  }).channelsSettings;
}

function qqbotQrActionResult(flow: SparkQqbotQrAuthFlow) {
  return {
    intent: "qqbotQrAuth" as const,
    flow: {
      id: flow.id,
      status: flow.status,
      ...(flow.appId ? { appId: flow.appId } : {}),
      ...(flow.reason ? { reason: flow.reason } : {}),
    },
    ...(flow.qrCodeUrl
      ? {
          qrCodeDataUrl: `data:image/svg+xml;base64,${Buffer.from(
            renderSVG(flow.qrCodeUrl, { ecc: "M", border: 2 }),
          ).toString("base64")}`,
        }
      : {}),
  };
}

async function saveMessagePlatformCredentials(
  workspaceId: string,
  values: MessagePlatformFormValues,
  previous: HubChannelEditorValues,
  context: Parameters<typeof saveChannelsConfigForHub>[2],
  t: {
    saveFeishuRequired: string;
    saveInfoflowRequired: string;
    saveQqbotRequired: string;
    savePlatformFailed: string;
  },
): Promise<{ status: number; message: string } | null> {
  const merged = mergeMessagePlatformCredentials(previous, credentialPatchFromForm(values));
  if (values.adapter === "infoflow" && !merged.infoflowEndpoint.trim()) {
    merged.infoflowEndpoint = DEFAULT_INFOFLOW_ENDPOINT;
  }

  if (!channelAdapterCredentialsComplete(merged, values.adapter)) {
    return {
      status: 400,
      message:
        values.adapter === "feishu"
          ? t.saveFeishuRequired
          : values.adapter === "qqbot"
            ? t.saveQqbotRequired
            : t.saveInfoflowRequired,
    };
  }

  try {
    await saveChannelsConfigForHub(workspaceId, merged, context);
    return null;
  } catch (error) {
    return {
      status: 500,
      message: error instanceof Error ? error.message : t.savePlatformFailed,
    };
  }
}

function defaultMessagePlatformAdapter(editor: HubChannelEditorValues): MessagePlatformAdapter {
  if (!editor.infoflowEnabled) return "infoflow";
  if (!editor.qqbotEnabled) return "qqbot";
  if (!editor.feishuEnabled) return "feishu";
  return "infoflow";
}

function readMessagePlatformForm(formData: FormData): MessagePlatformFormValues {
  return {
    adapter: parseAdapter(formText(formData, "adapter")),
    feishuAppId: formText(formData, "feishuAppId"),
    feishuAppSecret: formText(formData, "feishuAppSecret"),
    infoflowEndpoint: formText(formData, "infoflowEndpoint"),
    infoflowAppKey: formText(formData, "infoflowAppKey"),
    infoflowAppAgentId: formText(formData, "infoflowAppAgentId"),
    infoflowAppSecret: formText(formData, "infoflowAppSecret"),
    qqbotAppId: formText(formData, "qqbotAppId"),
    qqbotClientSecret: formText(formData, "qqbotClientSecret"),
    qqbotSandbox: formData.get("qqbotSandbox") === "on",
  };
}

function credentialPatchFromForm(
  values: MessagePlatformFormValues,
): MessagePlatformCredentialPatch {
  switch (values.adapter) {
    case "feishu":
      return {
        adapter: "feishu",
        feishuAppId: values.feishuAppId,
        feishuAppSecret: values.feishuAppSecret,
      };
    case "infoflow":
      return {
        adapter: "infoflow",
        infoflowEndpoint: values.infoflowEndpoint,
        infoflowAppKey: values.infoflowAppKey,
        infoflowAppAgentId: values.infoflowAppAgentId,
        infoflowAppSecret: values.infoflowAppSecret,
      };
    case "qqbot":
      return {
        adapter: "qqbot",
        qqbotAppId: values.qqbotAppId,
        qqbotClientSecret: values.qqbotClientSecret,
        qqbotSandbox: values.qqbotSandbox,
      };
    default: {
      const _exhaustive: never = values.adapter;
      throw new Error(`unsupported message platform adapter: ${String(_exhaustive)}`);
    }
  }
}

function parseAdapter(raw: string): MessagePlatformAdapter {
  return isMessagePlatformAdapter(raw) ? raw : "infoflow";
}
