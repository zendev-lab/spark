import type { SparkSessionView } from "@zendev-lab/spark-protocol";

const DEFAULT_IDLE_RECONCILE_INTERVAL_MS = 1_000;

/**
 * Compact daemon-owned projection fingerprint. Occupancy heartbeat does not
 * carry snapshot or pendingTurns, so an attached idle TUI must compare later
 * `session.snapshot` results instead of inferring work from elapsed time.
 */
export function nativeTuiDaemonProjectionSignature(snapshot: SparkSessionView): string {
  const pending = (snapshot.pendingTurns ?? [])
    .map((turn) => `${turn.invocationId}:${turn.status}`)
    .join(",");
  const lastMessage = snapshot.messages.at(-1);
  const repro = snapshot.work?.repro;
  const goal = snapshot.work?.goal;
  const loops = (snapshot.loops ?? []).map((loop) => `${loop.loopId}:${loop.status}`).join(",");
  return [
    snapshot.updatedAt ?? "",
    snapshot.status,
    pending,
    lastMessage?.id ?? "",
    lastMessage?.updatedAt ?? "",
    repro ? `${repro.stage.index}:${repro.stage.phase}` : "",
    goal ? `${goal.goalId}:${goal.status}` : "",
    loops,
  ].join("|");
}

export async function reconcileIdleNativeTuiDaemonProjection(input: {
  isProcessing: () => boolean;
  lastSignature?: string;
  signal?: AbortSignal;
  loadSnapshot: () => Promise<SparkSessionView | undefined>;
  applySnapshot: (snapshot: SparkSessionView) => void;
  refreshWidget: () => Promise<void>;
}): Promise<string | undefined> {
  if (input.signal?.aborted || input.isProcessing()) return input.lastSignature;
  const snapshot = await input.loadSnapshot();
  if (input.signal?.aborted || input.isProcessing()) return input.lastSignature;
  if (!snapshot) {
    await input.refreshWidget();
    return input.lastSignature;
  }
  const signature = nativeTuiDaemonProjectionSignature(snapshot);
  if (signature !== input.lastSignature) input.applySnapshot(snapshot);
  await input.refreshWidget();
  return signature;
}

export function startIdleNativeTuiDaemonProjectionReconcile(input: {
  signal: AbortSignal;
  isProcessing: () => boolean;
  loadSnapshot: () => Promise<SparkSessionView | undefined>;
  applySnapshot: (snapshot: SparkSessionView) => void;
  refreshWidget: () => Promise<void>;
  lastSignature?: string;
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> | number;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout> | number) => void;
}): void {
  const intervalMs = Math.max(250, input.intervalMs ?? DEFAULT_IDLE_RECONCILE_INTERVAL_MS);
  const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule =
    input.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: ReturnType<typeof setTimeout> | number | undefined;
  let lastSignature = input.lastSignature;

  const stop = () => {
    if (timer === undefined) return;
    cancelSchedule(timer);
    timer = undefined;
  };

  const tick = () => {
    if (input.signal.aborted) {
      stop();
      return;
    }
    void reconcileIdleNativeTuiDaemonProjection({
      isProcessing: input.isProcessing,
      lastSignature,
      signal: input.signal,
      loadSnapshot: input.loadSnapshot,
      applySnapshot: input.applySnapshot,
      refreshWidget: input.refreshWidget,
    })
      .then((signature) => {
        lastSignature = signature;
      })
      .catch(() => undefined)
      .finally(() => {
        if (input.signal.aborted) return;
        timer = schedule(tick, intervalMs);
        (timer as { unref?: () => void }).unref?.();
      });
  };

  input.signal.addEventListener("abort", stop, { once: true });
  timer = schedule(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();
}
