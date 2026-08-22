export type ChannelAdapterType = "feishu" | "infoflow" | "qqbot";

const defaultScopes: Record<ChannelAdapterType, string> = {
  feishu: "chat",
  infoflow: "user",
  qqbot: "c2c",
};

/** Build a channel key: `feishu:chat:<id>`, `infoflow:user:<id>`, … */
export function createChannelExternalKey(
  adapter: ChannelAdapterType,
  scope: string,
  id: string,
): string {
  const trimmedId = id.trim();
  if (!trimmedId) {
    throw new Error("channel external id must be non-empty");
  }
  const parts = `${adapter}:${scope}:${trimmedId}`.trim().split(":").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("channel external key requires a non-empty scope and id");
  }
  return `${adapter}:${parts[1]}:${parts.slice(2).join(":")}`;
}

export function defaultChannelScope(adapter: ChannelAdapterType): string {
  return defaultScopes[adapter];
}

export function createDefaultChannelExternalKey(adapter: ChannelAdapterType, id: string): string {
  return createChannelExternalKey(adapter, defaultChannelScope(adapter), id);
}
