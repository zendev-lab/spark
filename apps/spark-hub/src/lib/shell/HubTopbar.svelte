<script lang="ts">
  import { Icon } from "@zendev-lab/spark-ui";
  import {
    PopoverContent,
    PopoverPortal,
    PopoverRoot,
    PopoverTrigger,
  } from "@zendev-lab/spark-ui/headless";
  import { statusLabel, type AppMessages } from "$lib/i18n";
  import SparkLogo from "$lib/SparkLogo.svelte";
  import HubSearch from "./HubSearch.svelte";
  import type { HubDaemonSummary, HubSearchSession, HubSearchWorkspace } from "./hub-search";

  interface Props {
    activeWorkspace?: HubSearchWorkspace | null;
    canManageDaemonAccess?: boolean;
    common: AppMessages["common"];
    daemons?: HubDaemonSummary[];
    layout: AppMessages["layout"];
    navigationControls: string;
    navigationExpanded: boolean;
    onToggleNavigation: () => void;
    sessions?: HubSearchSession[];
    sessionMessages: AppMessages["sessions"];
    showNavigationToggle?: boolean;
    showDaemonMenu?: boolean;
    workspaces?: HubSearchWorkspace[];
  }

  let {
    activeWorkspace = null,
    canManageDaemonAccess = false,
    common,
    daemons = [],
    layout,
    navigationControls,
    navigationExpanded,
    onToggleNavigation,
    sessions = [],
    sessionMessages,
    showNavigationToggle = true,
    showDaemonMenu = true,
    workspaces = [],
  }: Props = $props();

  let accountMenuOpen = $state(false);
  let daemonSummary = $derived(
    daemons.length === 0
      ? layout.user.noDaemons
      : daemons.length === 1
        ? (daemons[0]?.name ?? layout.user.daemonSection)
        : layout.user.daemonCount.replace("{count}", String(daemons.length)),
  );
  let homeHref = $derived("/");

  function closeAccountMenu() {
    accountMenuOpen = false;
  }
</script>

