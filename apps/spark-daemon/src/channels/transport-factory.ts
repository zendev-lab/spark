import {
  channelAdapterAccountIdentity,
  createQqbotTransport as createDefaultQqbotTransport,
  type ChannelAdapterConfig,
  type ChannelTransport,
  type QqbotAdapterConfig,
  type QqbotTransportOptions,
} from "@zendev-lab/dsh-channels";
import type { DatabaseSync } from "node:sqlite";
import { SparkQqbotGatewayCursorStore } from "../store/qqbot-gateway-cursors.ts";

export interface DaemonChannelTransportContext {
  adapterId: string;
  config: ChannelAdapterConfig;
}

export type DaemonChannelTransportFactory = (
  adapterId: string,
  config: ChannelAdapterConfig,
) => ChannelTransport | undefined;

export interface DaemonChannelTransportFactoryOptions {
  cursorStore?: SparkQqbotGatewayCursorStore;
  createQqbotTransport?: (
    config: QqbotAdapterConfig,
    options: QqbotTransportOptions,
  ) => ChannelTransport;
}

/** Keep SQLite cursor ownership out of dsh-channels. */
export function createDaemonChannelTransportFactory(
  db: DatabaseSync,
  options: DaemonChannelTransportFactoryOptions = {},
): DaemonChannelTransportFactory {
  const cursors = options.cursorStore ?? new SparkQqbotGatewayCursorStore(db);
  const createQqbot = options.createQqbotTransport ?? createDefaultQqbotTransport;
  return (adapterId, config) => {
    if (config.type !== "qqbot") return undefined;
    const adapterAccountIdentity = channelAdapterAccountIdentity(config);
    return createQqbot(config, {
      loadCursor: () => cursors.get(adapterAccountIdentity, adapterId) ?? null,
      saveCursor: (cursor) => cursors.save(adapterAccountIdentity, cursor),
    });
  };
}
