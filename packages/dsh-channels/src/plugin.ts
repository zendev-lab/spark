import type { Context, Fiber, Plugin } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import type {
  ChannelAskRequest,
  ChannelAskSendResult,
  ChannelInteractionAckStatus,
} from "./interaction.ts";
import { ChannelRegistry, ChannelRegistryError, parseChannelsConfig } from "./registry.ts";
import type {
  ChannelDeliveryFacts,
  ChannelDeliveryResult,
  ChannelMessageSendInput,
  ChannelMessageTarget,
  ChannelReplyRecovery,
  ChannelReplySendInput,
  ChannelReplyStream,
  ChannelReplyTarget,
} from "./reply.ts";
import type {
  ChannelAdapterStatus,
  ChannelNotifyInput,
  ChannelNotifyResult,
  ChannelRegistryOptions,
  ChannelsConfig,
  IncomingMessage,
  ResolvedChannelRoute,
} from "./types.ts";

export const name = "dsh-channels";

export type Config = ChannelsConfig;

export const Config = z.transform(z.any(), (value) =>
  parseChannelsConfig(value),
) as unknown as NonNullable<Plugin.Object<Config>["Config"]>;

export interface DshChannelsPluginOptions {
  createTransport?: ChannelRegistryOptions["createTransport"];
  onMessage?: (message: IncomingMessage) => void;
  onInteraction?: ChannelRegistryOptions["onInteraction"];
  /** Bind ingress adapters before transports can emit their first event. */
  onService?: (service: ChannelsService) => void;
}

interface ChannelGeneration {
  readonly registry: ChannelRegistry;
  readonly fibers: Fiber[];
  readonly number: number;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    channels: ChannelsService;
  }

  interface Events {
    "channels/message"(message: IncomingMessage): void;
    "channels/interaction"(
      event: Parameters<NonNullable<ChannelRegistryOptions["onInteraction"]>>[0],
    ): void | Promise<void>;
  }
}

/** Typed Cordis service whose mutable pointer is the atomic generation switch. */
export class ChannelsService {
  private generation?: ChannelGeneration;
  private nextGeneration = 1;
  private readonly ctx: Context;
  private readonly options: DshChannelsPluginOptions;

