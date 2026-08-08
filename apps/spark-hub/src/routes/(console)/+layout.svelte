<script lang="ts">
  import { page } from "$app/state";
  import { Icon } from "@zendev-lab/spark-ui";
  import {
    buildConsoleNavGroups,
    HUB_SETTINGS_HREF,
    currentConsolePageLabel,
    isConsoleNavItemActive,
    isControlPlanePath,
  } from "$lib/console-nav";
  import HubShell from "$lib/shell/HubShell.svelte";
  import type { HubSearchSession } from "$lib/shell/hub-search";
  import { workspaceSwitcherHrefForPage } from "$lib/workbench-nav";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let consoleMessages = $derived(data.messages.console);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let searchSessions = $derived((data.sessions ?? []) as HubSearchSession[]);
  let isControlPlane = $derived(
    data.isGlobalConsole ?? isControlPlanePath(page.url.pathname),
  );
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let hasActiveWorkspace = $derived(Boolean(data.activeWorkspace));
  let navLabels = $derived({
    createWorkspace: t.user.createWorkspace,
    webAccess: consoleMessages.nav.webAccess,
    workspaceDetails: consoleMessages.nav.workspaceDetails,
    channels: t.nav.channels,
    registration: consoleMessages.nav.registration,
    modelsProviders: t.nav.models,
    invocationDiagnostics: data.messages.invocationDiagnostics.navLabel,
    updateStatus: data.messages.updateStatus.navLabel,
  });
  let navGroups = $derived(
    buildConsoleNavGroups({
      workspaceHrefPrefix: hasActiveWorkspace ? activeWorkspacePath : null,
      includeControlPlaneNav: isControlPlane || !hasActiveWorkspace,
      includeWorkspaceNav: !isControlPlane && hasActiveWorkspace,
      nav: navLabels,
      groups: {
        hub: consoleMessages.navGroups.hub,
        daemon: consoleMessages.navGroups.daemon,
        workspace: data.activeWorkspace
          ? `${consoleMessages.navGroups.workspace} · ${data.activeWorkspace.name}`
          : consoleMessages.navGroups.workspace,
      },
    }),
  );

  function isActive(href: string) {
    return isConsoleNavItemActive({ pathname: page.url.pathname, href });
  }

  let workspaceSwitcherHref = $derived(
    workspaceSwitcherHrefForPage({ url: page.url, activeWorkspacePath, workspacePath }),
  );
</script>

{#snippet navigation(closeNavigation: () => void)}
  <div class="console-navigation">
    <nav>
      {#each navGroups as group}
        <section class="nav-group" aria-labelledby={`console-nav-${group.id}`}>
          <h2 class="nav-group-label" id={`console-nav-${group.id}`}>{group.label}</h2>
          <div class="nav-group-items">
            {#each group.items as item}
              <a
                class="shell-nav-link"
                class:active={isActive(item.href)}
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                onclick={closeNavigation}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
              </a>
            {/each}
          </div>
        </section>
      {/each}
    </nav>

    {#if !isControlPlane && hasActiveWorkspace}
      <div class="console-nav-footer">
        <a
          class="shell-nav-link hub-settings-link"
          href={HUB_SETTINGS_HREF}
          onclick={closeNavigation}
        >
          <Icon name="settings" size={18} />
          <span>{consoleMessages.openHubSettings}</span>
        </a>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet contextBar()}
  <nav class="breadcrumb" aria-label={t.aria.breadcrumb}>
    <span>{consoleMessages.badge}</span>
    <Icon name="chevron" size={14} stroke={2.2} />
    {#if data.activeWorkspace && !isControlPlane}
      <a href={activeWorkspacePath}>{data.activeWorkspace.name}</a>
      <Icon name="chevron" size={14} stroke={2.2} />
    {/if}
    <span aria-current="page">{currentConsolePageLabel({ pathname: page.url.pathname, nav: navLabels })}</span>
  </nav>
{/snippet}

<HubShell
  activeWorkspace={isControlPlane ? null : data.activeWorkspace}
  {children}
  closeNavigationLabel={t.aria.closeWorkspaceNavigation}
  common={data.messages.common}
  contentMode="padded"
  {contextBar}
  layout={t}
  {navigation}
  navigationAriaLabel={consoleMessages.ariaNavigation}
  navigationId="console-navigation"
  navigationSize="compact"
  pathname={page.url.pathname}
  sessions={searchSessions}
  sessionMessages={data.messages.sessions}
  showWorkspaceMenu={!isControlPlane}
  workspaceHref={workspaceSwitcherHref}
  workspaces={workspaceOptions}
/>

<style>
  .console-navigation {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 14px;
  }

  .console-navigation > nav {
    flex: 1 1 auto;
    min-height: 0;
  }

  .console-nav-footer {
    border-top: 1px solid var(--color-border);
    flex: 0 0 auto;
    margin-top: auto;
    padding-top: 12px;
  }

  .nav-group {
    display: grid;
    gap: 7px;
    margin-bottom: 20px;
  }

  .nav-group-label {
    color: var(--color-ink-disabled);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.06em;
    margin: 0;
    padding: 0 10px;
    text-transform: uppercase;
  }

  .nav-group-items {
    display: grid;
    gap: 2px;
  }

  .breadcrumb {
    align-items: center;
    color: var(--color-ink-disabled);
    display: flex;
    font-size: 12px;
    font-weight: 700;
    gap: 8px;
    min-width: 0;
  }

  .breadcrumb a {
    color: var(--color-ink-subtle);
    min-width: 0;
    overflow: hidden;
    text-decoration: none;
    text-overflow: ellipsis;
  }

  .breadcrumb a:hover {
    color: var(--color-primary);
  }

  .breadcrumb > span:last-child {
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
