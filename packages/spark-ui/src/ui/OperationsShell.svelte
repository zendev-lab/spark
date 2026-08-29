<script lang="ts">
  import { tick, type Snippet } from "svelte";

  let {
    children,
    header,
    navigation,
    navigationAriaLabel,
    navigationId,
    closeNavigationLabel,
    contextBar,
    skipLink,
    showNavigation = true,
    navigationSize = "default",
    contentMode = "padded",
    mainId = "operations-main",
    navigationKey = "",
    designDirection,
  }: {
    children: Snippet;
    header: Snippet<[navigationExpanded: boolean, toggleNavigation: () => void]>;
    navigation?: Snippet<[closeNavigation: () => void]>;
    navigationAriaLabel: string;
    navigationId: string;
    closeNavigationLabel: string;
    contextBar?: Snippet;
    skipLink?: Snippet;
    showNavigation?: boolean;
    navigationSize?: "default" | "compact";
    contentMode?: "padded" | "flush";
    mainId?: string;
    navigationKey?: string;
    designDirection?: string;
  } = $props();

  let navigationOpen = $state(false);
  let navigationElement = $state<HTMLElement | null>(null);
  let lastNavigationKey = $state<string | null>(null);

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

  $effect(() => {
    const nextNavigationKey = navigationKey;
    if (lastNavigationKey === null) {
      lastNavigationKey = nextNavigationKey;
      return;
    }
    if (lastNavigationKey === nextNavigationKey) return;
    lastNavigationKey = nextNavigationKey;
    closeNavigation();
  });

  $effect(() => {
    if (!navigationOpen || !showNavigation) return;
    void tick().then(() => {
      const firstInteractive = navigationElement?.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (firstInteractive ?? navigationElement)?.focus({ preventScroll: true });
    });
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
  class="operations-shell"
  class:compact-navigation={navigationSize === "compact"}
  class:no-navigation={!showNavigation}
  data-impeccable-direction={designDirection}
>
  {@render header(navigationOpen, toggleNavigation)}

  <div class="operations-shell-body">
    {#if showNavigation && navigation}
      {#if navigationOpen}
        <button
          class="operations-shell-navigation-backdrop"
          type="button"
          aria-label={closeNavigationLabel}
          onclick={dismissNavigation}
        ></button>
      {/if}

      <aside
        bind:this={navigationElement}
        class="operations-shell-navigation"
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

    <div class="operations-shell-workspace" inert={navigationOpen ? true : undefined}>
      {#if skipLink}{@render skipLink()}{/if}
      {#if contextBar}
        <div class="operations-shell-contextbar">{@render contextBar()}</div>
      {/if}
      <main id={mainId} tabindex="-1" class="operations-shell-content" class:flush={contentMode === "flush"}>
        {@render children()}
      </main>
    </div>
  </div>
</div>

<style>
  .operations-shell {
    --operations-shell-navigation-width: var(--shell-sidebar-width);
    --operations-shell-mobile-navigation-width: 320px;
    display: grid;
    grid-template-rows: var(--shell-topbar-height) minmax(0, 1fr);
    height: 100dvh;
    overflow: hidden;
  }

  .operations-shell.compact-navigation {
    --operations-shell-navigation-width: var(--shell-sidebar-width-compact);
    --operations-shell-mobile-navigation-width: 280px;
  }

  .operations-shell-body {
    display: grid;
    grid-template-columns: var(--operations-shell-navigation-width) minmax(0, 1fr);
    min-height: 0;
  }

  .operations-shell.no-navigation .operations-shell-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .operations-shell-navigation {
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .operations-shell-navigation:focus {
    outline: none;
  }

  .operations-shell-workspace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    position: relative;
  }

  .operations-shell-contextbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    flex: 0 0 42px;
    min-width: 0;
    padding: 0 var(--spacing-xl);
  }

  .operations-shell-content {
    container-type: inline-size;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: var(--spacing-xl) var(--spacing-xxl) var(--spacing-section);
  }

  .operations-shell-content.flush {
    overflow: hidden;
    padding: 0;
  }

  .operations-shell-navigation-backdrop {
    display: none;
  }

  @media (max-width: 1000px) {
    .operations-shell:not(.compact-navigation) {
      --operations-shell-navigation-width: var(--shell-sidebar-width-compact);
    }
  }

  @media (max-width: 900px) {
    .operations-shell-body {
      grid-template-columns: minmax(0, 1fr);
    }

    .operations-shell-navigation {
      box-shadow: var(--shadow-popover);
      height: calc(100dvh - var(--shell-topbar-height));
      inset: var(--shell-topbar-height) auto 0 0;
      max-width: min(var(--operations-shell-mobile-navigation-width), 88vw);
      opacity: 0;
      position: fixed;
      transform: translateX(-100%);
      transition:
        opacity var(--motion-default) ease,
        transform var(--motion-default) ease,
        visibility var(--motion-default) ease;
      visibility: hidden;
      width: min(var(--operations-shell-mobile-navigation-width), 88vw);
      z-index: 55;
    }

    .operations-shell-navigation.mobile-open {
      opacity: 1;
      transform: translateX(0);
      visibility: visible;
    }

    .operations-shell-navigation-backdrop {
      background: var(--color-overlay);
      border: 0;
      display: block;
      inset: var(--shell-topbar-height) 0 0;
      padding: 0;
      position: fixed;
      z-index: 50;
    }

    .operations-shell-content {
      padding: var(--spacing-lg) var(--spacing-md) var(--spacing-xxl);
    }

    .operations-shell-contextbar {
      padding: 0 var(--spacing-md);
    }
  }
</style>
