<script lang="ts">
  import "@zendev-lab/spark-ui/tokens.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Button, Dialog, Icon, Input, OperationsShell, Select, type SelectGroup } from "@zendev-lab/spark-ui";
  import { DialogClose, DialogTitle } from "@zendev-lab/spark-ui/headless";
  import { webRpc } from "$lib/web-rpc";

  let { children, data } = $props();
  let copy = $derived(data.messages.web.shell);
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searching = $state(false);
  let searchError = $state("");
  let searchResults = $state<
    Array<{
      kind: "workspace" | "session" | "message" | "artifact";
      ref: string;
      title: string;
      summary?: string;
      workspaceId?: string;
      sessionId?: string;
      messageId?: string;
    }>
  >([]);
  let theme = $state<"light" | "dark" | "system">("system");
  let searchTrigger = $state<HTMLButtonElement | HTMLAnchorElement>();
  let themeGroups = $derived<SelectGroup[]>([
    {
      id: "theme",
      options: [
        { value: "system", label: copy.systemTheme },
        { value: "light", label: copy.lightTheme },
        { value: "dark", label: copy.darkTheme },
      ],
    },
  ]);
  let localeGroups = $derived<SelectGroup[]>([
    {
      id: "locale",
      options: [
        { value: "en", label: "EN" },
        { value: "zh-CN", label: "中文" },
      ],
    },
  ]);

  onMount(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/service-worker.js");
    }
    const storedTheme = localStorage.getItem("spark-web-theme");
    if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
      theme = storedTheme;
    }
    const media = matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () => applyTheme(theme, media.matches);
    applySystemTheme();
    media.addEventListener("change", applySystemTheme);
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchOpen = true;
        requestAnimationFrame(() => document.getElementById("spark-global-search")?.focus());
      }
    };
    addEventListener("keydown", keydown);
    return () => {
      media.removeEventListener("change", applySystemTheme);
      removeEventListener("keydown", keydown);
    };
  });

  function selectTheme(value: "light" | "dark" | "system") {
    theme = value;
    localStorage.setItem("spark-web-theme", value);
    applyTheme(value, matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyTheme(value: "light" | "dark" | "system", systemDark: boolean) {
    document.documentElement.dataset.sparkTheme =
      value === "system" ? (systemDark ? "dark" : "light") : value;
    document.documentElement.style.colorScheme = value === "system" ? "light dark" : value;
  }

  function toggleSearch() {
    if (searchOpen) {
      closeSearch();
      return;
    }
    searchOpen = true;
    requestAnimationFrame(() => document.getElementById("spark-global-search")?.focus());
  }

  function closeSearch() {
    searchOpen = false;
  }

  async function selectLocale(locale: "en" | "zh-CN") {
    const next = new URL(globalThis.location.href);
    next.searchParams.set("lang", locale);
    await goto(`${next.pathname}${next.search}${next.hash}`, { invalidateAll: true });
  }

  async function globalSearch(event?: Event) {
    event?.preventDefault();
    const query = searchQuery.trim();
    if (!query || searching) return;
    searching = true;
    searchError = "";
    try {
      searchResults = (await webRpc("search.global", { query, limit: 100 })).results;
    } catch (caught) {
      searchError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      searching = false;
    }
  }

  function resultHref(result: (typeof searchResults)[number]): string {
    if (result.sessionId) {
      const query = result.messageId ? `?message=${encodeURIComponent(result.messageId)}` : "";
      return `/sessions/${encodeURIComponent(result.sessionId)}${query}`;
    }
    if (result.workspaceId) return `/workspaces/${encodeURIComponent(result.workspaceId)}`;
    return "/";
  }

  function navCurrent(href: string): "page" | undefined {
    if (href === "/") return page.url.pathname === "/" ? "page" : undefined;
    return page.url.pathname.startsWith(href) ? "page" : undefined;
  }
</script>

<svelte:head>
  <title>Spark</title>
  <meta name="theme-color" content="#2563EB" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/spark.svg" />
</svelte:head>

{#snippet shellHeader(navigationExpanded: boolean, toggleNavigation: () => void)}
  <header class="top">
    <div class="top-brand">
      <button
        class="navigation-toggle"
        type="button"
        aria-controls="spark-primary-navigation"
        aria-expanded={navigationExpanded}
        aria-label={copy.primaryNavigation}
        onclick={toggleNavigation}
      >
        <Icon name={navigationExpanded ? "close" : "menu"} size={18} />
      </button>
      <a href="/" class="brand"><span aria-hidden="true"><Icon name="spark" size={17} /></span><span>Spark</span></a>
    </div>
    <div class="top-actions">
      <Button bind:element={searchTrigger} variant="ghost" size="compact" ariaExpanded={searchOpen} onclick={toggleSearch}>
        <Icon name="search" size={15} />
        <span>{copy.search}</span>
        <kbd>⌘K</kbd>
      </Button>
      <Select id="spark-theme" value={theme} groups={themeGroups} label={copy.theme} compact fit onValueChange={(value) => selectTheme(value as "light" | "dark" | "system")} />
      <Select id="spark-locale" value={data.locale} groups={localeGroups} label={copy.language} compact fit onValueChange={(value) => void selectLocale(value as "en" | "zh-CN")} />
    </div>
  </header>
{/snippet}

{#snippet navigation(closeNavigation: () => void)}
  <div class="scope-navigation">
    <nav aria-label={copy.primaryNavigation}>
      <a href="/" aria-current={navCurrent("/")} onclick={closeNavigation}><Icon name="new-message" size={17} /><span>{copy.overview}</span></a>
      <a href="/sessions" aria-current={navCurrent("/sessions")} onclick={closeNavigation}><Icon name="message" size={17} /><span>{copy.sessions}</span></a>
      <a href="/workspaces" aria-current={navCurrent("/workspaces")} onclick={closeNavigation}><Icon name="workspace" size={17} /><span>{copy.workspaces}</span></a>
      <a href="/settings" aria-current={navCurrent("/settings")} onclick={closeNavigation}><Icon name="settings" size={17} /><span>{copy.settings}</span></a>
    </nav>
  </div>
{/snippet}

{#snippet skipLink()}
  <a class="skip-link" href="#spark-main">{data.messages.shared.skipToContent}</a>
{/snippet}

<!-- THESIS: Spark Web is the local conversation canvas; execution topology is invisible to users and operational coordination belongs in Hub. OWN-WORLD: quiet slate surfaces, precise one-pixel rules, Spark blue focus, and conversation-shaped controls. STORY: choose project context, send the first message, then continue inside its durable Session. FIRST VIEWPORT: a 52px command bar, compact conversation rail, centered Composer, and recent Sessions below. FORM: Conversation Canvas, the user-pinned correction to surface roll 5a7f18fc. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance. -->
<OperationsShell
  header={shellHeader}
  {navigation}
  navigationAriaLabel={copy.primaryNavigation}
  navigationId="spark-primary-navigation"
  closeNavigationLabel={copy.close}
  navigationSize="compact"
  contentMode={page.route.id === "/sessions/[sessionId]" ? "flush" : "padded"}
  mainId="spark-main"
  navigationKey={page.url.pathname}
  designDirection="conversation-canvas-5a7f18fc"
  {skipLink}
>
  {@render children()}
</OperationsShell>

<Dialog
  bind:open={searchOpen}
  width="min(720px, calc(100vw - 32px))"
  maxHeight="min(680px, calc(100dvh - 32px))"
  layout="grid"
  overflow="hidden"
  mobile="sheet"
  onOpenChangeComplete={(open) => {
    if (!open) requestAnimationFrame(() => searchTrigger?.focus());
  }}
>
  <section class="search-dialog" aria-label={copy.globalSearchRegion}>
    <header>
      <div>
        <DialogTitle class="search-title">{copy.globalSearchLabel}</DialogTitle>
      </div>
      <DialogClose class="dialog-close" aria-label={copy.close}><Icon name="close" size={17} /></DialogClose>
    </header>
    <form onsubmit={(event) => void globalSearch(event)}>
      <Icon name="search" size={18} />
      <Input id="spark-global-search" type="search" bind:value={searchQuery} required aria-label={copy.globalSearchLabel} />
      <Button type="submit" disabled={searching}>{searching ? copy.searching : copy.search}</Button>
    </form>
    {#if searchError}<p class="search-error" role="alert">{searchError}</p>{/if}
    <div class="search-results">
      {#if searchResults.length > 0}
        <ul>{#each searchResults as result (result.ref)}<li><a href={resultHref(result)} onclick={() => (searchOpen = false)}><span>{result.kind}</span><strong>{result.title}</strong>{#if result.summary}<small>{result.summary}</small>{/if}</a></li>{/each}</ul>
      {:else if searchQuery.trim() && !searching}
        <p class="search-empty">{copy.noSearchResults}</p>
      {/if}
    </div>
  </section>
</Dialog>

<style>
  :global(body) {
    margin: 0;
    background: var(--color-canvas);
    color: var(--color-ink);
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .skip-link {
    background: var(--color-surface);
    color: var(--color-ink);
    inset-block-start: 6px;
    inset-inline-start: 6px;
    padding: 8px 12px;
    position: fixed;
    transform: translateY(-160%);
    z-index: 100;
  }
  .skip-link:focus {
    transform: translateY(0);
  }
  .top {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    gap: var(--spacing-lg);
    height: var(--shell-topbar-height);
    justify-content: space-between;
    padding: 0 var(--spacing-md);
    z-index: 40;
  }
  .top-brand {
    align-items: center;
    display: flex;
    gap: var(--spacing-xs);
  }
  .brand {
    align-items: center;
    color: inherit;
    display: inline-flex;
    font-weight: 700;
    gap: 7px;
    text-decoration: none;
  }
  .brand > span:first-child {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-md);
    color: var(--color-primary);
    display: inline-flex;
    height: 28px;
    justify-content: center;
    width: 28px;
  }
  .top-actions {
    align-items: center;
    display: flex;
    gap: var(--spacing-xs);
    min-width: 0;
  }
  .navigation-toggle {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: none;
    height: var(--control-height-compact);
    justify-content: center;
    padding: 0;
    width: var(--control-height-compact);
  }
  .scope-navigation {
    align-content: start;
    display: grid;
    height: 100%;
    min-height: 0;
    padding: var(--spacing-md) var(--spacing-sm);
  }
  .scope-navigation nav {
    display: grid;
    gap: var(--spacing-xxs);
  }
  .scope-navigation nav a {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: flex;
    font-size: var(--text-body);
    font-weight: 560;
    gap: var(--spacing-sm);
    min-height: var(--control-height-default);
    padding: 0 var(--spacing-sm);
    text-decoration: none;
  }
  .scope-navigation nav a:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }
  .scope-navigation nav a[aria-current="page"] {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }
  kbd {
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xs);
    color: var(--color-ink-subtle);
    font-size: 9px;
    line-height: 1;
    padding: 2px 4px;
  }
  :global(.search-dialog) {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    min-height: 240px;
  }
  :global(.search-dialog > header) {
    align-items: start;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    justify-content: space-between;
    padding: var(--spacing-lg) var(--spacing-xl);
  }
  :global(.search-title) {
    font-size: var(--text-section-title);
    font-weight: var(--weight-section-title);
    margin: 0;
  }
  :global(.search-dialog > header p) {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    margin: 3px 0 0;
  }
  :global(.dialog-close) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    height: 32px;
    justify-content: center;
    width: 32px;
  }
  :global(.dialog-close:hover) {
    background: var(--color-surface-soft);
  }
  :global(.search-dialog > form) {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: var(--spacing-md) var(--spacing-xl);
  }
  .search-results {
    min-height: 0;
    overflow: auto;
    padding: var(--spacing-xs);
  }
  .search-results ul {
    display: grid;
    gap: var(--spacing-xxs);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .search-results li a {
    border-radius: var(--rounded-md);
    color: inherit;
    display: grid;
    gap: 3px var(--spacing-sm);
    grid-template-columns: 90px minmax(0, 1fr);
    padding: 9px var(--spacing-sm);
    text-decoration: none;
  }
  .search-results li a:hover {
    background: var(--color-primary-weak);
  }
  .search-results span,
  .search-results small {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }
  .search-results small {
    grid-column: 2;
  }
  .search-error,
  .search-empty {
    color: var(--color-ink-subtle);
    margin: 0;
    padding: var(--spacing-lg);
  }
  .search-error {
    color: var(--color-danger-strong);
  }
  @media (max-width: 900px) {
    .navigation-toggle {
      display: inline-flex;
      height: var(--control-height-touch);
      width: var(--control-height-touch);
    }
  }
  @media (max-width: 640px) {
    .top {
      align-items: center;
      gap: var(--spacing-xs);
      padding: 8px var(--spacing-sm);
    }
    .brand > span:last-child,
    :global(.top-actions > .ui-button span),
    kbd {
      display: none;
    }
    .top-actions {
      gap: var(--spacing-xxs);
    }
  }
  @media (prefers-contrast: more) {
    .top,
    :global(.search-dialog) {
      border-color: currentColor;
    }
    .scope-navigation nav a {
      color: var(--color-ink);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
  }
</style>
