<script lang="ts">
  import { tick, type Snippet } from "svelte";

  import type { AppMessages } from "$lib/i18n";
  import HubTopbar from "./HubTopbar.svelte";
  import type { HubSearchSession, HubSearchWorkspace } from "./hub-search";
  import "./shell-nav-link.css";

  type ContentMode = "padded" | "flush";
  type NavigationSize = "default" | "compact";

  interface Props {
    activeWorkspace?: HubSearchWorkspace | null;
    children: Snippet;
    closeNavigationLabel: string;
    common: AppMessages["common"];
    contentMode?: ContentMode;
    contextBar?: Snippet;
    layout: AppMessages["layout"];
    navigation: Snippet<[closeNavigation: () => void]>;
    navigationAriaLabel: string;
    navigationId: string;
    navigationSize?: NavigationSize;
    pathname: string;
    sessions?: HubSearchSession[];
    sessionMessages: AppMessages["sessions"];
    showNavigation?: boolean;
    showNavigationToggle?: boolean;
    showWorkspaceMenu?: boolean;
    workspaceHref: (workspace: HubSearchWorkspace) => string;
    workspaces?: HubSearchWorkspace[];
  }

  let {
    activeWorkspace = null,
    children,
    closeNavigationLabel,
    common,
    contentMode = "padded",
    contextBar,
    layout,
    navigation,
    navigationAriaLabel,
    navigationId,
    navigationSize = "default",
    pathname,
    sessions = [],
    sessionMessages,
    showNavigation = true,
    showNavigationToggle = true,
    showWorkspaceMenu = true,
    workspaceHref,
    workspaces = [],
  }: Props = $props();

  let navigationOpen = $state(false);
  let navigationElement = $state<HTMLElement | null>(null);
  let lastPathname = $state<string | null>(null);

  $effect(() => {
    const nextPathname = pathname;
    if (lastPathname === nextPathname) return;
    lastPathname = nextPathname;
    closeNavigation();
  });

  $effect(() => {
    if (!navigationOpen || !showNavigation) return;

    void tick().then(() => {
      if (!navigationOpen) return;
      const firstInteractive = navigationElement?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (firstInteractive ?? navigationElement)?.focus({ preventScroll: true });
    });
  });

  function toggleNavigation() {
    navigationOpen = !navigationOpen;
  }

  function closeNavigation() {
    navigationOpen = false;
  }

  function dismissNavigation() {
    if (!navigationOpen) return;
    navigationOpen = false;
    void tick().then(() => {
      document
        .querySelector<HTMLButtonElement>(`button[aria-controls="${navigationId}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !navigationOpen) return;
    event.preventDefault();
    dismissNavigation();
  }

  function trapNavigationTab(event: KeyboardEvent) {
    if (event.key !== "Tab" || !navigationOpen || !navigationElement) return;
    const focusables = Array.from(
      navigationElement.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
  class="hub-shell"
  class:compact-navigation={navigationSize === "compact"}
  class:no-navigation={!showNavigation}
>
  <HubTopbar
    {activeWorkspace}
    {common}
    {layout}
    navigationControls={navigationId}
    navigationExpanded={navigationOpen}
    onToggleNavigation={toggleNavigation}
    {sessions}
    {sessionMessages}
    showNavigationToggle={showNavigation && showNavigationToggle}
    {showWorkspaceMenu}
    {workspaceHref}
    {workspaces}
  />

  <div class="hub-shell-body">
    {#if showNavigation}
      {#if navigationOpen}
        <button
          class="hub-shell-navigation-backdrop"
          type="button"
          aria-label={closeNavigationLabel}
          onclick={dismissNavigation}
        ></button>
      {/if}

      <aside
        bind:this={navigationElement}
        class="hub-shell-navigation"
        class:mobile-open={navigationOpen}
        id={navigationId}
        aria-label={navigationAriaLabel}
        role={navigationOpen ? "dialog" : undefined}
        aria-modal={navigationOpen ? true : undefined}
        tabindex="-1"
        onkeydown={trapNavigationTab}
      >
        {@render navigation(closeNavigation)}
      </aside>
    {/if}

    <div class="hub-shell-workspace" inert={navigationOpen ? true : undefined}>
      <a class="skip-link" href="#hub-main-content">{layout.aria.skipToContent}</a>
      {#if contextBar}
        <div class="hub-shell-contextbar">
          {@render contextBar()}
        </div>
      {/if}

      <main id="hub-main-content" tabindex="-1" class="hub-shell-content" class:flush={contentMode === "flush"}>
        {@render children()}
      </main>
    </div>
  </div>
</div>

<style>
  .hub-shell {
    --hub-shell-navigation-width: var(--shell-sidebar-width);
    --hub-shell-mobile-navigation-width: 320px;
    display: grid;
    grid-template-rows: var(--shell-topbar-height) minmax(0, 1fr);
    height: 100dvh;
    overflow: hidden;
  }

  .hub-shell.compact-navigation {
    --hub-shell-navigation-width: var(--shell-sidebar-width-compact);
    --hub-shell-mobile-navigation-width: 280px;
  }

  .hub-shell-body {
    display: grid;
    grid-template-columns: var(--hub-shell-navigation-width) minmax(0, 1fr);
    min-height: 0;
  }

  .hub-shell.no-navigation .hub-shell-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .hub-shell-navigation {
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .hub-shell-navigation:focus {
    outline: none;
  }

  .hub-shell-workspace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .skip-link {
    background: var(--color-primary);
    border-radius: var(--rounded-sm);
    clip-path: inset(50%);
    color: var(--color-primary-foreground);
    font-size: 13px;
    font-weight: 700;
    height: 1px;
    left: var(--spacing-md);
    overflow: hidden;
    padding: 0;
    position: absolute;
    text-decoration: none;
    top: var(--spacing-sm);
    white-space: nowrap;
    width: 1px;
    z-index: 200;
  }

  .skip-link:focus-visible {
    clip-path: none;
    height: auto;
    overflow: visible;
    padding: 8px 12px;
    width: auto;
  }

  .hub-shell-contextbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    flex: 0 0 42px;
    min-width: 0;
    padding: 0 var(--spacing-xl);
  }

  .hub-shell-content {
    container-type: inline-size;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: var(--spacing-xl) var(--spacing-xxl) var(--spacing-section);
  }

  .hub-shell-content.flush {
    overflow: hidden;
    padding: 0;
  }

  .hub-shell-navigation-backdrop {
    display: none;
  }

  @media (max-width: 1000px) {
    .hub-shell:not(.compact-navigation) {
      --hub-shell-navigation-width: var(--shell-sidebar-width-compact);
    }
  }

  @media (max-width: 900px) {
    .hub-shell-body {
      grid-template-columns: minmax(0, 1fr);
    }

    .hub-shell-navigation {
      box-shadow: var(--shadow-popover);
      height: calc(100dvh - var(--shell-topbar-height));
      inset: var(--shell-topbar-height) auto 0 0;
      max-width: min(var(--hub-shell-mobile-navigation-width), 88vw);
      opacity: 0;
      position: fixed;
      transform: translateX(-100%);
      transition:
        opacity var(--motion-default) ease,
        transform var(--motion-default) ease,
        visibility var(--motion-default) ease;
      visibility: hidden;
      width: min(var(--hub-shell-mobile-navigation-width), 88vw);
      z-index: 55;
    }

    .hub-shell-navigation.mobile-open {
      opacity: 1;
      transform: translateX(0);
      visibility: visible;
    }

    .hub-shell-navigation-backdrop {
      background: rgb(15 23 42 / 24%);
      border: 0;
      display: block;
      inset: var(--shell-topbar-height) 0 0;
      padding: 0;
      position: fixed;
      z-index: 50;
    }

    .hub-shell-content:not(.flush) {
      padding: var(--spacing-lg) var(--spacing-md) var(--spacing-xxl);
    }
  }

  @media (max-width: 640px) {
    .hub-shell-contextbar {
      padding-inline: var(--spacing-md);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hub-shell-navigation {
      transition: none;
    }
  }
</style>