  constructor(ctx: Context, options: DshChannelsPluginOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  get ingressEnabled(): boolean {
    return this.requireRegistry().ingressEnabled;
  }

  get onUnboundPolicy(): "reject" | "create" {
    return this.requireRegistry().onUnboundPolicy;
  }

  get generationNumber(): number {
    return this.generation?.number ?? 0;
  }

  listAdapters(): ChannelAdapterStatus[] {
    return this.requireRegistry().listAdapters();
  }

  listRoutes(): ResolvedChannelRoute[] {
    return this.requireRegistry().listRoutes();
  }

  resolveRoute(name: string): ResolvedChannelRoute {
    return this.requireRegistry().resolveRoute(name);
  }

  async notify(input: ChannelNotifyInput): Promise<ChannelNotifyResult> {
    return await this.requireRegistry().notify(input);
  }

  async openReplyStream(
    adapterId: string,
    target: ChannelReplyTarget,
    options: { onCreated?: (stream: ChannelReplyStream) => void | Promise<void> } = {},
  ): Promise<ChannelReplyStream | undefined> {
    return await this.requireRegistry().openReplyStream(adapterId, target, options);
  }

  messageDeliveryFacts(adapterId: string, target: ChannelMessageTarget): ChannelDeliveryFacts {
    return this.requireRegistry().messageDeliveryFacts(adapterId, target);
  }

  async sendMessage(
    adapterId: string,
    input: ChannelMessageSendInput,
  ): Promise<ChannelDeliveryResult> {
    return await this.requireRegistry().sendMessage(adapterId, input);
  }

  replyDeliveryFacts(adapterId: string, target: ChannelReplyTarget): ChannelDeliveryFacts {
    return this.requireRegistry().replyDeliveryFacts(adapterId, target);
  }

  async sendReply(adapterId: string, input: ChannelReplySendInput): Promise<ChannelDeliveryResult> {
    return await this.requireRegistry().sendReply(adapterId, input);
  }

  async recoverReply(
    adapterId: string,
    input: ChannelReplyTarget & {
      text: string;
      deliveryId: string;
      recovery: ChannelReplyRecovery;
    },
  ): Promise<void> {
    await this.requireRegistry().recoverReply(adapterId, input);
  }

  async sendAsk(
    adapterId: string,
    recipient: string,
    request: ChannelAskRequest,
  ): Promise<ChannelAskSendResult> {
    return await this.requireRegistry().sendAsk(adapterId, recipient, request);
  }

  async ackInteraction(
    adapterId: string,
    interactionId: string,
    status: ChannelInteractionAckStatus = "success",
  ): Promise<void> {
    await this.requireRegistry().ackInteraction(adapterId, interactionId, status);
  }

  async start(config: Config): Promise<void> {
    if (this.generation) throw new Error("dsh-channels service is already started");
    this.generation = await this.stage(config);
  }

  /**
   * Start and validate the replacement while the old generation is live.
   * Only a fully connected generation becomes visible through the service.
   */
  async reload(value: unknown, beforeCommit?: () => void | Promise<void>): Promise<void> {
    const config = parseChannelsConfig(value);
    const replacement = await this.stage(config);
    try {
      await beforeCommit?.();
    } catch (error) {
      await disposeGeneration(replacement);
      throw error;
    }
    const previous = this.generation;
    this.generation = replacement;
    if (previous) await disposeGeneration(previous);
  }

  async dispose(): Promise<void> {
    const generation = this.generation;
    this.generation = undefined;
    if (generation) await disposeGeneration(generation);
  }

  private async stage(config: Config): Promise<ChannelGeneration> {
    const registry = new ChannelRegistry({
      config,
      ...(this.options.createTransport ? { createTransport: this.options.createTransport } : {}),
      onMessage:
        this.options.onMessage ?? ((message) => this.ctx.emit("channels/message", message)),
      onInteraction:
        this.options.onInteraction ??
        (async (event) => await this.ctx.parallel("channels/interaction", event)),
    });
    const fibers: Fiber[] = [];
    const number = this.nextGeneration++;
    try {
      for (const status of registry.listAdapters()) {
        const adapter = registry.getAdapter(status.id);
        if (adapter?.runtimeCapable === false) continue;
        const fiber = this.ctx.plugin({
          name: `${name}/${status.id}`,
          async apply() {
            await registry.startAdapter(status.id);
            const started = registry.listAdapters().find((entry) => entry.id === status.id);
            if (!started?.running || started.state === "stopped" || started.state === "degraded") {
              throw new ChannelRegistryError(
                "adapter_unavailable",
                `adapter failed startup validation: ${status.id}`,
              );
            }
            return async () => await registry.stopAdapter(status.id);
          },
        });
        fibers.push(fiber);
        await fiber;
      }
      return { registry, fibers, number };
    } catch (error) {
      await disposeFibers(fibers);
      throw error;
    }
  }

  private requireRegistry(): ChannelRegistry {
    if (!this.generation) throw new Error("dsh-channels service is not active");
    return this.generation.registry;
  }
}

export function createChannelsPlugin(
  options: DshChannelsPluginOptions = {},
): Plugin.Object<Config> {
  return {
    name,
    Config,
    async apply(ctx, config) {
      const service = new ChannelsService(ctx, options);
      options.onService?.(service);
      await service.start(config);
      ctx.provide("channels", service);
      return async () => await service.dispose();
    },
  };
}

const defaultPlugin = createChannelsPlugin();

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  return await defaultPlugin.apply(ctx, config);
}

async function disposeGeneration(generation: ChannelGeneration): Promise<void> {
  await disposeFibers(generation.fibers);
}

async function disposeFibers(fibers: readonly Fiber[]): Promise<void> {
  const errors: unknown[] = [];
  for (const fiber of [...fibers].reverse()) {
    try {
      await fiber.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "failed to dispose channel fibers");
}
