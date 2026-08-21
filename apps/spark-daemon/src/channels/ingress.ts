/**
 * Channel ingress wiring for Spark daemon.
 *
 * Adapters deliver IncomingMessage → daemon Session resolve/bind → assignment.create
 * normalized onto session.run / task.start. Adapters never own session tables.
 *
 * Config is daemon-global at `<paths.configDir>/channels.json`.
 */

import {
  channelDeliveryNotSent,
  ChannelRegistry,
  mergeChannelMessageReference,
  normalizeChannelMessageReference,
  parseChannelsConfig,
  type ChannelAdapterType,
  type ChannelAskRequest,
  type ChannelAskSendResult,
  type ChannelDeliveryFacts,
  type ChannelDeliveryResult,
  type ChannelInteractionAckStatus,
  type ChannelMessageSendInput,
  type ChannelMessageTarget,
  type ChannelNotifyInput,
  type ChannelNotifyResult,
  type ChannelRegistryOptions,
  type ChannelReplyRecovery,
  type ChannelReplySendInput,
  type ChannelReplyStream,
  type ChannelReplyTarget,
  type ChannelsConfig,
  type IncomingMessage,
  type RoutedChannelInteractionEvent,
} from "@zendev-lab/dsh-channels";
import {
  parseSparkAssignment,
  type SparkAssignment,
  type SparkMessageView,
  type SparkQqbotQrAuthFlow,
  type SparkSessionState,
} from "@zendev-lab/spark-protocol";
import { loadSparkSessionSnapshot } from "@zendev-lab/spark-session";
import { channelConfigPath, resolveSparkPaths } from "@zendev-lab/spark-system";
import { createHash, randomUUID } from "node:crypto";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "../session-registry.ts";
import type { SparkDaemonChannelContext } from "../core/types.ts";
import type { DaemonChannelTransportFactory } from "./transport-factory.ts";

export const CHANNEL_INGRESS_FAILURE_REPLY = "消息暂时无法处理，请稍后重试。";

export interface ChannelIngressAssignment {
  sessionId: string;
  goal: string;
  assignment: SparkAssignment;
  source: { kind: "channel"; channel: "feishu" | "infoflow" | "qqbot"; externalRef?: string };
  externalKey: string;
  /** Rename-stable provider account identity; never a local adapter routing label. */
  adapterAccountIdentity?: string;
  channelReply: {
    /** Platform semantics; adapterId remains the configured instance route. */
    adapter: ChannelAdapterType;
    adapterId: string;
    externalKey: string;
    recipient: string;
  };
  /** Platform facts for this inbound turn, kept out of the canonical user message body. */
  channelContext?: SparkDaemonChannelContext;
}

export interface ChannelIngressHooks {
  onAssignment: (input: ChannelIngressAssignment) => Promise<void | "duplicate">;
  /** Persist an admission-failure reply before considering the inbound handled. */
  onRejectedReply?: (input: ChannelIngressRejectedReply) => Promise<void>;
  /** Persist normalized ingress before session resolution and task admission. */
  onInboundReceived?: (input: { message: IncomingMessage }) => void;
  onReply?: (input: { externalKey: string; text: string; adapterId: string }) => Promise<void>;
  onInteraction?: (input: { event: RoutedChannelInteractionEvent }) => Promise<void>;
  /**
   * Optional text-ask settlement for adapters without native interaction events.
   * Return "settled" to suppress ordinary turn admission for this inbound.
   */
  onTextAskReply?: (input: {
    message: IncomingMessage;
    recipient: string;
  }) => Promise<"settled" | "continue">;
}

export interface ChannelIngressRejectedReply {
  sessionId: string;
  externalKey: string;
  adapterAccountIdentity: string;
  adapterId: string;
  target: ChannelReplyTarget;
  text: string;
  /** Stable for platform redelivery when the inbound message has an id. */
  deliveryIdentity: string;
  deliveryFacts: ChannelDeliveryFacts;
  send(deliveryId: string): Promise<ChannelDeliveryResult>;
}