<header class="hub-topbar">
  <div class="topbar-brand">
    {#if showNavigationToggle}
      <button
        class="navigation-toggle"
        type="button"
        aria-controls={navigationControls}
        aria-expanded={navigationExpanded}
        aria-label={layout.aria.workbenchNavigation}
        onclick={onToggleNavigation}
      >
        <Icon name={navigationExpanded ? "close" : "menu"} size={18} stroke={2.2} />
      </button>
    {/if}
    <a class="brand-mark" href={homeHref} aria-label={layout.aria.home}>
      <SparkLogo size={32} />
      <span class="brand-name">{layout.brand.name}</span>
    </a>
  </div>

  <HubSearch
    {activeWorkspace}
    {common}
    {sessions}
    {workspaces}
    {layout}
    {sessionMessages}
  />

  {#if showDaemonMenu}
    <PopoverRoot bind:open={accountMenuOpen}>
      <div class="account-menu">
        <PopoverTrigger class="user-menu" aria-label={layout.aria.daemonMenu}>
          <span class="daemon-avatar" aria-hidden="true">
            <Icon name="activity" size={15} stroke={2.2} />
          </span>
          <span class="user-copy">{daemonSummary}</span>
          <Icon name="chevron-down" size={14} stroke={2.4} />
        </PopoverTrigger>

        <PopoverPortal>
          <PopoverContent
            class="account-popover"
            aria-label={layout.aria.daemonMenu}
            align="end"
            side="bottom"
            sideOffset={7}
          >
            <div class="account-menu-label">{layout.user.authorizedDaemons}</div>
            {#if daemons.length === 0}
              <div class="account-menu-empty">{layout.user.noDaemons}</div>
            {:else}
              <div class="daemon-list">
                {#each daemons as daemon (daemon.id)}
                  <div class="daemon-item">
                    <span class="daemon-status {daemon.status}" aria-hidden="true"></span>
                    <span class="daemon-item-copy">
                      <strong>{daemon.name}</strong>
                      <small>{statusLabel(daemon.status, common)}</small>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if canManageDaemonAccess}
              <a class="daemon-access-link" href="/settings/access" onclick={closeAccountMenu}>
                <Icon name="settings" size={16} stroke={2.2} />
                <span>{layout.user.manageDaemonAccess}</span>
              </a>
            {/if}
          </PopoverContent>
        </PopoverPortal>
      </div>
    </PopoverRoot>
  {:else}
    <div class="topbar-trailing" aria-hidden="true"></div>
  {/if}
</header>

<style>
  button {
    font: inherit;
  }

  .hub-topbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr);
    height: var(--shell-topbar-height);
    padding: 0 14px 0 16px;
    position: relative;
    z-index: 60;
  }

  .topbar-trailing {
    justify-self: end;
    min-width: 0;
  }

  .topbar-brand {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-self: start;
    min-width: 0;
  }

  .brand-mark {
    align-items: center;
    color: var(--color-ink);
    display: inline-flex;
    gap: 8px;
    min-width: 0;
    text-decoration: none;
  }

  .brand-name {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .navigation-toggle {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 7px;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: none;
    flex: 0 0 auto;
    height: 32px;
    justify-content: center;
    padding: 0;
    width: 32px;
  }

  .navigation-toggle:hover,
  .navigation-toggle:focus-visible {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .navigation-toggle:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .account-menu {
    justify-self: end;
    position: relative;
  }

  :global(.user-menu) {
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    gap: 8px;
    min-height: 40px;
    padding: 4px 7px;
  }

  :global(.user-menu:hover),
  :global(.user-menu:focus-visible),
  :global(.user-menu[data-state="open"]) {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  :global(.user-menu:focus-visible) {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .user-copy {
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 600;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .daemon-avatar {
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 6px;
    color: var(--color-primary);
    display: grid;
    flex: 0 0 auto;
    height: 26px;
    place-items: center;
    width: 26px;
  }

  :global(.account-popover) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-popover);
    min-width: 260px;
    overflow: hidden;
    padding: 6px;
    transform-origin: var(--bits-popover-content-transform-origin);
    animation: popover-in 120ms cubic-bezier(0.16, 1, 0.3, 1);
    z-index: 80;
  }

  @keyframes popover-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  :global(.account-menu-label) {
    color: var(--color-ink-disabled);
    font-size: 11px;
    font-weight: 600;
    padding: 6px 10px 4px;
  }

  :global(.account-menu-empty) {
    color: var(--color-ink-disabled);
    font-size: 12px;
    line-height: 1.45;
    padding: 4px 10px 10px;
  }

  :global(.daemon-list) {
    display: grid;
    gap: 2px;
    max-height: 220px;
    overflow: auto;
  }

  :global(.daemon-item),
  :global(.daemon-access-link) {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: grid;
    font-size: 13px;
    gap: 10px;
    grid-template-columns: 12px minmax(0, 1fr);
    min-height: 40px;
    padding: 6px 10px;
  }

  :global(.daemon-access-link) {
    border-top: 1px solid var(--color-border-soft);
    border-radius: 0 0 var(--rounded-md) var(--rounded-md);
    font-weight: 500;
    grid-template-columns: 16px minmax(0, 1fr);
    margin-top: 4px;
    padding-top: 10px;
    text-decoration: none;
  }

  :global(.daemon-access-link:hover),
  :global(.daemon-access-link:focus-visible) {
    background: var(--color-surface-soft);
    color: var(--color-ink);
    outline: none;
  }

  :global(.daemon-status) {
    background: var(--color-ink-disabled);
    border-radius: var(--rounded-full);
    height: 8px;
    width: 8px;
  }

  :global(.daemon-status.online) {
    background: var(--color-success);
  }

  :global(.daemon-status.draining) {
    background: var(--color-warning);
  }

  :global(.daemon-status.offline),
  :global(.daemon-status.disabled) {
    background: var(--color-danger);
  }

  :global(.daemon-item-copy) {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  :global(.daemon-item-copy strong),
  :global(.daemon-item-copy small) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.daemon-item-copy strong) {
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 600;
  }

  :global(.daemon-item-copy small) {
    color: var(--color-ink-subtle);
    font-size: 11px;
  }

  @media (max-width: 900px) {
    .navigation-toggle {
      display: inline-flex;
      height: 44px;
      width: 44px;
    }

    .hub-topbar {
      grid-template-columns: minmax(132px, 1fr) auto minmax(132px, 1fr);
    }
  }

  @media (max-width: 560px) {
    .hub-topbar {
      gap: 8px;
      grid-template-columns: auto minmax(0, 1fr) auto;
      padding: 0 8px;
    }

    .brand-name,
    .user-copy {
      display: none;
    }

    .brand-mark {
      gap: 0;
    }

    :global(.user-menu) {
      gap: 4px;
      min-height: 44px;
      padding-inline: 5px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.account-popover) { animation: none; }
  }
</style>
