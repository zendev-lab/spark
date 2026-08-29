<script lang="ts">
  import { enhance } from "$app/forms";
  import { Icon } from "@zendev-lab/spark-ui";
  import type { SparkSessionLineage } from "@zendev-lab/spark-protocol/session-assignment";
  import ChannelSessionIcon from "$lib/ChannelSessionIcon.svelte";
  import {
    channelSessionPresentation,
    sessionHasChannelBinding,
    type ChannelSessionLabels,
  } from "$lib/channel-session-title";
  import { visibleConversationActivityStatus } from "$lib/conversation-status";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import {
    groupWorkbenchSessionsByType,
    type WorkbenchSessionType,
  } from "$lib/workbench-session-groups";
  import {
    buildSessionRailTree,
    isSessionVisibleInWorkbenchRail,
    workbenchSessionScope,
    type WorkbenchSessionRailRow,
  } from "$lib/workbench-session-scope";
  import { workspaceSessionPath, workspaceSessionsPath } from "$lib/workspace-routes";

  type SessionRecord = {
    sessionId: string;
    workspaceId?: string;
    scope?:
      | { kind: "workspace"; workspaceId: string }
      | { kind: "daemon"; daemonId?: string; daemonLabel?: string };
    name?: string;
    lifecycle: "open" | "closing" | "closed";
    placement: "active" | "archived";
    activity?: "idle" | "queued" | "running";
    descendantActivity?: {
      activity: "idle" | "queued" | "running";
      descendantCount: number;
      activeCount: number;
      truncated?: boolean;
    };
    activityUpdatedAt?: string;
    bindings?: Array<{ kind: string; adapter?: string; externalKey?: string }>;
    lineage: SparkSessionLineage;
    createdAt: string;
    updatedAt: string;
  };

  type WorkspaceOption = {
    id: string;
    slug: string;
    name: string;
  };

  let {
    sessions,
    workspaces,
    activeWorkspaceId = null,
    selectedSessionId = null,
    sessionsAvailable = true,
    sessionControlAvailable = sessionsAvailable,
    showUnavailableNotice = true,
    showArchived = false,
    archivedToggleHref = "?archived=1",
    locale,
    common,
    messages,
  }: {
    sessions: SessionRecord[];
    workspaces: WorkspaceOption[];
    activeWorkspaceId?: string | null;
    selectedSessionId?: string | null;
    sessionsAvailable?: boolean;
    sessionControlAvailable?: boolean;
    showUnavailableNotice?: boolean;
    showArchived?: boolean;
    archivedToggleHref?: string;
    locale: string;
    common: Parameters<typeof getStatusLabel>[1];
    messages: {
      newSession: string;
      searchPlaceholder: string;
      emptyTitle: string;
      emptyBody: string;
      daemonUnavailableTitle: string;
      daemonUnavailableBody: string;
      listLabel: string;
      untitledConversation: string;
      unknownWorkspace: string;
      channelSessionBadge: string;
      channelLabels: ChannelSessionLabels;
      sessionTypes: Record<WorkbenchSessionType, string>;
      archiveSubmit: string;
      closeSubmit: string;
      showArchived: string;
      hideArchived: string;
      archivedLabel: string;
      orphanedSideThreads: string;
      sideThreadRailLabel: string;
    };
  } = $props();

  let filter = $state("");
  let archivingId = $state<string | null>(null);
  let activeWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
  );
  let sessionsHref = $derived(activeWorkspace ? workspaceSessionsPath(activeWorkspace) : "/sessions");

  let archivedVisibilityOverride = $state<boolean | undefined>(undefined);
  let archivedVisible = $derived(archivedVisibilityOverride ?? showArchived);
  let workspaceSessions = $derived(
    sessions.filter((session) => isSessionVisibleInWorkbenchRail(session, activeWorkspaceId)),
  );
  let archivedCount = $derived(
    workspaceSessions.filter((session) => session.placement === "archived").length,
  );
  let railRows = $derived(
    buildSessionRailTree(workspaceSessions, { includeArchived: archivedVisible }),
  );
  let filteredRows = $derived.by(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return railRows;
    const matched = new Set(
      railRows
        .filter(({ session }) => sessionMatches(session, query))
        .map(({ session }) => session.sessionId),
    );
    const byId = new Map(railRows.map((row) => [row.session.sessionId, row]));
    for (const sessionId of [...matched]) {
      let current = byId.get(sessionId);
      const visited = new Set<string>();
      while (current?.parentSessionId && !visited.has(current.parentSessionId)) {
        visited.add(current.parentSessionId);
        matched.add(current.parentSessionId);
        current = byId.get(current.parentSessionId);
      }
    }
    return railRows.filter((row) => matched.has(row.session.sessionId));
  });
  let grouped = $derived.by(() => {
    const roots = filteredRows
      .filter((row) => row.ariaLevel === 1 && !row.orphaned)
      .map(({ session }) => session);
    const groups = groupWorkbenchSessionsByType(roots, {
      channelLabels: messages.channelLabels,
      fallback: messages.untitledConversation,
      labels: messages.sessionTypes,
    }).map((group) => ({
      ...group,
      rows: group.sessions.flatMap((parent) => subtreeRows(filteredRows, parent.sessionId)),
    }));
    const orphans = filteredRows.filter((row) => row.orphaned);
    return orphans.length > 0
      ? [
          ...groups,
          {
            key: "orphan-side-threads",
            label: messages.orphanedSideThreads,
            sessions: orphans.map(({ session }) => session),
            rows: orphans,
          },
        ]
      : groups;
  });

  function workspaceLabel(workspaceId: string) {
    return (
      workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
      messages.unknownWorkspace
    );
  }

  function sessionScopeLabel(session: SessionRecord) {
    const scope = workbenchSessionScope(session);
    if (scope.kind === "workspace") return workspaceLabel(scope.workspaceId);
    return messages.unknownWorkspace;
  }

  function relative(value: string) {
    return formatRelativeTime(value, locale as "en" | "zh-CN", common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function activityStatus(session: SessionRecord) {
    return session.activity ?? "idle";
  }

  function displayedActivityStatus(session: SessionRecord) {
    return visibleConversationActivityStatus(activityStatus(session));
  }

  function sessionPresentation(session: SessionRecord) {
    return channelSessionPresentation(session, {
      labels: messages.channelLabels,
      fallback: messages.untitledConversation,
    });
  }

  function sessionTitle(session: SessionRecord) {
    return sessionPresentation(session).title;
  }

  function sessionMatches(session: SessionRecord, query: string) {
    const scopeLabel = sessionScopeLabel(session).toLowerCase();
    const presentation = sessionPresentation(session);
    return (
      session.sessionId.toLowerCase().includes(query) ||
      (session.name ?? "").toLowerCase().includes(query) ||
      presentation.title.toLowerCase().includes(query) ||
      (presentation.channel?.label.toLowerCase().includes(query) ?? false) ||
      scopeLabel.includes(query)
    );
  }

  function childRelation(session: SessionRecord) {
    return session.lineage.kind === "child"
      ? { ...session.lineage.origin, parentSessionId: session.lineage.parentSessionId }
      : null;
  }

  function childSessionLabel(session: SessionRecord) {
    const relation = childRelation(session);
    if (!relation) return "";
    const generation = "generation" in relation ? ` • generation=${relation.generation}` : "";
    return `Subsession • origin=${relation.kind} • parent=${relation.parentSessionId}${generation} • lifecycle=${session.lifecycle} • activity=${session.activity ?? "idle"}`;
  }

  function subtreeRows(
    rows: WorkbenchSessionRailRow<SessionRecord>[],
    rootSessionId: string,
  ) {
    const start = rows.findIndex((row) => row.session.sessionId === rootSessionId);
    if (start < 0) return [];
    const rootLevel = rows[start]!.ariaLevel;
    let end = start + 1;
    while (end < rows.length && rows[end]!.ariaLevel > rootLevel) end += 1;
    return rows.slice(start, end);
  }

  function toggleArchived(event: MouseEvent) {
    event.preventDefault();
    const nextArchivedVisible = !archivedVisible;
    archivedVisibilityOverride = nextArchivedVisible;
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (nextArchivedVisible) url.searchParams.set("archived", "1");
    else url.searchParams.delete("archived");
    window.history.replaceState(window.history.state, "", url);
  }
</script>

<div class="session-rail">
  <h2 class="session-list-title">{messages.listLabel}</h2>

  <div class="session-toolbar">
    <label class="session-filter">
      <Icon name="search" size={15} stroke={2.1} />
      <input
        bind:value={filter}
        data-session-filter
        type="search"
        aria-label={messages.searchPlaceholder}
        placeholder={messages.searchPlaceholder}
      />
    </label>

    {#if archivedCount > 0}
      <a
        class="archived-toggle"
        href={archivedToggleHref}
        data-active={archivedVisible}
        onclick={toggleArchived}
      >
        {archivedVisible ? messages.hideArchived : messages.showArchived} ({archivedCount})
      </a>
    {/if}

    {#if activeWorkspaceId}
      {#if sessionControlAvailable}
        <a
          class="new-session"
          href={`${sessionsHref}?new=workspace`}
          aria-label={messages.newSession}
          title={messages.newSession}
        >
          <Icon name="new-message" size={17} stroke={2.1} />
          <span class="sr-only">{messages.newSession}</span>
        </a>
      {:else}
        <span
          class="new-session disabled"
          role="link"
          aria-disabled="true"
          aria-label={messages.newSession}
          title={messages.newSession}
        >
          <Icon name="new-message" size={17} stroke={2.1} />
          <span class="sr-only">{messages.newSession}</span>
        </span>
      {/if}
    {/if}
  </div>

  {#if showUnavailableNotice && activeWorkspaceId && !sessionControlAvailable}
    <div class="session-unavailable" role="status">
      <Icon name="warning" size={15} stroke={2.1} />
      <div>
        <strong>{messages.daemonUnavailableTitle}</strong>
        <p>{messages.daemonUnavailableBody}</p>
      </div>
    </div>
  {/if}

  {#if filteredRows.length === 0}
    {#if sessionsAvailable}
      <div class="session-empty">
        <strong>{messages.emptyTitle}</strong>
        <p>{messages.emptyBody}</p>
        {#if activeWorkspaceId && sessionControlAvailable}
          <a href={`${sessionsHref}?new=workspace`}>{messages.newSession}</a>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="session-groups" aria-label={messages.listLabel}>
      {#each grouped as group (group.key)}
        <details class="session-group" open>
          <summary>
            <span>{group.label}</span>
            <span class="group-meta">
              <span class="group-count">{group.rows.length}</span>
              <span class="group-disclosure" aria-hidden="true">
                <Icon name="chevron-down" size={13} stroke={2.3} />
              </span>
            </span>
          </summary>
          <div class="session-group-items" role="list">
            {#each group.rows as row (row.session.sessionId)}
              {@const session = row.session}
              {@const relation = childRelation(session)}
              {@const displayedStatus = displayedActivityStatus(session)}
              {@const isSelected = session.sessionId === selectedSessionId}
              {@const presentation = sessionPresentation(session)}
              {@const destinationSessionId = session.sessionId}
              {@const canArchive =
                sessionControlAvailable &&
                isSelected &&
                session.lineage.kind !== "root" &&
                session.lifecycle === "open" &&
                session.placement !== "archived" &&
                !sessionHasChannelBinding(session)}
              {@const canClose =
                sessionControlAvailable &&
                isSelected &&
                session.lineage.kind !== "root" &&
                session.lifecycle === "open"}
              <div
                class="session-item-row"
                role="listitem"
                aria-level={row.ariaLevel}
                data-session-id={session.sessionId}
              >
                {#if row.orphaned}
                  <div
                    class="session-item child orphan"
                    style={`--session-depth: ${Math.max(0, row.ariaLevel - 1)}`}
                    aria-disabled="true"
                    data-parent-session-id={row.parentSessionId}
                  >
                    <span class="session-title-row">
                      <strong>{presentation.title}</strong>
                    </span>
                    <small class="side-thread-meta">
                      {messages.orphanedSideThreads} • parent={row.parentSessionId} •
                      origin={relation?.kind} • lifecycle={session.lifecycle}
                    </small>
                  </div>
                {:else}
                  <a
                    class="session-item"
                    class:active={isSelected}
                    class:child={row.ariaLevel > 1}
                    class:has-action={canArchive || canClose}
                    style={`--session-depth: ${Math.max(0, row.ariaLevel - 1)}`}
                    aria-label={relation ? childSessionLabel(session) : undefined}
                    aria-current={isSelected ? "page" : undefined}
                    href={activeWorkspace
                      ? workspaceSessionPath(activeWorkspace, destinationSessionId)
                      : `/sessions/${encodeURIComponent(destinationSessionId)}`}
                    data-parent-session-id={row.parentSessionId}
                    data-sveltekit-preload-data="hover"
                  >
                    <span class="session-title-row">
                      {#if presentation.channel}
                        <ChannelSessionIcon
                          adapter={presentation.channel.adapter}
                          scope={presentation.channel.scope}
                          label={presentation.channel.label}
                        />
                      {/if}
                      <strong>
                        {presentation.title}{session.placement === "archived"
                          ? ` [${messages.archivedLabel}]`
                          : ""}
                      </strong>
                      {#if displayedStatus}
                        <span
                          class="session-status {displayedStatus}"
                          title={statusLabel(displayedStatus)}
                        >
                          <span aria-hidden="true"></span>
                          <span>{statusLabel(displayedStatus)}</span>
                        </span>
                      {/if}
                    </span>
                    {#if relation}
                      <small class="side-thread-meta">{childSessionLabel(session)}</small>
                    {:else}
                      <small>{relative(session.activityUpdatedAt ?? session.updatedAt)}</small>
                    {/if}
                  </a>
                  {#if canArchive || canClose}
                    <div class="session-actions">
                      {#if canArchive}
                        <form
                          method="POST"
                          action={`${sessionsHref}?/archiveSession`}
                          use:enhance={() => {
                            archivingId = session.sessionId;
                            return async ({ update }) => {
                              archivingId = null;
                              await update();
                            };
                          }}
                        >
                          <input type="hidden" name="sessionId" value={session.sessionId} />
                          <button
                            type="submit"
                            disabled={archivingId === session.sessionId}
                            aria-label={`${messages.archiveSubmit}: ${sessionTitle(session)}`}
                            title={messages.archiveSubmit}
                          >
                            <Icon name="archive" size={15} stroke={2.1} />
                          </button>
                        </form>
                      {/if}
                      {#if canClose}
                        <form method="POST" action={`${sessionsHref}?/closeSession`}>
                          <input type="hidden" name="sessionId" value={session.sessionId} />
                          <button
                            type="submit"
                            aria-label={`${messages.closeSubmit}: ${sessionTitle(session)}`}
                            title={messages.closeSubmit}
                          >
                            <Icon name="close" size={15} stroke={2.1} />
                          </button>
                        </form>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        </details>
      {/each}
    </div>
  {/if}
</div>

<style>
  .session-rail {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }

  .session-list-title {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.06em;
    margin: 2px 4px 0;
    text-transform: uppercase;
  }

  .session-toolbar {
    align-items: stretch;
    display: flex;
    gap: 6px;
    min-width: 0;
  }

  .archived-toggle {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    display: inline-flex;
    font-size: 11px;
    font-weight: 650;
    padding: 0 9px;
    text-decoration: none;
    white-space: nowrap;
  }

  .archived-toggle:hover,
  .archived-toggle[data-active="true"] {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .new-session {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    display: inline-flex;
    font-size: 13px;
    font-weight: 600;
    justify-content: center;
    height: 36px;
    padding: 0;
    text-align: center;
    text-decoration: none;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
    width: 36px;
  }

  .new-session:hover {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .new-session.disabled {
    color: var(--color-ink-disabled);
    cursor: not-allowed;
    opacity: 0.72;
  }

  .new-session.disabled:hover {
    background: var(--color-surface-soft);
    border-color: transparent;
    color: var(--color-ink-disabled);
  }

  .session-filter {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    display: flex;
    flex: 1 1 auto;
    gap: 8px;
    min-height: 36px;
    min-width: 0;
    padding: 0 10px;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .session-filter:has(input:disabled) {
    opacity: 0.72;
  }

  .session-filter:focus-within {
    background: var(--color-surface);
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    color: var(--color-ink);
  }

  .session-filter input {
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    font-size: 13px;
    min-height: 34px;
    min-width: 0;
    outline: none;
    width: 100%;
  }

  .session-empty {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.45;
    margin: 8px 4px 0;
  }

  .session-empty strong {
    color: var(--color-ink);
  }

  .session-empty p {
    margin: 4px 0 10px;
  }

  .session-empty a {
    color: var(--color-primary);
    font-weight: 650;
    text-decoration: none;
  }

  .session-empty a:hover {
    text-decoration: underline;
  }

  .session-unavailable {
    align-items: flex-start;
    background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface-soft));
    border: 1px solid color-mix(in srgb, var(--color-warning) 28%, transparent);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: flex;
    gap: 8px;
    margin-top: 4px;
    padding: 10px;
  }

  .session-unavailable :global(svg) {
    color: var(--color-warning);
    flex-shrink: 0;
    margin-top: 1px;
  }

  .session-unavailable strong {
    color: var(--color-ink);
    display: block;
    font-size: 13px;
    font-weight: 650;
    line-height: 1.35;
  }

  .session-unavailable p {
    font-size: 12px;
    line-height: 1.45;
    margin: 4px 0 0;
  }

  .session-groups {
    display: grid;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    padding: 4px 0 2px;
  }

  .session-group {
    min-width: 0;
  }

  .session-group > summary {
    align-items: center;
    border-radius: var(--rounded-sm);
    color: var(--color-ink-disabled);
    cursor: pointer;
    display: flex;
    font-size: 11px;
    font-weight: 600;
    justify-content: space-between;
    letter-spacing: 0.06em;
    list-style: none;
    margin: 0 4px 4px;
    min-height: 28px;
    padding: 0 4px 0 6px;
    text-transform: uppercase;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .session-group > summary::-webkit-details-marker {
    display: none;
  }

  .session-group > summary:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .session-group > summary:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .group-meta {
    align-items: center;
    display: inline-flex;
    gap: 3px;
  }

  .group-count {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 10px;
    letter-spacing: 0;
    line-height: 1;
    min-width: 18px;
    padding: 4px 6px;
    text-align: center;
  }

  .group-disclosure {
    display: inline-flex;
    transition: transform 120ms ease;
  }

  .session-group:not([open]) .group-disclosure {
    transform: rotate(-90deg);
  }

  .session-group-items {
    display: grid;
    gap: 2px;
  }

  .session-item {
    border-radius: 8px;
    color: var(--color-ink-muted);
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    text-decoration: none;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .session-item-row {
    min-width: 0;
    position: relative;
  }

  .session-item.child {
    margin-left: calc(var(--session-depth, 1) * 18px);
    padding-left: 12px;
  }

  .session-item.orphan {
    background: color-mix(in srgb, var(--color-warning) 9%, var(--color-surface-soft));
    color: var(--color-ink-subtle);
  }

  .side-thread-meta {
    color: var(--color-ink-disabled);
    font-size: 10px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-item.has-action {
    padding-right: 76px;
  }

  .session-actions {
    display: flex;
    gap: 4px;
    position: absolute;
    right: 7px;
    top: 7px;
  }

  .session-actions form {
    margin: 0;
  }

  .session-actions button {
    align-items: center;
    background: color-mix(in srgb, var(--color-surface) 82%, transparent);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    height: 28px;
    justify-content: center;
    padding: 0;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
    width: 28px;
  }

  .session-actions button:hover {
    background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
    border-color: color-mix(in srgb, var(--color-danger) 28%, var(--color-border));
    color: var(--color-danger);
  }

  .session-actions button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .session-item:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .session-item.active {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .session-item strong {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-title-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .session-title-row strong {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-status {
    align-items: center;
    color: var(--color-ink-subtle);
    display: inline-flex;
    font-size: 10px;
    font-weight: 700;
    gap: 5px;
    line-height: 1;
    min-width: 0;
    text-transform: capitalize;
  }

  .session-status > span:first-child {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    display: inline-block;
    height: 6px;
    width: 6px;
  }

  .session-status > span:last-child {
    max-width: 64px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-status.running > span:first-child,
  .session-status.queued > span:first-child,
  .session-status.ready > span:first-child,
  .session-status.active > span:first-child {
    background: var(--color-primary);
  }

  .session-status.completed > span:first-child,
  .session-status.succeeded > span:first-child {
    background: var(--color-success);
  }

  .session-status.blocked > span:first-child,
  .session-status.pending > span:first-child {
    background: var(--color-warning);
  }

  .session-status.archived > span:first-child {
    background: var(--color-warning);
  }

  .session-status.failed > span:first-child,
  .session-status.error > span:first-child {
    background: var(--color-danger);
  }

  .session-item small {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 500;
  }

  .session-item.active small {
    color: color-mix(in srgb, var(--color-primary) 72%, var(--color-ink-subtle));
  }

  .sr-only {
    clip: rect(0, 0, 0, 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
</style>