export interface ChannelIngressController {
  start(): Promise<void>;
  stop(): Promise<void>;
  admitInbound(message: IncomingMessage): Promise<void>;
  notify(input: ChannelNotifyInput): Promise<ChannelNotifyResult>;
  openReplyStream(
    adapterId: string,
    target: ChannelReplyTarget,
    options?: { onCreated?: (stream: ChannelReplyStream) => void | Promise<void> },
  ): Promise<ChannelReplyStream | undefined>;
  messageDeliveryFacts(adapterId: string, target: ChannelMessageTarget): ChannelDeliveryFacts;
  sendMessage(adapterId: string, input: ChannelMessageSendInput): Promise<ChannelDeliveryResult>;
  sendReply(adapterId: string, input: ChannelReplySendInput): Promise<ChannelDeliveryResult | void>;
  resolveAdapterId(adapterId: string, adapterAccountIdentity?: string): string;
  replyDeliveryFacts(adapterId: string, target: ChannelReplyTarget): ChannelDeliveryFacts;
  recoverReply(
    adapterId: string,
    input: ChannelReplyTarget & {
      text: string;
      deliveryId: string;
      recovery: ChannelReplyRecovery;
    },
  ): Promise<void>;
  sendAsk(
    adapterId: string,
    recipient: string,
    request: ChannelAskRequest,
  ): Promise<ChannelAskSendResult>;
  ackInteraction(
    adapterId: string,
    interactionId: string,
    status?: ChannelInteractionAckStatus,
  ): Promise<void>;
  status(): {
    configured: boolean;
    ingressEnabled: boolean;
    adapters: Array<{
      id: string;
      type: string;
      adapterAccountIdentity?: string;
      running: boolean;
      state: "stopped" | "connecting" | "connected" | "reconnecting" | "degraded";
      error?: string;
    }>;
    routes: Array<{ name: string; adapter: string; recipient: string }>;
  };
}

export interface DaemonChannelIngressStatus {
  plane: "daemon";
  resource: "channel";
  configPath: string;
  available: true;
  configured: boolean;
  ingressEnabled: boolean;
  state: "unconfigured" | "running" | "stopped" | "degraded";
  adapters: Array<{
    id: string;
    type: string;
    adapterAccountIdentity?: string;
    running: boolean;
    state: "stopped" | "connecting" | "connected" | "reconnecting" | "degraded";
    error?: string;
  }>;
  routes: Array<{ name: string; adapter: string; recipient: string }>;
  lastReloadedAt?: string;
  error?: string;
  observedAt: string;
  text: string;
}

/**
 * Stable daemon-owned Channel control surface shared by startup and local RPC.
 */
export interface DaemonChannelIngressRuntime {
  start(): Promise<DaemonChannelIngressStatus>;
  stop(): Promise<void>;
  admitInbound?(message: IncomingMessage): Promise<void>;
  status(): DaemonChannelIngressStatus;
  configure(config: unknown): Promise<DaemonChannelIngressStatus>;
  reload(): Promise<DaemonChannelIngressStatus>;
  startQqbotQrAuth(): Promise<SparkQqbotQrAuthFlow>;
  qqbotQrAuthStatus(flowId: string): SparkQqbotQrAuthFlow;
  cancelQqbotQrAuth(flowId: string): SparkQqbotQrAuthFlow;
  notify(input: ChannelNotifyInput): Promise<ChannelNotifyResult>;
  openReplyStream(
    adapterId: string,
    target: ChannelReplyTarget,
    options?: { onCreated?: (stream: ChannelReplyStream) => void | Promise<void> },
  ): Promise<ChannelReplyStream | undefined>;
  sendMessage(adapterId: string, input: ChannelMessageSendInput): Promise<ChannelDeliveryResult>;
  sendReply(adapterId: string, input: ChannelReplySendInput): Promise<ChannelDeliveryResult | void>;
  resolveAdapterId(adapterId: string, adapterAccountIdentity?: string): string;
  replyDeliveryFacts(adapterId: string, target: ChannelReplyTarget): ChannelDeliveryFacts;
  messageDeliveryFacts(adapterId: string, target: ChannelMessageTarget): ChannelDeliveryFacts;
  recoverReply(
    adapterId: string,
    input: ChannelReplyTarget & {
      text: string;
      deliveryId: string;
      recovery: ChannelReplyRecovery;
    },
  ): Promise<void>;
  sendAsk(
    adapterId: string,
    recipient: string,
    request: ChannelAskRequest,
  ): Promise<ChannelAskSendResult>;
  ackInteraction(
    adapterId: string,
    interactionId: string,
    status?: ChannelInteractionAckStatus,
  ): Promise<void>;
  /** Install the daemon-owned native interaction router after construction. */
  setInteractionHandler?(handler?: ChannelIngressHooks["onInteraction"]): void;
  /** Install the text-ask settlement path for adapters without native controls. */
  setTextAskHandler?(handler?: ChannelIngressHooks["onTextAskReply"]): void;
  /** Install a daemon-owned durable ingress receipt before transports start. */
  setInboundHandler?(handler?: ChannelIngressHooks["onInboundReceived"]): void;
}

