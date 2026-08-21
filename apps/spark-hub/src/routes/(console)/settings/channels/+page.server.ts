import { error as kitError, fail } from "@sveltejs/kit";
import { getCurrentUserIdBySessionToken } from "@zendev-lab/spark-hub-coordination/hub-queries";
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
  unavailableChannelStatusForHub,
  type HubChannelEditorValues,
  type MessagePlatformCredentialPatch,
} from "$lib/server/channel-status";
import { getDatabase } from "$lib/server/db";
import { createHubRuntimeModelChannelClient } from "$lib/server/hub-runtime-model-channel-client";
import { requireSecretRequestContext } from "$lib/server/secret-request-context";
import type { Actions, PageServerLoad } from "./$types";

export type { MessagePlatformFormValues } from "$lib/message-platform";

export const load: PageServerLoad = async ({ url }) => {
  const runtimes = channelRuntimes();
  const requestedRuntimeId = url.searchParams.get("runtimeId")?.trim();
  const selectedRuntime = requestedRuntimeId
    ? runtimes.find(({ runtimeId }) => runtimeId === requestedRuntimeId)
    : runtimes.length === 1
      ? runtimes[0]
      : undefined;
  if (requestedRuntimeId && !selectedRuntime) throw kitError(404, "Runtime not found.");
  const channelStatus = selectedRuntime
    ? await loadChannelStatusForHub(selectedRuntime.runtimeId)
    : unavailableChannelStatusForHub(
        "unselected",
        runtimes.length === 0
          ? "No Spark daemon is registered."
          : "Select a Spark daemon to manage its Channels.",
      );
  const editor = channelEditorValuesFromProjection(channelStatus.configuration);
  return {
    runtimes,
    selectedRuntimeId: selectedRuntime?.runtimeId ?? null,
    requiresRuntimeSelection: runtimes.length > 1 && !selectedRuntime,
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
    const { cookies, request } = event;

    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).channelsSettings;
    const formData = await request.formData();
    const runtimeId = requireRuntimeId(formData);
    const values = readMessagePlatformForm(formData);
    const status = await loadChannelStatusForHub(runtimeId);
    const previous = channelEditorValuesFromProjection(status.configuration);

    const credentialError = await saveMessagePlatformCredentials(
      runtimeId,
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
    const runtimeId = requireRuntimeId(await event.request.formData());
    const t = channelMessages(event);
    try {
      const flow = await createHubRuntimeModelChannelClient().startQqbotQrAuth({
        runtimeId,
        requestedByUserId: currentUserId(event.locals.sessionToken),
      });
      return qqbotQrActionResult(flow);
    } catch {
      return fail(500, { intent: "qqbotQrAuth", message: t.qqbotQrStartFailed });
    }
  },
  qqbotQrAuthStatus: async (event) => {
    const formData = await event.request.formData();
    const runtimeId = requireRuntimeId(formData);
    const flowId = formText(formData, "flowId");
    if (!flowId) {
      return fail(400, { intent: "qqbotQrAuth", message: channelMessages(event).qqbotQrNotFound });
    }
    try {
      const flow = await createHubRuntimeModelChannelClient().qqbotQrAuthStatus({
        runtimeId,
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
    const formData = await event.request.formData();
    const runtimeId = requireRuntimeId(formData);
    const flowId = formText(formData, "flowId");
    if (!flowId) {
      return fail(400, { intent: "qqbotQrAuth", message: channelMessages(event).qqbotQrNotFound });
    }
    try {
      const flow = await createHubRuntimeModelChannelClient().cancelQqbotQrAuth({
        runtimeId,
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

function channelRuntimes(): Array<{
  runtimeId: string;
  installationId: string;
  name: string;
  status: string;
}> {
  return getDatabase()
    .prepare(
      `SELECT id AS runtimeId,
              installation_id AS installationId,
              name,
              status
       FROM runtime_connections
       ORDER BY name, installation_id, id`,
    )
    .all() as Array<{
    runtimeId: string;
    installationId: string;
    name: string;
    status: string;
  }>;
}

function requireRuntimeId(formData: FormData): string {
  const runtimeId = formText(formData, "runtimeId");
  if (!runtimeId || !channelRuntimes().some((runtime) => runtime.runtimeId === runtimeId)) {
    throw kitError(400, "Select a registered Spark daemon.");
  }
  return runtimeId;
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
  runtimeId: string,
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
    await saveChannelsConfigForHub(runtimeId, merged, context);
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
