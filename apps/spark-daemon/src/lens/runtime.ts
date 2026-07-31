import type {
  LensProvider,
  LensProviderSession,
  LensWorkspaceContext,
  ProviderId,
  ProviderRequest,
  ProviderResult,
} from "@zendev-lab/spark-lens";

import { DaemonLensStateStore } from "./state-store.ts";

export interface DaemonLensRuntimeOptions {
  stateStore: DaemonLensStateStore;
}

export interface RunLensProviderOptions {
  requestId: string;
  providerId: ProviderId;
  request: ProviderRequest;
  timeoutMs: number;
}

interface SessionEntry {
  session: LensProviderSession;
  openedFor: LensWorkspaceContext;
}

export class DaemonLensRuntime {
  readonly #providers = new Map<ProviderId, LensProvider>();
  readonly #sessions = new Map<string, Promise<SessionEntry>>();
  readonly #cache = new Map<string, ProviderResult>();
  readonly #requests = new Map<string, AbortController>();
  readonly #stateStore: DaemonLensStateStore;

  constructor(options: DaemonLensRuntimeOptions) {
    this.#stateStore = options.stateStore;
  }

  register(provider: LensProvider): void {
    if (this.#providers.has(provider.spec.id)) {
      throw new Error(`Lens provider already registered: ${provider.spec.id}`);
    }
    this.#providers.set(provider.spec.id, provider);
  }

  registeredProviderIds(): ProviderId[] {
    return [...this.#providers.keys()].sort((left, right) => left.localeCompare(right));
  }

  cachedResult(providerId: ProviderId, request: ProviderRequest): ProviderResult | undefined {
    const key = resultKey(providerId, request);
    return (
      this.#cache.get(key) ??
      this.#stateStore.loadProviderResult(providerId, request.capability, request.revision.digest)
    );
  }

  async run(options: RunLensProviderOptions): Promise<ProviderResult> {
    const provider = this.#providers.get(options.providerId);
    if (!provider) {
      throw new Error(`Lens provider is not registered: ${options.providerId}`);
    }
    if (this.#requests.has(options.requestId)) {
      throw new Error(`Lens request already active: ${options.requestId}`);
    }

    const controller = new AbortController();
    this.#requests.set(options.requestId, controller);
    const startedAt = performance.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Lens provider request timed out"));
    }, options.timeoutMs);

    let result: ProviderResult;
    try {
      const entry = await this.#session(provider, {
        worktreeRoot: options.request.revision.workspaceRoot,
        projectRoot: options.request.revision.workspaceRoot,
        workspaceRoot: options.request.revision.workspaceRoot,
        profileDigest: options.request.revision.profileDigest,
        configDigest: options.request.revision.profileDigest,
      });
      const value = await Promise.race([
        entry.session.request(options.request, controller.signal),
        aborted(controller.signal),
      ]);
      result = {
        providerId: options.providerId,
        providerVersion: entry.session.providerVersion,
        capability: options.request.capability,
        revisionDigest: options.request.revision.digest,
        status: value === undefined ? "silent" : "ok",
        producedAt: new Date().toISOString(),
        durationMs: performance.now() - startedAt,
        ...(value === undefined ? {} : { value }),
      };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      result = {
        providerId: options.providerId,
        providerVersion: "unknown" as LensProviderSession["providerVersion"],
        capability: options.request.capability,
        revisionDigest: options.request.revision.digest,
        status: timedOut ? "timeout" : cancelled ? "cancelled" : "error",
        producedAt: new Date().toISOString(),
        durationMs: performance.now() - startedAt,
        error: {
          code: timedOut ? "PROVIDER_TIMEOUT" : cancelled ? "PROVIDER_CANCELLED" : "PROVIDER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timeout);
      this.#requests.delete(options.requestId);
    }

    const key = resultKey(options.providerId, options.request);
    this.#cache.set(key, result);
    this.#stateStore.saveProviderResult(result);
    return result;
  }

  cancel(requestId: string): boolean {
    const controller = this.#requests.get(requestId);
    if (!controller) return false;
    controller.abort(new Error("Lens provider request cancelled"));
    return true;
  }

  async close(): Promise<void> {
    for (const controller of this.#requests.values()) {
      controller.abort(new Error("Lens runtime closed"));
    }
    this.#requests.clear();
    const entries = await Promise.allSettled(this.#sessions.values());
    await Promise.allSettled(
      entries
        .filter(
          (entry): entry is PromiseFulfilledResult<SessionEntry> => entry.status === "fulfilled",
        )
        .map(async (entry) => await entry.value.session.close()),
    );
    this.#sessions.clear();
    this.#cache.clear();
  }

  async #session(provider: LensProvider, workspace: LensWorkspaceContext): Promise<SessionEntry> {
    const key = sessionKey(provider.spec.id, workspace);
    const existing = this.#sessions.get(key);
    if (existing) return await existing;

    const opening = (async (): Promise<SessionEntry> => {
      const controller = new AbortController();
      const session = await provider.open(workspace, controller.signal);
      return { session, openedFor: workspace };
    })();
    this.#sessions.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      this.#sessions.delete(key);
      throw error;
    }
  }
}

function sessionKey(providerId: ProviderId, workspace: LensWorkspaceContext): string {
  return [providerId, workspace.worktreeRoot, workspace.projectRoot, workspace.configDigest].join(
    "\0",
  );
}

function resultKey(providerId: ProviderId, request: ProviderRequest): string {
  return `${providerId}\0${request.capability}\0${request.revision.digest}`;
}

async function aborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