export async function loadDaemonChannelsConfig(
  sparkHome: string,
): Promise<{ path: string; config: ChannelsConfig | null }> {
  const path = channelConfigPath(resolveSparkPaths({ app: "daemon", sparkHome }));
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return { path, config: parseChannelsConfig(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, config: null };
    }
    throw error;
  }
}

export function createChannelIngressController(input: {
  sparkHome: string;
  config: ChannelsConfig;
  hooks: ChannelIngressHooks;
  sessionRegistry?: Pick<DaemonSessionRegistry, "resolveChannelSession"> &
    Partial<Pick<DaemonSessionRegistry, "get" | "recordTurnQueued" | "recordTurnSettled">>;
  createTransport?: ChannelRegistryOptions["createTransport"];
  createDaemonTransport?: DaemonChannelTransportFactory;
}): ChannelIngressController {
  const sessionRegistry = input.sessionRegistry ?? createDaemonSessionRegistry(input.sparkHome);
  const activeHandlers = new Set<Promise<void>>();
  const trackHandler = (
    operation: Promise<void>,
    label: "inbound" | "interaction",
  ): Promise<void> => {
    // Observe failures for drain/diagnostics without replacing the original
    // rejecting promise returned to transports. QQ uses that rejection to
    // avoid advancing its resume sequence before durable settlement.
    const tracked = operation.then(
      () => undefined,
      (error) => {
        console.error(`[dsh-channels] ${label} failed`, error);
      },
    );
    activeHandlers.add(tracked);
    void tracked.finally(() => activeHandlers.delete(tracked));
    return operation;
  };
  const waitForHandlers = async () => {
    while (activeHandlers.size > 0) {
      await Promise.all([...activeHandlers]);
    }
  };
  const channelRegistry = new ChannelRegistry({
    config: input.config,
    ...(input.createTransport || input.createDaemonTransport
      ? {
          createTransport: (adapterId, config) =>
            input.createDaemonTransport?.(adapterId, config) ??
            input.createTransport?.(adapterId, config),
        }
      : {}),
    onMessage: (message) => {
      if (Object.keys(input.config.adapters).length === 0 || !message.text.trim()) return;
      // A daemon persistence hook is intentionally invoked before converting
      // to a Promise. Synchronous SQLite failures propagate to transports so
      // an SDK must not ACK an event that never acquired a durable receipt.
      if (input.hooks.onInboundReceived) {
        input.hooks.onInboundReceived({ message });
        return;
      }
      void trackHandler(handleInbound(message), "inbound");
    },
    onInteraction: (event) =>
      trackHandler(input.hooks.onInteraction?.({ event }) ?? Promise.resolve(), "interaction"),
  });

  async function handleInbound(message: IncomingMessage): Promise<void> {
    if (Object.keys(input.config.adapters).length === 0) return;
    if (!message.text.trim()) return;
    const replyRecipient = channelReplyRecipient(message);
    if (!replyRecipient) {
      throw new Error(`channel inbound missing reply recipient: ${message.externalKey}`);
    }
    if (input.hooks.onTextAskReply) {
      const textAsk = await input.hooks.onTextAskReply({
        message,
        recipient: replyRecipient,
      });
      if (textAsk === "settled") return;
    }
    const incomingAdapter = resolveIncomingAdapter(message, channelRegistry.listAdapters());
    const session = await sessionRegistry.resolveChannelSession({
      externalKey: message.externalKey,
      adapterId: incomingAdapter.adapterId,
      adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
      allowLegacyAccountClaim: incomingAdapter.sameTypeAccountCount === 1,
      onUnbound: input.config.ingress?.on_unbound ?? "create",
      name: channelSessionTitle(message),
    });
    const enrichedMessage = await enrichInboundMessageReferenceFromSession({
      message,
      session,
      getSession: sessionRegistry.get?.bind(sessionRegistry),
      sparkHome: input.sparkHome,
    });
    const channel = enrichedMessage.adapter;
    const rawGoal = enrichedMessage.text.trim();
    const assignment = parseSparkAssignment({
      goal: rawGoal,
      target: { sessionId: session.sessionId },
      source: {
        kind: "channel",
        channel,
        ...(enrichedMessage.messageId ? { externalRef: enrichedMessage.messageId } : {}),
      },
    });
    let admission: void | "duplicate";
    try {
      admission = await input.hooks.onAssignment({
        sessionId: session.sessionId,
        goal: assignment.goal,
        assignment,
        source: {
          kind: "channel",
          channel,
          ...(enrichedMessage.messageId ? { externalRef: enrichedMessage.messageId } : {}),
        },
        externalKey: enrichedMessage.externalKey,
        adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
        channelReply: {
          adapter: channel,
          adapterId: incomingAdapter.adapterId,
          externalKey: enrichedMessage.externalKey,
          recipient: replyRecipient,
        },
        channelContext: channelContextFromIncoming(enrichedMessage),
      });
    } catch (error) {
      try {
        const target: ChannelReplyTarget = {
          recipient: replyRecipient,
          ...(enrichedMessage.senderId?.trim()
            ? { senderId: enrichedMessage.senderId.trim() }
            : {}),
          ...(enrichedMessage.messageId?.trim()
            ? { messageId: enrichedMessage.messageId.trim() }
            : {}),
          ...(rawGoal ? { preview: rawGoal.slice(0, 240) } : {}),
        };
        const deliveryIdentity = channelFailureReplyDeliveryId({
          ...enrichedMessage,
          adapterId: incomingAdapter.adapterId,
          adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
        });
        const rejectedReply: ChannelIngressRejectedReply = {
          sessionId: session.sessionId,
          externalKey: message.externalKey,
          adapterAccountIdentity: incomingAdapter.adapterAccountIdentity,
          adapterId: incomingAdapter.adapterId,
          target,
          text: CHANNEL_INGRESS_FAILURE_REPLY,
          deliveryIdentity,
          deliveryFacts: channelRegistry.replyDeliveryFacts(incomingAdapter.adapterId, target),
          send: async (deliveryId) =>
            await channelRegistry.sendReply(incomingAdapter.adapterId, {
              ...target,
              text: CHANNEL_INGRESS_FAILURE_REPLY,
              deliveryId,
            }),
        };
        if (input.hooks.onRejectedReply) {
          // Production persists this intent in the generic channel outbox.
          // Once durable, this inbound is handled and must not be retried.
          await input.hooks.onRejectedReply(rejectedReply);
        } else {
          await rejectedReply.send(deliveryIdentity);
        }
        return;
      } catch (replyError) {
        console.error("[dsh-channels] failed to report rejected inbound", replyError);
      }
      throw error;
    }
    if (admission !== "duplicate") {
      // Update the visible session state only after durable admission. A
      // platform redelivery may refer to an invocation that is still running;
      // toggling running -> ready around that duplicate would hide the real
      // in-flight turn from Hub. Registry projection failure is advisory:
      // the invocation is already durable and must not receive a false failure
      // reply merely because its visible status could not be updated.
      try {
        await sessionRegistry.recordTurnQueued?.(session.sessionId);
      } catch (error) {
        console.error("[dsh-channels] failed to mark admitted inbound as queued", error);
      }
    }
  }

  return {
    start: async () => {
      await channelRegistry.startAll();
    },
    stop: async () => {
      let stopError: unknown;
      try {
        await channelRegistry.stopAll();
      } catch (error) {
        stopError = error;
      }
      await waitForHandlers();
      if (stopError) throw stopError;
    },
    admitInbound: handleInbound,
    notify: async (notifyInput) => await channelRegistry.notify(notifyInput),
    openReplyStream: async (adapterId, target, options) =>
      await channelRegistry.openReplyStream(adapterId, target, options),
    messageDeliveryFacts: (adapterId, target) =>
      channelRegistry.messageDeliveryFacts(adapterId, target),
    sendMessage: async (adapterId, messageInput) =>
      await channelRegistry.sendMessage(adapterId, messageInput),
    sendReply: async (adapterId, replyInput) =>
      await channelRegistry.sendReply(adapterId, replyInput),
    resolveAdapterId: (adapterId, adapterAccountIdentity) =>
      resolveControllerAdapterId(channelRegistry, adapterId, adapterAccountIdentity),
    replyDeliveryFacts: (adapterId, target) =>
      channelRegistry.replyDeliveryFacts(adapterId, target),
    recoverReply: async (adapterId, replyInput) =>
      await channelRegistry.recoverReply(adapterId, replyInput),
    sendAsk: async (adapterId, recipient, request) =>
      await channelRegistry.sendAsk(adapterId, recipient, request),
    ackInteraction: async (adapterId, interactionId, status) =>
      await channelRegistry.ackInteraction(adapterId, interactionId, status),
    status: () => ({
      configured: true,
      ingressEnabled: channelRegistry.ingressEnabled,
      adapters: channelRegistry.listAdapters(),
      routes: channelRegistry.listRoutes().map((route) => ({
        name: route.name,
        adapter: route.adapterId,
        recipient: route.recipient,
      })),
    }),
  };
}

