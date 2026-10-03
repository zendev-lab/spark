export type MessagePlatformAdapter = "feishu" | "infoflow" | "qqbot";

export type MessagePlatformFormValues = {
  adapter: MessagePlatformAdapter;
  feishuAppId: string;
  feishuAppSecret: string;
  infoflowEndpoint: string;
  infoflowAppKey: string;
  infoflowAppAgentId: string;
  infoflowAppSecret: string;
  qqbotAppId: string;
  qqbotClientSecret: string;
  qqbotSandbox: boolean;
};

export type MessagePlatformFormDefaults = {
  adapter: MessagePlatformAdapter;
  infoflowDefaultEndpoint: string;
  feishuAppId?: string;
  infoflowEndpoint?: string;
  infoflowAppKey?: string;
  infoflowAppAgentId?: string;
  qqbotAppId?: string;
  qqbotSandbox?: boolean;
};

export type DaemonMessagePlatformConnection = {
  adapter: MessagePlatformAdapter;
  adapterId: string;
  accountId: string;
  editable: boolean;
  runtimeState?: string;
  runtimeError?: string;
};

type MessagePlatformEditorProjection = {
  feishuEnabled: boolean;
  feishuAppId: string;
  infoflowEnabled: boolean;
  infoflowAppAgentId: string;
  qqbotEnabled: boolean;
  qqbotAppId: string;
};

/** Build a clean connection form while retaining only reusable, non-secret account settings. */
export function freshMessagePlatformFormValues(
  defaults: MessagePlatformFormDefaults,
): MessagePlatformFormValues {
  return {
    adapter: defaults.adapter,
    feishuAppId: defaults.feishuAppId ?? "",
    feishuAppSecret: "",
    infoflowEndpoint: defaults.infoflowEndpoint || defaults.infoflowDefaultEndpoint,
    infoflowAppKey: defaults.infoflowAppKey ?? "",
    infoflowAppAgentId: defaults.infoflowAppAgentId ?? "",
    infoflowAppSecret: "",
    qqbotAppId: defaults.qqbotAppId ?? "",
    qqbotClientSecret: "",
    qqbotSandbox: defaults.qqbotSandbox ?? false,
  };
}

/**
 * Project configured adapter accounts for the settings UI.
 * Conversation scope and peer ids deliberately do not belong in this representation.
 */
export function daemonMessagePlatformConnections(
  editor: MessagePlatformEditorProjection,
  runtimeAdapters: ReadonlyArray<{
    id: string;
    type: string;
    state: string;
    error?: string;
  }> = [],
): DaemonMessagePlatformConnection[] {
  const supportedRuntimeAdapters = runtimeAdapters.filter(
    (adapter): adapter is (typeof runtimeAdapters)[number] & { type: MessagePlatformAdapter } =>
      isMessagePlatformAdapter(adapter.type),
  );
  if (supportedRuntimeAdapters.length > 0) {
    const countByType = new Map<MessagePlatformAdapter, number>();
    for (const adapter of supportedRuntimeAdapters) {
      countByType.set(adapter.type, (countByType.get(adapter.type) ?? 0) + 1);
    }
    return supportedRuntimeAdapters.map((runtime) => ({
      adapter: runtime.type,
      adapterId: runtime.id,
      accountId: runtime.id,
      editable: countByType.get(runtime.type) === 1,
      ...(runtime.state ? { runtimeState: runtime.state } : {}),
      ...(runtime.error ? { runtimeError: runtime.error } : {}),
    }));
  }

  const configured: Array<{ adapter: MessagePlatformAdapter; accountId: string }> = [];
  if (editor.infoflowEnabled) {
    configured.push({
      adapter: "infoflow",
      accountId: editor.infoflowAppAgentId.trim(),
    });
  }
  if (editor.qqbotEnabled) {
    configured.push({ adapter: "qqbot", accountId: editor.qqbotAppId.trim() });
  }
  if (editor.feishuEnabled) {
    configured.push({ adapter: "feishu", accountId: editor.feishuAppId.trim() });
  }

  return configured.map((connection) => ({
    ...connection,
    adapterId: connection.adapter,
    editable: true,
  }));
}

export function isMessagePlatformAdapter(value: string): value is MessagePlatformAdapter {
  return value === "feishu" || value === "infoflow" || value === "qqbot";
}
