/** Managed client registry, retry, and local daemon auto-start. */

import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import { autoStartDaemon } from "./daemon-start.ts";
import {
  CueClient,
  CueError,
  cueOperationId,
  type CueOperationKey,
  type CueResolvedTransport,
  type CueSessionOptions,
  isRetryableCueTransportError,
  resolveCueTransport,
} from "../client/cue-client.ts";
import { checkAndWarn as checkCuedVersionAndWarn } from "../version-check.ts";
import type { CueOperationContext } from "./host-types.ts";

function resolveCueWorkingDirectory(
  requestedCwd: string | undefined,
  fallbackCwd?: string,
): string {
  const baseCwd = fallbackCwd?.trim() || process.cwd();
  if (!requestedCwd) return nodePath.resolve(baseCwd);
  return nodePath.isAbsolute(requestedCwd) ? requestedCwd : nodePath.resolve(baseCwd, requestedCwd);
}

export type CueClientOwner = symbol;

interface CueClientRegistryEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly owners: Set<CueClientOwner>;
  connectPromise: Promise<CueClient>;
  client?: CueClient;
}

const clientRegistry = new Map<string, CueClientRegistryEntry>();

function closeClientRegistryEntry(entry: CueClientRegistryEntry): void {
  if (clientRegistry.get(entry.key) === entry) clientRegistry.delete(entry.key);
  if (entry.client) {
    entry.client.close();
    return;
  }
  void entry.connectPromise.then(
    (connected) => connected.close(),
    () => undefined,
  );
}

function cueTransportKey(transport: CueResolvedTransport): string {
  if (transport.transport === "unix") return `unix:${transport.socket_path}`;
  return ["ssh", transport.profile_name, transport.destination, transport.gateway_command].join(
    ":",
  );
}

function cueErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cueSessionOptionsFromContext(
  ctx?: CueOperationContext,
): Required<CueSessionOptions> {
  const cwd = resolveCueWorkingDirectory(undefined, ctx?.cwd);
  const sessionId = cueSessionIdFromContext(ctx, cwd);
  return {
    sessionId,
    cwd,
    env: ctx?.env ?? process.env,
    refresh: false,
    forwardSensitiveEnv: ctx?.cueForwardSensitiveEnv ?? false,
  };
}

function cueSessionIdFromContext(ctx: CueOperationContext | undefined, cwd: string): string {
  const direct = ctx?.sessionId?.trim();
  if (direct) return direct;
  return `cue:${process.pid}:${stableStringHash(cwd)}`;
}

function stableStringHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function releaseClientOwner(owner: CueClientOwner, ctx?: CueOperationContext): void {
  const ownedEntries = Array.from(clientRegistry.values()).filter((entry) =>
    entry.owners.has(owner),
  );
  const hasSessionIdentity = Boolean(ctx?.sessionId?.trim() || ctx?.cwd?.trim());
  let sessionId = hasSessionIdentity
    ? cueSessionIdFromContext(ctx, resolveCueWorkingDirectory(undefined, ctx?.cwd))
    : undefined;
  if (!sessionId) {
    const ownedSessionIds = new Set(ownedEntries.map((entry) => entry.sessionId));
    if (ownedSessionIds.size !== 1) return;
    sessionId = ownedSessionIds.values().next().value;
  }

  for (const entry of ownedEntries) {
    if (entry.sessionId !== sessionId) continue;
    if (!entry.owners.delete(owner)) continue;
    if (entry.owners.size === 0) closeClientRegistryEntry(entry);
  }
}

export function releaseAllClientOwner(owner: CueClientOwner): void {
  for (const entry of Array.from(clientRegistry.values())) {
    if (!entry.owners.delete(owner)) continue;
    if (entry.owners.size === 0) closeClientRegistryEntry(entry);
  }
}

