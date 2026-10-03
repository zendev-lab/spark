export interface DaemonChannelSessionProjectionLike {
  sessionId: string;
  name?: string;
  scope: { kind: "workspace" | "daemon" };
  lineage: { kind: "root" | "child" };
  purpose: string;
  lifecycle: string;
  placement: string;
  activity: string;
  updatedAt: string;
  cwd?: string;
  bindings: ReadonlyArray<{
    kind: string;
    adapter?: string;
    adapterId?: string;
    adapterAccountIdentity?: string;
    externalKey?: string;
  }>;
}

export interface DaemonChannelSessionSummary {
  sessionId: string;
  name?: string;
  lifecycle: string;
  placement: string;
  activity: string;
  updatedAt: string;
  adapterIds: string[];
}

/**
 * Produce the deliberately narrow Hub projection for daemon Channel Sessions.
 * Private cwd, account identity, external conversation keys, and transcripts
 * stay on the daemon.
 */
export function daemonChannelSessionSummaries(
  sessions: readonly DaemonChannelSessionProjectionLike[],
): DaemonChannelSessionSummary[] {
  return sessions
    .filter(
      (session) =>
        session.scope.kind === "daemon" &&
        session.lineage.kind === "root" &&
        session.purpose === "channel",
    )
    .map((session) => ({
      sessionId: session.sessionId,
      ...(session.name ? { name: session.name } : {}),
      lifecycle: session.lifecycle,
      placement: session.placement,
      activity: session.activity,
      updatedAt: session.updatedAt,
      adapterIds: [
        ...new Set(
          session.bindings.flatMap((binding) => {
            if (binding.kind !== "channel") return [];
            const value = binding.adapterId?.trim() || binding.adapter?.trim();
            return value ? [value] : [];
          }),
        ),
      ],
    }));
}
