import type { ChannelsConfig, QqbotAdapterConfig } from "@zendev-lab/dsh-channels";
import { startQqbotQrAuth, type QqbotQrCredentials } from "@zendev-lab/dsh-channels/qqbot-auth";
import {
  createId,
  parseSparkQqbotQrAuthFlow,
  type SparkQqbotQrAuthFlow,
  type SparkQqbotQrAuthReason,
} from "@zendev-lab/spark-protocol";

const DEFAULT_QQBOT_QR_AUTH_LIFETIME_MS = 10 * 60_000;

export interface DaemonQqbotQrAuthManager {
  start(): Promise<SparkQqbotQrAuthFlow>;
  status(flowId: string): SparkQqbotQrAuthFlow;
  cancel(flowId: string): SparkQqbotQrAuthFlow;
  stop(): void;
}

interface PendingQqbotQrAuth {
  flow: SparkQqbotQrAuthFlow;
  dispose(): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolveStarted(flow: SparkQqbotQrAuthFlow): void;
  startedSettled: boolean;
}

export function createDaemonQqbotQrAuthManager(options: {
  loadConfig(): Promise<ChannelsConfig | null>;
  configure(config: ChannelsConfig): Promise<unknown>;
  startAuth?: typeof startQqbotQrAuth;
  now?: () => Date;
  lifetimeMs?: number;
}): DaemonQqbotQrAuthManager {
  const startAuth = options.startAuth ?? startQqbotQrAuth;
  const now = options.now ?? (() => new Date());
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_QQBOT_QR_AUTH_LIFETIME_MS;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1) {
    throw new RangeError("QQ Bot QR auth lifetime must be a positive safe integer.");
  }

  const sessions = new Map<string, PendingQqbotQrAuth>();
  let stopped = false;

  const clearSessionTimer = (session: PendingQqbotQrAuth): void => {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  };

  const scheduleRemoval = (session: PendingQqbotQrAuth): void => {
    clearSessionTimer(session);
    session.timer = setTimeout(() => {
      if (sessions.get(session.flow.id) === session) sessions.delete(session.flow.id);
    }, lifetimeMs);
    session.timer.unref?.();
  };

  const setFlow = (
    session: PendingQqbotQrAuth,
    patch: Partial<SparkQqbotQrAuthFlow>,
  ): SparkQqbotQrAuthFlow => {
    session.flow = parseSparkQqbotQrAuthFlow({
      ...session.flow,
      ...patch,
      updatedAt: now().toISOString(),
    });
    return publicFlow(session.flow);
  };

  const settleStarted = (session: PendingQqbotQrAuth): void => {
    if (session.startedSettled) return;
    session.startedSettled = true;
    session.resolveStarted(publicFlow(session.flow));
  };

  const fail = (session: PendingQqbotQrAuth, reason: SparkQqbotQrAuthReason): void => {
    if (session.flow.status !== "pending" && session.flow.status !== "saving") return;
    session.dispose();
    setFlow(session, {
      status: "failed",
      reason,
      qrCodeUrl: undefined,
    });
    settleStarted(session);
    scheduleRemoval(session);
  };

  const persist = async (
    session: PendingQqbotQrAuth,
    credentials: QqbotQrCredentials[],
  ): Promise<void> => {
    if (stopped || session.flow.status !== "saving") return;
    if (credentials.length !== 1) {
      fail(session, "credentials_invalid");
      return;
    }
    const credential = credentials[0];
    if (!credential?.appId.trim() || !credential.clientSecret.trim()) {
      fail(session, "credentials_invalid");
      return;
    }

    try {
      const current = await options.loadConfig();
      if (stopped || session.flow.status !== "saving") return;
      const config = mergeQqbotQrCredentials(current, credential);
      await options.configure(config);
      if (stopped || session.flow.status !== "saving") return;
      setFlow(session, {
        status: "succeeded",
        appId: credential.appId.trim(),
        reason: undefined,
      });
      scheduleRemoval(session);
    } catch {
      fail(session, "configuration_failed");
    }
  };

  return {
    async start() {
      if (stopped) throw new Error("QQ Bot QR authentication manager is stopped.");

      for (const session of sessions.values()) {
        if (session.flow.status === "saving") {
          throw new Error("QQ Bot QR credentials are still being saved.");
        }
        if (session.flow.status !== "pending") continue;
        session.dispose();
        setFlow(session, { status: "cancelled", qrCodeUrl: undefined });
        settleStarted(session);
        scheduleRemoval(session);
      }

      const timestamp = now().toISOString();
      let resolveStarted!: (flow: SparkQqbotQrAuthFlow) => void;
      const started = new Promise<SparkQqbotQrAuthFlow>((resolve) => {
        resolveStarted = resolve;
      });
      const session: PendingQqbotQrAuth = {
        flow: parseSparkQqbotQrAuthFlow({
          id: createId("qrauth"),
          status: "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        dispose: () => undefined,
        timer: undefined,
        resolveStarted,
        startedSettled: false,
      };
      session.timer = setTimeout(() => fail(session, "expired"), lifetimeMs);
      session.timer.unref?.();
      sessions.set(session.flow.id, session);

      try {
        session.dispose = startAuth(
          {
            onQrCode: (url) => {
              if (session.flow.status !== "pending") return;
              setFlow(session, { qrCodeUrl: url, reason: undefined });
              settleStarted(session);
            },
            onQrExpired: () => {
              if (session.flow.status === "pending") {
                setFlow(session, { qrCodeUrl: undefined });
              }
            },
            onSuccess: (credentials) => {
              if (session.flow.status !== "pending") return;
              clearSessionTimer(session);
              setFlow(session, { status: "saving", qrCodeUrl: undefined });
              settleStarted(session);
              void persist(session, credentials);
            },
            onFailure: () => fail(session, "binding_failed"),
          },
          { source: "spark" },
        );
        if (session.flow.status !== "pending") session.dispose();
      } catch {
        fail(session, "start_failed");
      }

      return await started;
    },

    status(flowId) {
      return publicFlow(requireSession(sessions, flowId).flow);
    },

    cancel(flowId) {
      const session = requireSession(sessions, flowId);
      if (session.flow.status !== "pending") return publicFlow(session.flow);
      session.dispose();
      setFlow(session, { status: "cancelled", qrCodeUrl: undefined });
      settleStarted(session);
      scheduleRemoval(session);
      return publicFlow(session.flow);
    },

    stop() {
      stopped = true;
      for (const session of sessions.values()) {
        session.dispose();
        if (session.flow.status === "pending" || session.flow.status === "saving") {
          setFlow(session, { status: "cancelled", qrCodeUrl: undefined });
          settleStarted(session);
        }
        scheduleRemoval(session);
      }
    },
  };
}

export function mergeQqbotQrCredentials(
  current: ChannelsConfig | null,
  credential: QqbotQrCredentials,
): ChannelsConfig {
  const adapters = { ...(current?.adapters ?? {}) };
  const existingEntry = Object.entries(adapters).find(([, adapter]) => adapter.type === "qqbot");
  const adapterId = existingEntry?.[0] ?? nextQqbotAdapterId(adapters);
  const existing = existingEntry?.[1] as QqbotAdapterConfig | undefined;
  const userOpenid = credential.userOpenid?.trim();
  const allowedUserIds = existing?.allowed_user_ids ?? (userOpenid ? [userOpenid] : undefined);

  adapters[adapterId] = {
    ...existing,
    type: "qqbot",
    app_id: credential.appId.trim(),
    client_secret: credential.clientSecret.trim(),
    connection_mode: "websocket",
    api_environment: "production",
    ...(allowedUserIds ? { allowed_user_ids: allowedUserIds } : {}),
    group_policy: existing?.group_policy ?? "disabled",
    group_trigger: existing?.group_trigger ?? "mention",
  };

  return {
    adapters,
    routes: { ...(current?.routes ?? {}) },
    ingress: {
      enabled: true,
      ...(current?.ingress?.on_unbound
        ? { on_unbound: current.ingress.on_unbound }
        : { on_unbound: "create" }),
    },
  };
}

function nextQqbotAdapterId(adapters: ChannelsConfig["adapters"]): string {
  if (!adapters.qqbot) return "qqbot";
  let suffix = 2;
  while (adapters[`qqbot-${suffix}`]) suffix += 1;
  return `qqbot-${suffix}`;
}

function requireSession(
  sessions: Map<string, PendingQqbotQrAuth>,
  flowId: string,
): PendingQqbotQrAuth {
  const session = sessions.get(flowId.trim());
  if (!session) {
    throw new Error("QQ Bot QR authentication flow not found.");
  }
  return session;
}

function publicFlow(flow: SparkQqbotQrAuthFlow): SparkQqbotQrAuthFlow {
  return parseSparkQqbotQrAuthFlow({ ...flow });
}
