import type {
  SparkDriverStatus,
  SparkDriverView,
  SparkSessionView,
} from "@zendev-lab/spark-protocol";

export type SessionPrimaryView = "work" | "transcript";

export function requestedSessionPrimaryView(url: URL): SessionPrimaryView | undefined {
  const view = url.searchParams.get("view");
  return view === "work" || view === "transcript" ? view : undefined;
}

export function defaultSessionPrimaryView(
  session: SparkSessionView | null | undefined,
): SessionPrimaryView {
  return sessionHasProjectedWork(session) || (session?.drivers?.length ?? 0) > 0
    ? "work"
    : "transcript";
}

export function sessionHasProjectedWork(session: SparkSessionView | null | undefined): boolean {
  return Boolean(session?.work?.primary || session?.work?.goal || session?.work?.repro);
}

export function primarySessionDriver(
  session: SparkSessionView | null | undefined,
): SparkDriverView | undefined {
  const primary = session?.work?.primary;
  if (!primary) return undefined;
  return session?.drivers?.find(
    (driver) => driver.driverId === primary.driverId && driver.kind === primary.kind,
  );
}

export function sessionWorkStatus(
  session: SparkSessionView | null | undefined,
): SparkDriverStatus | "active" | "paused" | "complete" | undefined {
  const driver = primarySessionDriver(session);
  if (driver) return driver.status;
  if (session?.work?.repro) return session.work.repro.status;
  return session?.work?.goal?.status;
}

export function sessionWorkObjective(
  session: SparkSessionView | null | undefined,
): string | undefined {
  return session?.work?.repro?.objective ?? session?.work?.goal?.objective;
}
