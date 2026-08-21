import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  channelDeliveryNotSent,
  parseChannelsConfig,
  type ChannelRegistryOptions,
  type ChannelsConfig,
} from "@zendev-lab/dsh-channels";
import { channelConfigPath, resolveSparkPaths, writePrivateFile } from "@zendev-lab/spark-system";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "../session-registry.ts";
import { migrateDaemonChannelsConfig } from "./config-migration.ts";
import {
  createChannelIngressController,
  type ChannelIngressController,
  type ChannelIngressHooks,
  type DaemonChannelIngressRuntime,
  type DaemonChannelIngressStatus,
} from "./ingress.ts";
import { createDaemonQqbotQrAuthManager } from "./qqbot-auth.ts";
import type { DaemonChannelTransportFactory } from "./transport-factory.ts";

interface GlobalChannelSlot {
  configPath: string;
  controller: ChannelIngressController | null;
  config: ChannelsConfig | null;
  lastReloadedAt?: string;
  lastError?: string;
  transition: Promise<void>;
}

/** One daemon-global Channel runtime. No operation accepts a Workspace route. */
export function createDaemonChannelIngressRuntime(input: {
  sparkHome: string;
  hooks: ChannelIngressHooks;
  sessionRegistry?: Pick<DaemonSessionRegistry, "resolveChannelSession"> &
    Partial<Pick<DaemonSessionRegistry, "get">>;
  createTransport?: ChannelRegistryOptions["createTransport"];
  createDaemonTransport?: DaemonChannelTransportFactory;
  now?: () => Date;
}): DaemonChannelIngressRuntime {
  const now = input.now ?? (() => new Date());
  const paths = resolveSparkPaths({ app: "daemon", sparkHome: input.sparkHome });
  const sessionRegistry = input.sessionRegistry ?? createDaemonSessionRegistry(input.sparkHome);
  const slot: GlobalChannelSlot = {
    configPath: channelConfigPath(paths),
    controller: null,
    config: null,
    transition: Promise.resolve(),
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = slot.transition.then(operation, operation);
    slot.transition = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  const createController = (config: ChannelsConfig): ChannelIngressController =>
    createChannelIngressController({
      sparkHome: input.sparkHome,
      config,
      hooks: input.hooks,
      sessionRegistry,
      ...(input.createTransport ? { createTransport: input.createTransport } : {}),
      ...(input.createDaemonTransport
        ? { createDaemonTransport: input.createDaemonTransport }
        : {}),
    });

  const status = (): DaemonChannelIngressStatus => {
    const runtime = slot.controller?.status();
    const adapters = runtime?.adapters ?? [];
    const routes = runtime?.routes ?? [];
    const ingressEnabled =
      runtime?.ingressEnabled ?? Object.keys(slot.config?.adapters ?? {}).length > 0;
    const connected = adapters.filter(
      (adapter) => adapter.running && adapter.state === "connected",
    ).length;
    const running = adapters.filter((adapter) => adapter.running).length;
    const error = slot.lastError ?? adapters.find((adapter) => adapter.error)?.error;
    const state = error
      ? "degraded"
      : !slot.config
        ? "unconfigured"
        : ingressEnabled && adapters.length > 0 && connected === adapters.length
          ? "running"
          : running > 0
            ? "degraded"
            : "stopped";
    const observedAt = now().toISOString();
    return {
      plane: "daemon",
      resource: "channel",
      configPath: slot.configPath,
      available: true,
      configured: slot.config !== null,
      ingressEnabled,
      state,
      adapters,
      routes,
      ...(slot.lastReloadedAt ? { lastReloadedAt: slot.lastReloadedAt } : {}),
      ...(error ? { error } : {}),
      observedAt,
      text: error
        ? `channels daemon degraded connected=${connected}/${adapters.length} routes=${routes.length} ingress=${ingressEnabled ? "on" : "off"} error=${error}\n`
        : !slot.config
          ? `channels daemon not configured (${slot.configPath})\n`
          : `channels daemon ${state} connected=${connected}/${adapters.length} routes=${routes.length} ingress=${ingressEnabled ? "on" : "off"}\n`,
    };
  };

  const replace = async (
    config: ChannelsConfig | null,
    persist: boolean,
  ): Promise<DaemonChannelIngressStatus> => {
    const previous = slot.controller;
    if (!config) {
      slot.controller = null;
      slot.config = null;
      await previous?.stop();
      slot.lastError = undefined;
      slot.lastReloadedAt = now().toISOString();
      return status();
    }
    const replacement = createController(config);
    try {
      // Validate the replacement generation while the previous generation is
      // still the visible owner. Only a fully started controller is swapped.
      await replacement.start();
      if (persist) {
        await mkdir(dirname(slot.configPath), { recursive: true, mode: 0o700 });
        writePrivateFile(slot.configPath, `${JSON.stringify(config, null, 2)}\n`);
      }
    } catch (error) {
      await replacement.stop().catch(() => undefined);
      slot.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    slot.controller = replacement;
    slot.config = config;
    slot.lastError = undefined;
    slot.lastReloadedAt = now().toISOString();
    try {
      await previous?.stop();
    } catch (error) {
      slot.lastError = `replacement active; prior generation disposal failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return status();
  };

  let runtime!: DaemonChannelIngressRuntime;
  const requireController = (): ChannelIngressController => {
    if (!slot.controller) {
      throw channelDeliveryNotSent(new Error("daemon Channels are not configured"));
    }
    return slot.controller;
  };
  const qqbotQrAuth = createDaemonQqbotQrAuthManager({
    loadConfig: async () => slot.config,
    configure: async (config) => await runtime.configure(config),
  });

  runtime = {
    start: async () =>
      await serialize(async () => {
        const migration = await migrateDaemonChannelsConfig({ sparkHome: input.sparkHome });
        if (migration.state === "conflict") {
          slot.lastError = `Channel config migration conflict (${migration.conflicts.length})`;
          return status();
        }
        return await replace(migration.state === "ready" ? migration.config : null, false);
      }),
    stop: async () => {
      qqbotQrAuth.stop();
      await serialize(async () => {
        const active = slot.controller;
        slot.controller = null;
        await active?.stop();
      });
    },
    admitInbound: async (message) => await requireController().admitInbound(message),
    status,
    configure: async (value) => {
      const config = parseChannelsConfig(value);
      return await serialize(async () => await replace(config, true));
    },
    reload: async () =>
      await serialize(async () => {
        const migration = await migrateDaemonChannelsConfig({ sparkHome: input.sparkHome });
        if (migration.state === "conflict") {
          slot.lastError = `Channel config migration conflict (${migration.conflicts.length})`;
          return status();
        }
        return await replace(migration.state === "ready" ? migration.config : null, false);
      }),
    startQqbotQrAuth: async () => await qqbotQrAuth.start(),
    qqbotQrAuthStatus: (flowId) => qqbotQrAuth.status(flowId),
    cancelQqbotQrAuth: (flowId) => qqbotQrAuth.cancel(flowId),
    notify: async (notifyInput) => await requireController().notify(notifyInput),
    openReplyStream: async (adapterId, target, options) =>
      await requireController().openReplyStream(adapterId, target, options),
    sendMessage: async (adapterId, messageInput) =>
      await requireController().sendMessage(adapterId, messageInput),
    sendReply: async (adapterId, replyInput) =>
      await requireController().sendReply(adapterId, replyInput),
    resolveAdapterId: (adapterId, adapterAccountIdentity) =>
      requireController().resolveAdapterId(adapterId, adapterAccountIdentity),
    replyDeliveryFacts: (adapterId, target) =>
      requireController().replyDeliveryFacts(adapterId, target),
    messageDeliveryFacts: (adapterId, target) =>
      requireController().messageDeliveryFacts(adapterId, target),
    recoverReply: async (adapterId, replyInput) =>
      await requireController().recoverReply(adapterId, replyInput),
    sendAsk: async (adapterId, recipient, request) =>
      await requireController().sendAsk(adapterId, recipient, request),
    ackInteraction: async (adapterId, interactionId, ackStatus) =>
      await requireController().ackInteraction(adapterId, interactionId, ackStatus),
    setInteractionHandler: (handler) => {
      input.hooks.onInteraction = handler;
    },
    setTextAskHandler: (handler) => {
      input.hooks.onTextAskReply = handler;
    },
    setInboundHandler: (handler) => {
      input.hooks.onInboundReceived = handler;
    },
  };
  return runtime;
}
