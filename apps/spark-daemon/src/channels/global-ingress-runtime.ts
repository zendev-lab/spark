import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context, Fiber } from "@deepseek-ai/cordis";
import {
  channelDeliveryNotSent,
  createChannelsPlugin,
  parseChannelsConfig,
  type ChannelRegistryOptions,
  type ChannelsService,
  type ChannelsConfig,
} from "@zendev-lab/dsh-channel-transports";
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
  service: ChannelsService | null;
  pluginFiber: Fiber | null;
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
  /** Shared daemon composition root. */
  ctx: Context;
  now?: () => Date;
}): DaemonChannelIngressRuntime {
  const now = input.now ?? (() => new Date());
  const paths = resolveSparkPaths({ app: "daemon", sparkHome: input.sparkHome });
  const sessionRegistry = input.sessionRegistry ?? createDaemonSessionRegistry(input.sparkHome);
  const ctx = input.ctx;
  const emptyConfig = parseChannelsConfig({
    adapters: {},
    routes: {},
    ingress: { enabled: false, on_unbound: "create" },
  });
  const slot: GlobalChannelSlot = {
    configPath: channelConfigPath(paths),
    controller: null,
    service: null,
    pluginFiber: null,
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

  const createController = (
    config: ChannelsConfig,
    channels: ChannelsService,
  ): ChannelIngressController =>
    createChannelIngressController({
      sparkHome: input.sparkHome,
      config,
      hooks: input.hooks,
      sessionRegistry,
      channels,
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

  const persistConfig = async (config: ChannelsConfig): Promise<void> => {
    await mkdir(dirname(slot.configPath), { recursive: true, mode: 0o700 });
    writePrivateFile(slot.configPath, `${JSON.stringify(config, null, 2)}\n`);
  };

  const mountChannels = async (config: ChannelsConfig): Promise<void> => {
    let controller: ChannelIngressController | undefined;
    let service: ChannelsService | undefined;
    const createTransport: ChannelRegistryOptions["createTransport"] = (adapterId, adapterConfig) =>
      input.createDaemonTransport?.(adapterId, adapterConfig) ??
      input.createTransport?.(adapterId, adapterConfig);
    const fiber = ctx.plugin(
      createChannelsPlugin({
        ...(input.createTransport || input.createDaemonTransport ? { createTransport } : {}),
        onService: (next) => {
          service = next;
          controller = createController(config, next);
        },
        onMessage: (message) => {
          if (!controller) throw new Error("daemon Channel ingress is not bound");
          controller.receiveInbound(message);
        },
        onInteraction: async (event) => {
          if (!controller) throw new Error("daemon Channel interaction ingress is not bound");
          await controller.receiveInteraction(event);
        },
      }),
      config,
    );
    try {
      await fiber;
      if (!controller || !service)
        throw new Error("dsh-channel-transports did not publish ctx.channels");
    } catch (error) {
      await fiber.dispose().catch(() => undefined);
      throw error;
    }
    slot.controller = controller;
    slot.service = service;
    slot.pluginFiber = fiber;
  };

  const replace = async (
    config: ChannelsConfig | null,
    persist: boolean,
  ): Promise<DaemonChannelIngressStatus> => {
    const next = config ?? emptyConfig;
    try {
      if (!slot.service) {
        await mountChannels(next);
        if (persist && config) {
          try {
            await persistConfig(config);
          } catch (error) {
            await slot.pluginFiber?.dispose().catch(() => undefined);
            slot.controller = null;
            slot.service = null;
            slot.pluginFiber = null;
            throw error;
          }
        }
      } else {
        await slot.service.reload(
          next,
          persist && config ? () => persistConfig(config) : undefined,
        );
      }
    } catch (error) {
      slot.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    slot.config = config;
    slot.lastError = undefined;
    slot.lastReloadedAt = now().toISOString();
    return status();
  };

  let runtime!: DaemonChannelIngressRuntime;
  const requireController = (): ChannelIngressController => {
    if (!slot.controller || !slot.config) {
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
    beginDrain: () => slot.controller?.beginDrain(),
    drain: async () => await slot.controller?.drain(),
    close: async () => {
      qqbotQrAuth.stop();
      await serialize(async () => {
        const fiber = slot.pluginFiber;
        slot.pluginFiber = null;
        slot.service = null;
        slot.controller = null;
        await fiber?.dispose();
      });
    },
    stop: async () => {
      runtime.beginDrain?.();
      await runtime.drain?.();
      await runtime.close?.();
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
