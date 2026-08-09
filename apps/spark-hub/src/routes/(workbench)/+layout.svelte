<script lang="ts">
  import { browser } from "$app/environment";
  import { invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import { Icon } from "@zendev-lab/spark-ui";
  import {
    parsePendingAskEvent,
    pendingAskEventCursor,
    shouldInvalidatePendingAsk,
  } from "$lib/pending-ask";
  import WorkbenchSessionRail from "$lib/WorkbenchSessionRail.svelte";
  import HubShell from "$lib/shell/HubShell.svelte";
  import type { HubSearchSession } from "$lib/shell/hub-search";
  import {
    buildWorkbenchNavItems,
    isWorkbenchNavItemActive,
    settingsHubHref,
    workspaceSwitcherHrefForPage,
  } from "$lib/workbench-nav";
  import { workbenchSessionIdFromPath, workspacePath } from "$lib/workspace-routes";
  import {
    readOrCreateOccupancyClientId,
    startWorkspaceOccupancyHeartbeat,
  } from "$lib/workspace-occupancy-client";

  interface SessionRecord extends HubSearchSession {
    activityUpdatedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let common = $derived(data.messages.common);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let activeWorkspaceId = $derived(data.activeWorkspace?.id ?? null);
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let settingsHref = $derived(settingsHubHref(data.activeWorkspace?.slug));
  let selectedSessionId = $derived(workbenchSessionIdFromPath(page.url.pathname));
  let isWorkspaceDirectory = $derived(page.url.pathname === "/");
  let sidebarSessions = $derived((data.sessions ?? []) as SessionRecord[]);
  let navItems = $derived(
    buildWorkbenchNavItems({
      activeWorkspacePath,
      hasActiveWorkspace: Boolean(data.activeWorkspace) && !isWorkspaceDirectory,
      nav: t.nav,
    }),
  );
  let contentMode: "flush" | "padded" = $derived(
    !isWorkspaceDirectory && page.url.pathname.includes("/sessions") ? "flush" : "padded",
  );

  $effect(() => {
    const workspaceId = activeWorkspaceId;
    if (!browser || !workspaceId || isWorkspaceDirectory) return;

    const clientId = readOrCreateOccupancyClientId();
    if (!clientId) return;
    return startWorkspaceOccupancyHeartbeat({ workspaceId, clientId });
  });

  $effect(() => {
    const workspaceId = activeWorkspaceId;
    if (!browser || !workspaceId) return;

    let stopped = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let invalidationTimer: number | undefined;

    const invalidatePendingAsk = () => {
      if (invalidationTimer !== undefined) return;
      invalidationTimer = window.setTimeout(() => {
        invalidationTimer = undefined;
        void invalidateAll();
      }, 100);
    };

    const connect = () => {
      if (stopped) return;
      const url = new URL("/api/v1/events", window.location.origin);
      const cursor = readPendingAskCursor();
      if (cursor) url.searchParams.set("cursor", cursor);

      eventSource = new EventSource(url);
      eventSource.addEventListener("spark-hub.event", (message) => {
        const event = parsePendingAskEvent(message.data);
        if (!event) return;
        writePendingAskCursor(pendingAskEventCursor(event));
        if (shouldInvalidatePendingAsk(event, workspaceId)) invalidatePendingAsk();
      });
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        if (!stopped) reconnectTimer = window.setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      stopped = true;
      eventSource?.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (invalidationTimer !== undefined) window.clearTimeout(invalidationTimer);
    };
  });

  function isActive(href: string) {
    return isWorkbenchNavItemActive({
      pathname: page.url.pathname,
      href,
      activeWorkspacePath,
    });
  }

  let workspaceSwitcherHref = $derived(
    workspaceSwitcherHrefForPage({ url: page.url, activeWorkspacePath, workspacePath }),
  );

  const pendingAskCursorKey = "spark-hub:pending-ask:events-cursor";

  function readPendingAskCursor() {
    try {
      return window.sessionStorage.getItem(pendingAskCursorKey);
    } catch {
      return null;
    }
  }

  function writePendingAskCursor(cursor: string) {
    try {
      window.sessionStorage.setItem(pendingAskCursorKey, cursor);
    } catch {
      // Database-backed layout loading remains authoritative when storage is unavailable.
    }
  }
</script>

{#snippet navigation(closeNavigation: () => void)}
  <div class="workbench-navigation">
    <WorkbenchSessionRail
      sessions={sidebarSessions}
      workspaces={workspaceOptions}
      activeWorkspaceId={data.activeWorkspace?.id ?? null}
      selectedSessionId={selectedSessionId}
      sessionsAvailable={data.sessionsAvailable}
      sessionControlAvailable={data.sessionControlAvailable}
      showArchived={data.sessionRailShowArchived}
      archivedToggleHref={data.sessionRailArchivedToggleHref}
      locale={data.locale}
      {common}
      messages={{
        newSession: data.messages.sessions.newSession,
        searchPlaceholder: data.messages.sessions.searchPlaceholder,
        emptyTitle: data.messages.sessions.emptyTitle,
        emptyBody: data.messages.sessions.emptyBody,
        daemonUnavailableTitle: data.messages.sessions.daemonUnavailableTitle,
        daemonUnavailableBody: data.messages.sessions.daemonUnavailableBody,
        listLabel: data.messages.sessions.listLabel,
        untitledConversation: data.messages.sessions.untitledConversation,
        unknownWorkspace: data.messages.sessions.unknownWorkspace,
        channelSessionBadge: data.messages.sessions.channelSessionBadge,
        channelLabels: data.messages.sessions.channelLabels,
        sessionTypes: data.messages.sessions.sessionTypes,
        archiveSubmit: data.messages.sessions.archiveSubmit,
        showArchived: data.messages.sessions.showArchived,
        hideArchived: data.messages.sessions.hideArchived,
        archivedLabel: data.messages.sessions.archivedLabel,
        orphanedSideThreads: data.messages.sessions.orphanedSideThreads,
        sideThreadRailLabel: data.messages.sessions.sideThreadRailLabel,
      }}
    />

    <nav class="secondary-nav" aria-label={t.aria.workspaceNavigation}>
      {#each navItems as item}
        <a
          class="shell-nav-link workbench-nav-link"
          class:active={isActive(item.href)}
          href={item.href}
          aria-current={isActive(item.href) ? "page" : undefined}
          onclick={closeNavigation}
        >
          <Icon name={item.icon} size={18} />
          <span>{item.label}</span>
        </a>
      {/each}
      <a
        class="shell-nav-link workbench-nav-link"
        class:active={page.url.pathname === "/delegations" || page.url.pathname.endsWith("/delegations")}
        aria-current={page.url.pathname === "/delegations" || page.url.pathname.endsWith("/delegations") ? "page" : undefined}
        href={activeWorkspacePath ? `${activeWorkspacePath}/delegations` : "/delegations"}
        onclick={closeNavigation}
      >
        <Icon name="users" size={18} />
        <span>{t.nav.delegations}</span>
      </a>
      <a
        class="shell-nav-link workbench-nav-link"
        href={settingsHref}
        onclick={closeNavigation}
      >
        <Icon name="settings" size={18} stroke={2.2} />
        <span>{t.user.settings}</span>
      </a>
    </nav>
  </div>
{/snippet}

<HubShell
  activeWorkspace={isWorkspaceDirectory ? null : data.activeWorkspace}
  {children}
  closeNavigationLabel={t.aria.closeWorkspaceNavigation}
  {common}
  {contentMode}
  layout={t}
  {navigation}
  navigationAriaLabel={t.aria.workspaceNavigation}
  navigationId="workbench-sidebar"
  pathname={page.url.pathname}
  sessions={sidebarSessions}
  sessionMessages={data.messages.sessions}
  showNavigation={!isWorkspaceDirectory}
  showNavigationToggle={!isWorkspaceDirectory}
  showWorkspaceMenu={!isWorkspaceDirectory}
  workspaceHref={workspaceSwitcherHref}
  workspaces={workspaceOptions}
/>

<style>
  .workbench-navigation {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    min-height: 0;
    padding: 10px;
  }

  .secondary-nav {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    flex: 0 0 auto;
    gap: 2px;
    padding-top: 8px;
  }

  .workbench-nav-link {
    font-weight: 500;
  }
</style>
