import type { SparkLoopStatus, SparkLoopView, SparkSessionView } from "@zendev-lab/spark-protocol";

export type SessionPrimaryView = "work" | "transcript";

export function requestedSessionPrimaryView(url: URL): SessionPrimaryView | undefined {
  const view = url.searchParams.get("view");
  return view === "work" || view === "transcript" ? view : undefined;
}

export function defaultSessionPrimaryView(
  session: SparkSessionView | null | undefined,
): SessionPrimaryView {
  return sessionHasProjectedWork(session) || (session?.loops?.length ?? 0) > 0
    ? "work"
    : "transcript";
}

export function sessionHasProjectedWork(session: SparkSessionView | null | undefined): boolean {
  return Boolean(session?.work?.primary || session?.work?.goal || session?.work?.repro);
}

export function primarySessionLoop(
  session: SparkSessionView | null | undefined,
): SparkLoopView | undefined {
  const primary = session?.work?.primary;
  if (!primary) return undefined;
  return session?.loops?.find((loop) => loop.loopId === primary.loopId);
}

export function sessionWorkStatus(
  session: SparkSessionView | null | undefined,
): SparkLoopStatus | "active" | "paused" | "complete" | undefined {
  const loop = primarySessionLoop(session);
  if (loop) return loop.status;
  if (session?.work?.repro) return session.work.repro.status;
  return session?.work?.goal?.status;
}

export function sessionWorkObjective(
  session: SparkSessionView | null | undefined,
): string | undefined {
  return session?.work?.repro?.objective ?? session?.work?.goal?.objective;
}