/**
 * Durable platform admission key. Only a platform-issued message id is stable
 * enough to deduplicate across daemon restarts; message text is intentionally
 * excluded so identical intentional messages remain distinct.
 */
export function channelIngressIdempotencyKey(
  assignment: ChannelIngressAssignment,
): string | undefined {
  const messageId = channelIngressMessageId(assignment);
  if (!messageId) return undefined;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        3,
        assignment.source.channel,
        assignment.adapterAccountIdentity,
        assignment.externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel-ingress:v3:${digest}`;
}

/** Read-only key for invocations admitted before stable account identities. */
export function channelIngressLegacyIdempotencyKey(
  assignment: ChannelIngressAssignment,
): string | undefined {
  const messageId = channelIngressMessageId(assignment);
  if (!messageId) return undefined;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        assignment.channelReply.adapterId,
        assignment.source.channel,
        assignment.externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel-ingress:${digest}`;
}

function channelIngressMessageId(assignment: ChannelIngressAssignment): string | undefined {
  return assignment.source.externalRef?.trim() || assignment.channelContext?.messageId?.trim();
}

export function channelFailureReplyDeliveryId(message: IncomingMessage): string {
  const messageId = message.messageId?.trim();
  if (!messageId) return `channel-ingress-failure:${randomUUID()}`;
  const adapterAccountIdentity = message.adapterAccountIdentity?.trim();
  if (!adapterAccountIdentity) {
    throw new Error("adapterAccountIdentity is required for channel failure delivery identity");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        3,
        "rejected",
        message.adapter,
        adapterAccountIdentity,
        message.externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel-ingress-failure:${digest}`;
}

type IngressAdapterStatus = ReturnType<ChannelRegistry["listAdapters"]>[number];

function resolveIncomingAdapter(
  message: IncomingMessage,
  adapters: IngressAdapterStatus[],
): {
  adapterId: string;
  adapterAccountIdentity: string;
  sameTypeAccountCount: number;
} {
  const sameType = adapters.filter((adapter) => adapter.type === message.adapter);
  const requestedId = message.adapterId?.trim();
  const requestedIdentity = message.adapterAccountIdentity?.trim();
  let selected: IngressAdapterStatus | undefined;

  if (requestedIdentity) {
    const matches = sameType.filter(
      (adapter) => adapter.adapterAccountIdentity === requestedIdentity,
    );
    if (matches.length !== 1) {
      throw channelDeliveryNotSent(
        new Error(
          matches.length === 0
            ? `channel provider account is not configured (previous adapter ${requestedId || message.adapter})`
            : `channel provider account is ambiguous: ${matches
                .map((adapter) => adapter.id)
                .sort()
                .join(", ")}`,
        ),
      );
    }
    selected = matches[0];
  } else if (requestedId) {
    selected = sameType.find((adapter) => adapter.id === requestedId);
  } else if (sameType.length === 1) {
    // Compatibility for inbound rows persisted before adapter instance facts.
    selected = sameType[0];
  }

  if (!selected && !requestedIdentity && requestedId === message.adapter && sameType.length === 1) {
    selected = sameType[0];
  }
  if (!selected) {
    throw channelDeliveryNotSent(
      new Error(
        sameType.length > 1
          ? `legacy ${message.adapter} inbound is ambiguous across adapters: ${sameType
              .map((adapter) => adapter.id)
              .sort()
              .join(", ")}`
          : `channel adapter is not configured: ${requestedId || message.adapter}`,
      ),
    );
  }
  const adapterAccountIdentity = selected.adapterAccountIdentity?.trim();
  if (!adapterAccountIdentity) {
    throw channelDeliveryNotSent(
      new Error(`channel adapter ${selected.id} has no stable provider account identity`),
    );
  }
  return {
    adapterId: selected.id,
    adapterAccountIdentity,
    sameTypeAccountCount: sameType.length,
  };
}

function resolveControllerAdapterId(
  registry: Pick<ChannelRegistry, "listAdapters">,
  legacyAdapterId: string,
  adapterAccountIdentity?: string,
): string {
  const adapters = registry.listAdapters();
  const fallbackId = legacyAdapterId.trim();
  if (!fallbackId) throw channelDeliveryNotSent(new Error("channel adapter id is required"));
  const stableIdentity = adapterAccountIdentity?.trim();
  if (stableIdentity) {
    const matches = adapters.filter((adapter) => adapter.adapterAccountIdentity === stableIdentity);
    if (matches.length === 1) return matches[0]!.id;
    throw channelDeliveryNotSent(
      new Error(
        matches.length === 0
          ? `channel provider account is not configured (previous adapter ${fallbackId})`
          : `channel provider account is ambiguous: ${matches
              .map((adapter) => adapter.id)
              .sort()
              .join(", ")}`,
      ),
    );
  }

  if (adapters.some((adapter) => adapter.id === fallbackId)) return fallbackId;
  const sameType = adapters.filter((adapter) => adapter.type === fallbackId);
  if (sameType.length === 1) return sameType[0]!.id;
  throw channelDeliveryNotSent(
    new Error(
      sameType.length > 1
        ? `legacy channel adapter ${fallbackId} is ambiguous: ${sameType
            .map((adapter) => adapter.id)
            .sort()
            .join(", ")}`
        : `channel adapter is not configured: ${fallbackId}`,
    ),
  );
}

function channelContextFromIncoming(message: IncomingMessage): SparkDaemonChannelContext {
  return {
    externalKey: message.externalKey,
    ...(message.senderId?.trim() ? { senderId: message.senderId.trim() } : {}),
    ...(message.senderName?.trim() ? { senderName: message.senderName.trim() } : {}),
    ...(message.chatId?.trim() ? { chatId: message.chatId.trim() } : {}),
    ...(message.messageId?.trim() ? { messageId: message.messageId.trim() } : {}),
    ...(message.messageReference ? { messageReference: message.messageReference } : {}),
    ...(message.eventType?.trim() ? { eventType: message.eventType.trim() } : {}),
    ...(message.contentType?.trim() ? { contentType: message.contentType.trim() } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.mentions?.length
      ? { mentions: message.mentions.map((entry) => entry.trim()).filter(Boolean) }
      : {}),
    ...(typeof message.mentionedSelf === "boolean" ? { mentionedSelf: message.mentionedSelf } : {}),
  };
}

export async function enrichInboundMessageReferenceFromSession(input: {
  message: IncomingMessage;
  session: SparkSessionState;
  getSession?: (sessionId: string) => Promise<SparkSessionState | undefined>;
  sparkHome: string;
}): Promise<IncomingMessage> {
  const reference = normalizeChannelMessageReference(input.message.messageReference);
  if (!reference?.messageId?.trim() || reference.preview?.trim()) {
    return reference && reference !== input.message.messageReference
      ? { ...input.message, messageReference: reference }
      : input.message;
  }
  try {
    const record =
      (input.getSession ? await input.getSession(input.session.sessionId) : undefined) ??
      input.session;
    const paths = resolveSparkPaths({ app: "daemon", sparkHome: input.sparkHome });
    const sessionsRoot = paths.sessionRuntimeDir
      ? join(paths.sessionRuntimeDir, "sessions")
      : join(input.sparkHome, "sessions");
    const snapshot = await loadSparkSessionSnapshot({
      sessionsRoot,
      session: record,
    });
    const preview = findChannelMessagePreviewById(snapshot.messages, reference.messageId);
    if (!preview) return { ...input.message, messageReference: reference };
    return {
      ...input.message,
      messageReference: mergeChannelMessageReference(reference, {
        ...reference,
        preview,
        source: "session",
      }),
    };
  } catch {
    return { ...input.message, messageReference: reference };
  }
}

export function findChannelMessagePreviewById(
  messages: readonly SparkMessageView[],
  platformMessageId: string,
): string | undefined {
  const target = platformMessageId.trim();
  if (!target) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const channel =
      message.metadata &&
      typeof message.metadata === "object" &&
      !Array.isArray(message.metadata) &&
      "channel" in message.metadata &&
      message.metadata.channel &&
      typeof message.metadata.channel === "object" &&
      !Array.isArray(message.metadata.channel)
        ? (message.metadata.channel as Record<string, unknown>)
        : undefined;
    if (typeof channel?.messageId === "string" && channel.messageId.trim() === target) {
      const text = message.text.trim();
      if (text) return text;
    }
  }
  return undefined;
}

function channelReplyRecipient(message: IncomingMessage): string | undefined {
  switch (message.adapter) {
    case "infoflow": {
      if (message.externalKey.startsWith("infoflow:group:") && message.chatId?.trim()) {
        return `group:${message.chatId.trim()}`;
      }
      return message.senderId?.trim() || undefined;
    }
    case "feishu":
      return message.chatId?.trim() || undefined;
    case "qqbot": {
      if (message.externalKey.startsWith("qqbot:group:") && message.chatId?.trim()) {
        return `group:${message.chatId.trim()}`;
      }
      if (message.externalKey.startsWith("qqbot:channel:") && message.chatId?.trim()) {
        return `channel:${message.chatId.trim()}`;
      }
      const openid = message.senderId?.trim();
      return openid ? `c2c:${openid}` : undefined;
    }
    default: {
      const unexpected: never = message.adapter;
      throw new Error(`unsupported channel adapter: ${String(unexpected)}`);
    }
  }
}

/** Platform-owned identity; Hub renders the technical key with adapter/scope labels. */
function channelSessionTitle(message: IncomingMessage): string {
  if (message.adapter === "qqbot" && message.externalKey.startsWith("qqbot:c2c:")) {
    const label = message.senderName?.trim();
    if (label) return `channel qqbot:c2c:${label}`;
  }
  return `channel ${message.externalKey}`;
}

export { createDaemonChannelIngressRuntime } from "./global-ingress-runtime.ts";
