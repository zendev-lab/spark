export interface SessionTreeNodeLike {
  sessionId: string;
  placement?: string;
  lineage?: {
    kind: "root" | "child";
    parentSessionId?: string;
    origin?: { kind: string; generation?: number };
  };
}

export interface SessionTreeRow<T extends SessionTreeNodeLike> {
  session: T;
  ariaLevel: number;
  parentSessionId?: string;
  orphaned: boolean;
  diagnostic?: "orphan" | "cycle";
}

export function buildSessionTreeRows<T extends SessionTreeNodeLike>(
  sessions: readonly T[],
  options: { includeArchived?: boolean } = {},
): SessionTreeRow<T>[] {
  const visible = sessions.filter(
    (session) => options.includeArchived || session.placement !== "archived",
  );
  const byId = new Map(visible.map((session) => [session.sessionId, session]));
  const childrenByParent = new Map<string, T[]>();
  const orphans: T[] = [];

  for (const session of visible) {
    if (session.lineage?.kind !== "child") continue;
    const parentSessionId = session.lineage.parentSessionId?.trim();
    if (!parentSessionId || !byId.has(parentSessionId)) {
      orphans.push(session);
      continue;
    }
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(session);
    childrenByParent.set(parentSessionId, children);
  }

  const rows: SessionTreeRow<T>[] = [];
  const emitted = new Set<string>();
  const append = (session: T, ariaLevel: number): void => {
    if (emitted.has(session.sessionId)) return;
    emitted.add(session.sessionId);
    rows.push({
      session,
      ariaLevel,
      ...(session.lineage?.kind === "child"
        ? { parentSessionId: session.lineage.parentSessionId }
        : {}),
      orphaned: false,
    });
    for (const child of childrenByParent.get(session.sessionId) ?? []) {
      append(child, ariaLevel + 1);
    }
  };

  for (const root of visible.filter((session) => session.lineage?.kind !== "child")) {
    append(root, 1);
  }
  for (const orphan of orphans) {
    rows.push({
      session: orphan,
      ariaLevel: 1,
      ...(orphan.lineage?.kind === "child"
        ? { parentSessionId: orphan.lineage.parentSessionId }
        : {}),
      orphaned: true,
      diagnostic: "orphan",
    });
    emitted.add(orphan.sessionId);
    for (const child of childrenByParent.get(orphan.sessionId) ?? []) {
      append(child, 2);
    }
  }
  for (const cyclic of visible.filter((session) => !emitted.has(session.sessionId))) {
    rows.push({
      session: cyclic,
      ariaLevel: 1,
      ...(cyclic.lineage?.kind === "child"
        ? { parentSessionId: cyclic.lineage.parentSessionId }
        : {}),
      orphaned: true,
      diagnostic: "cycle",
    });
    emitted.add(cyclic.sessionId);
  }
  return rows;
}
