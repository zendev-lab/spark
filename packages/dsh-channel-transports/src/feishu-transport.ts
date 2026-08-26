import { channelDeliveryNotSent } from "./reply.ts";
import type { ChannelDeliveryResult } from "./reply.ts";
import type {
  ChannelTransport,
  ChannelTransportStatus,
  FeishuAdapterConfig,
  FeishuInboundRaw,
} from "./types.ts";

const DEFAULT_FEISHU_READY_TIMEOUT_MS = 30_000;
const DEFAULT_FEISHU_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface FeishuSdkRuntime {
  start(onMessage: (message: FeishuInboundRaw) => void | Promise<void>): Promise<void>;
  stop(): void;
  send(recipient: string, text: string, deliveryId?: string): Promise<{ messageId?: string }>;
  status(): ChannelTransportStatus;
}

export interface FeishuTransportOptions {
  readyTimeoutMs?: number;
  createRuntime?: (
    config: FeishuAdapterConfig,
    readyTimeoutMs: number,
  ) => FeishuSdkRuntime | Promise<FeishuSdkRuntime>;
}

/**
 * Production Feishu transport backed by the official long-connection SDK.
 * Startup resolves only after the first WebSocket handshake succeeds; a
 * process being alive is never reported as a connected transport.
 */
export function createFeishuTransport(
  config: FeishuAdapterConfig,
  options: FeishuTransportOptions = {},
): ChannelTransport {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_FEISHU_READY_TIMEOUT_MS;
  let runtime: FeishuSdkRuntime | undefined;
  let running = false;
  const ensureRuntime = async (): Promise<FeishuSdkRuntime> => {
    runtime ??= await (options.createRuntime ?? createFeishuSdkRuntime)(config, readyTimeoutMs);
    return runtime;
  };

  return {
    async start(onMessage) {
      if (running) return;
      await (await ensureRuntime()).start(onMessage);
      running = true;
    },
    async stop() {
      if (!runtime || (!running && runtime.status().state === "stopped")) return;
      runtime.stop();
      running = false;
    },
    messageDeliveryFacts() {
      return { replaySafety: "deduplicated" };
    },
    async send(recipient, text, deliveryId): Promise<ChannelDeliveryResult> {
      if (!running) {
        throw channelDeliveryNotSent(new Error("Feishu transport is not connected"));
      }
      const receipt = await (await ensureRuntime()).send(recipient, text, deliveryId);
      return {
        replaySafety: "deduplicated",
        ...(receipt.messageId ? { receipt: { messageId: receipt.messageId } } : {}),
      };
    },
    status() {
      return runtime?.status() ?? { state: "stopped" };
    },
  };
}

async function createFeishuSdkRuntime(
  config: FeishuAdapterConfig,
  readyTimeoutMs: number,
): Promise<FeishuSdkRuntime> {
  const appId = config.app_id?.trim();
  const appSecret = config.app_secret?.trim();
  if (!appId || !appSecret) {
    throw new Error("Feishu requires app_id and app_secret");
  }
  const { Client, Domain, EventDispatcher, LoggerLevel, WSClient } =
    await import("@larksuiteoapi/node-sdk");

  const client = new Client({
    appId,
    appSecret,
    domain: Domain.Feishu,
    loggerLevel: LoggerLevel.warn,
  });
  let state: ChannelTransportStatus = { state: "stopped" };
  let ready: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const ws = new WSClient({
    appId,
    appSecret,
    domain: Domain.Feishu,
    loggerLevel: LoggerLevel.warn,
    autoReconnect: true,
    handshakeTimeoutMs: DEFAULT_FEISHU_HANDSHAKE_TIMEOUT_MS,
    onReady: () => {
      state = { state: "connected" };
      ready?.();
    },
    onError: (error) => {
      state = { state: "degraded", error: error.message };
      failed?.(error);
    },
    onReconnecting: () => {
      state = { state: "reconnecting" };
    },
    onReconnected: () => {
      state = { state: "connected" };
    },
  });

  return {
    async start(onMessage) {
      state = { state: "connecting" };
      const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
        "im.message.receive_v1": async (event) => {
          const normalized = normalizeFeishuMessageEvent(event);
          if (normalized) await onMessage(normalized);
        },
      });
      const connected = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      });
      await ws.start({ eventDispatcher: dispatcher });
      try {
        await withTimeout(connected, readyTimeoutMs, "Feishu WebSocket readiness timed out");
      } catch (error) {
        ws.close({ force: true });
        const detail = error instanceof Error ? error.message : String(error);
        state = { state: "degraded", error: detail };
        throw error;
      } finally {
        ready = undefined;
        failed = undefined;
      }
    },
    stop() {
      ws.close({ force: true });
      state = { state: "stopped" };
    },
    async send(recipient, text, deliveryId) {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: recipient,
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(deliveryId ? { uuid: deliveryId } : {}),
        },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(
          `Feishu message create failed code=${response.code} msg=${response.msg ?? ""}`,
        );
      }
      return { messageId: response.data?.message_id };
    },
    status() {
      return state;
    },
  };
}

export function normalizeFeishuMessageEvent(value: unknown): FeishuInboundRaw | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const message = asRecord(event.message);
  const sender = asRecord(event.sender);
  const senderId = asRecord(sender.sender_id);
  const chatId = stringValue(message.chat_id);
  const messageId = stringValue(message.message_id);
  if (!chatId || !messageId || stringValue(message.message_type) !== "text") return undefined;
  const content = parseTextContent(message.content);
  if (content === undefined) return undefined;
  const parentId = stringValue(message.parent_id);
  return {
    chat_id: chatId,
    text: content,
    message_id: messageId,
    ...(stringValue(senderId.open_id) ? { sender_id: stringValue(senderId.open_id) } : {}),
    ...(parentId ? { message_reference: { messageId: parentId, source: "unknown" as const } } : {}),
  };
}

function parseTextContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const text = (parsed as Record<string, unknown>).text;
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