async function connectClient(
  transport: CueResolvedTransport,
  session: Required<CueSessionOptions>,
  ctx?: CueOperationContext,
): Promise<CueClient> {
  try {
    return await CueClient.connectResolved(transport, session);
  } catch (error) {
    if (error instanceof CueError && error.code === "UNSUPPORTED_PROTOCOL") throw error;
    if (transport.transport === "ssh") throw error;
    if (!(error instanceof CueError) || error.code !== "DAEMON_UNREACHABLE") throw error;
    if (ctx?.cueAutoStartLocal === false) throw error;
    // Local socket could not be reached — auto-start local/unix transports only.
    ctx?.ui?.notify?.("Cue: auto-starting daemon…", "info");
    try {
      await autoStartDaemon(transport.socket_path);
    } catch (startErr) {
      const msg = [
        `Cue daemon not reachable at ${transport.socket_path}.`,
        `Initial connection failure: ${cueErrorDetail(error)}`,
        `Auto-start failed: ${cueErrorDetail(startErr)}`,
      ].join("\n");
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
    // Retry connection after starting.
    try {
      return await CueClient.connectResolved(transport, session);
    } catch (err) {
      if (err instanceof CueError && err.code === "UNSUPPORTED_PROTOCOL") throw err;
      const msg = [
        `Cue daemon auto-started but still not reachable at ${transport.socket_path}.`,
        `Initial connection failure: ${cueErrorDetail(error)}`,
        `Retry failure: ${cueErrorDetail(err)}`,
      ].join("\n");
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
  }
}

export async function getClient(
  ctx: CueOperationContext | undefined,
  owner: CueClientOwner,
): Promise<CueClient> {
  if (ctx?.cueClient) return ctx.cueClient;
  const transport = ctx?.cueResolvedTransport ?? (await resolveCueTransport());
  const sessionContext =
    transport.transport === "ssh"
      ? (() => {
          const remoteCwd =
            ctx?.cueRemoteCwd?.trim() ||
            ctx?.env?.DSH_CUE_REMOTE_CWD?.trim() ||
            process.env.DSH_CUE_REMOTE_CWD?.trim();
          if (!remoteCwd) {
            throw new Error(
              `cue profile \`${transport.profile_name}\` uses SSH; provide an explicit remote cwd instead of reusing the local session cwd.`,
            );
          }
          return { ...ctx, cwd: remoteCwd };
        })()
      : ctx;
  const session = cueSessionOptionsFromContext(sessionContext);
  const key = `${cueTransportKey(transport)}|session:${session.sessionId}`;
  let entry = clientRegistry.get(key);
  if (entry?.client?.isClosed) {
    closeClientRegistryEntry(entry);
    entry = undefined;
  }

  if (!entry) {
    const pendingEntry: CueClientRegistryEntry = {
      key,
      sessionId: session.sessionId,
      owners: new Set(),
      connectPromise: connectClient(transport, session, ctx),
    };
    pendingEntry.connectPromise = pendingEntry.connectPromise
      .then((connected) => {
        pendingEntry.client = connected;
        if (clientRegistry.get(key) !== pendingEntry || pendingEntry.owners.size === 0) {
          connected.close();
        }
        return connected;
      })
      .catch((error) => {
        if (clientRegistry.get(key) === pendingEntry) clientRegistry.delete(key);
        throw error;
      });
    entry = pendingEntry;
    clientRegistry.set(key, entry);
  }

  entry.owners.add(owner);
  const client = await entry.connectPromise;
  if (client.isClosed) {
    closeClientRegistryEntry(entry);
    throw new CueError(
      "DAEMON_UNREACHABLE",
      `Cue connection closed during initialization for session ${session.sessionId}`,
    );
  }

  // Best-effort outdated-cued warning, fired at most once per process.
  // Detached on purpose: the warning hits GitHub for the latest release
  // and we never want that to delay the first IPC call.
  void checkCuedVersionAndWarn(client, ctx);
  return client;
}

export function cueToolOperation(
  ctx: CueOperationContext | undefined,
  toolCallId: string,
  kind: string,
): CueOperationKey {
  return {
    sessionId: cueSessionOptionsFromContext(ctx).sessionId,
    toolCallId,
    kind,
  };
}

async function invalidateManagedClientForRetry(client: CueClient): Promise<void> {
  for (const entry of [...clientRegistry.values()]) {
    if (entry.client !== client) continue;
    if (clientRegistry.get(entry.key) === entry) clientRegistry.delete(entry.key);
  }
  client.close();
  await client.closed;
}

interface CueSideEffectRetryOptions {
  /** False until the daemon exposes enough query state to reconstruct the result. */
  replaySafe?: boolean;
  /** Execution budget shared by connection, backoff, and replay attempts. */
  deadlineMs?: number;
  /** Cancellation budget inherited from the owning tool call. */
  signal?: AbortSignal;
  /** Safe, bounded retry telemetry for the active tool surface. */
  onRetry?: (progress: CueSideEffectRetryProgress) => void;
}

interface CueSideEffectAttempt {
  attempt: number;
  remainingMs?: number;
}

interface CueSideEffectRetryProgress {
  /** Attempt about to run; the initial attempt is 1. */
  attempt: number;
  delayMs: number;
  remainingMs?: number;
}

const CUE_RETRY_BASE_DELAY_MS = 100;
const CUE_RETRY_MAX_DELAY_MS = 5_000;

function cueRetryDelayMs(replayIndex: number): number {
  const exponent = Math.min(16, Math.max(0, Math.floor(replayIndex) - 1));
  const cap = Math.min(CUE_RETRY_MAX_DELAY_MS, CUE_RETRY_BASE_DELAY_MS * 2 ** exponent);
  // Equal jitter avoids synchronized reconnect storms while retaining a useful
  // minimum pause when a local daemon or remote SSH gateway is unavailable.
  return Math.floor(cap * (0.5 + Math.random() * 0.5));
}

function cueRetryDeadlineError(operationId: string): CueError {
  return new CueError(
    "IDEMPOTENT_RETRY_DEADLINE_EXCEEDED",
    `operation ${operationId} remained transport-ambiguous when its retry deadline expired`,
  );
}

async function withinCueRetryBudget<T>(
  promise: Promise<T>,
  operationId: string,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<T> {
  signal?.throwIfAborted();
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw cueRetryDeadlineError(operationId);
  }
  if (!signal && deadlineAt === undefined) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (deadlineAt !== undefined) {
      deadlineTimer = setTimeout(
        () => settle(() => reject(cueRetryDeadlineError(operationId))),
        Math.max(0, deadlineAt - Date.now()),
      );
    }
    void promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function waitForCueRetry(
  delayMs: number,
  operationId: string,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<void> {
  return withinCueRetryBudget(
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    operationId,
    signal,
    deadlineAt,
  );
}

function cueRetryProgressUpdate(
  onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
): (progress: CueSideEffectRetryProgress) => void {
  return ({ attempt, delayMs, remainingMs }) => {
    const budget = remainingMs === undefined ? "" : `; ${Math.ceil(remainingMs / 1_000)}s left`;
    onUpdate({
      content: [
        {
          type: "text",
          text: `Cue transport interrupted; retrying attempt ${attempt} in ${delayMs}ms${budget}`,
        },
      ],
    });
  };
}

export function cueToolRetryOptions(
  signal: AbortSignal,
  onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
  options: Omit<CueSideEffectRetryOptions, "signal" | "onRetry"> = {},
): CueSideEffectRetryOptions {
  return { ...options, signal, onRetry: cueRetryProgressUpdate(onUpdate) };
}

export async function withCueIdempotentRetry<T>(
  ctx: CueOperationContext | undefined,
  owner: CueClientOwner,
  operation: CueOperationKey,
  run: (client: CueClient, attempt: CueSideEffectAttempt) => Promise<T>,
  options: CueSideEffectRetryOptions = {},
): Promise<T> {
  const operationId = cueOperationId(operation);
  const deadlineAt =
    options.deadlineMs === undefined ? undefined : Date.now() + Math.max(0, options.deadlineMs);
  const attemptContext = (attempt: number): CueSideEffectAttempt => {
    if (deadlineAt === undefined) return { attempt };
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    return { attempt, remainingMs };
  };
  const firstClient = await withinCueRetryBudget(
    getClient(ctx, owner),
    operationId,
    options.signal,
    deadlineAt,
  );
  const firstInstanceId = firstClient.daemonInstanceId;
  let client = firstClient;
  let attempt = 1;
  for (;;) {
    try {
      return await withinCueRetryBudget(
        run(client, attemptContext(attempt)),
        operationId,
        options.signal,
        deadlineAt,
      );
    } catch (error) {
      if (!isRetryableCueTransportError(error)) throw error;
      if (ctx?.cueClient) {
        throw new CueError(
          "IDEMPOTENT_RETRY_UNAVAILABLE",
          `operation ${operationId} became transport-ambiguous, and an externally injected CueClient cannot be rebuilt safely: ${cueErrorDetail(error)}`,
        );
      }
      if (options.replaySafe === false) {
        throw new CueError(
          "IDEMPOTENT_RECOVERY_UNSUPPORTED",
          `operation ${operationId} may have executed, but its result cannot yet be reconstructed after reconnect`,
        );
      }

      // Close the old transport before reconnecting. A late response on the old
      // request id must not race the replay on the new connection.
      await invalidateManagedClientForRetry(client);
      for (;;) {
        const nextAttempt = attempt + 1;
        const delayMs = cueRetryDelayMs(attempt);
        const remainingMs =
          deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
        options.onRetry?.({ attempt: nextAttempt, delayMs, remainingMs });
        await waitForCueRetry(delayMs, operationId, options.signal, deadlineAt);

        let retryClient: CueClient;
        try {
          retryClient = await withinCueRetryBudget(
            getClient(ctx, owner),
            operationId,
            options.signal,
            deadlineAt,
          );
        } catch (reconnectError) {
          if (reconnectError instanceof CueError && reconnectError.code === "DAEMON_UNREACHABLE") {
            attempt = nextAttempt;
            continue;
          }
          throw reconnectError;
        }
        if (
          firstInstanceId === null ||
          retryClient.daemonInstanceId === null ||
          retryClient.daemonInstanceId !== firstInstanceId
        ) {
          const retryInstanceId = retryClient.daemonInstanceId;
          await invalidateManagedClientForRetry(retryClient);
          throw new CueError(
            "IDEMPOTENT_DAEMON_CHANGED",
            `operation ${operationId} cannot be replayed because cued changed from instance ${firstInstanceId ?? "unknown"} to ${retryInstanceId ?? "unknown"}`,
          );
        }
        client = retryClient;
        attempt = nextAttempt;
        break;
      }
    }
  }
}
