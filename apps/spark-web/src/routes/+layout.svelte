<script lang="ts">
  import "@zendev-lab/spark-ui/tokens.css";
  import { onMount } from "svelte";
  import { webRpc } from "$lib/web-rpc";

  let { children } = $props();
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
      if (event.key === "Escape" && searchOpen) searchOpen = false;
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
    searchOpen = !searchOpen;
    if (searchOpen) {
      requestAnimationFrame(() => document.getElementById("spark-global-search")?.focus());
    }
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
</script>

<svelte:head>
  <title>Spark</title>
  <meta name="theme-color" content="#2563EB" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/spark.svg" />
</svelte:head>

<div class="shell">
  <header class="top">
    <a href="/" class="brand">Spark</a>
    <nav>
      <a href="/">Workspaces</a>
      <a href="/sessions">Sessions</a>
      <a href="/settings">Settings</a>
      <button type="button" onclick={toggleSearch}>Search</button>
      <label class="theme"><span class="sr-only">Theme</span><select value={theme} onchange={(event) => selectTheme((event.currentTarget as HTMLSelectElement).value as "light" | "dark" | "system")}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    </nav>
  </header>
  {#if searchOpen}
    <section class="global-search" aria-label="Workspace Session and Artifact search">
      <form onsubmit={(event) => void globalSearch(event)}>
        <label for="spark-global-search">Search Workspaces, Sessions, messages, and Artifacts</label>
        <div><input id="spark-global-search" type="search" bind:value={searchQuery} required /><button type="submit" disabled={searching}>{searching ? "Searching…" : "Search"}</button><button type="button" onclick={() => (searchOpen = false)}>Close</button></div>
      </form>
      {#if searchError}<p role="alert">{searchError}</p>{/if}
      {#if searchResults.length > 0}<ul>{#each searchResults as result (result.ref)}<li><a href={resultHref(result)}><span>{result.kind}</span><strong>{result.title}</strong>{#if result.summary}<small>{result.summary}</small>{/if}</a></li>{/each}</ul>{/if}
    </section>
  {/if}
  <main>{@render children()}</main>
</div>

<style>
  :global(body) {
    margin: 0;
    background: var(--color-canvas);
    color: var(--color-ink);
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  .brand {
    font-weight: 650;
    color: inherit;
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 16px;
  }
  nav a {
    color: var(--color-ink-muted);
    text-decoration: none;
  }
  nav button {
    background: transparent;
    border: 0;
    color: var(--color-ink-muted);
    cursor: pointer;
    font: inherit;
    padding: 0;
  }
  .theme select {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-sm);
    color: var(--color-ink);
  }
  .sr-only {
    block-size: 1px;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }
  .global-search {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    box-shadow: var(--shadow-card-raised);
    display: grid;
    gap: 10px;
    max-height: 50vh;
    overflow: auto;
    padding: 12px 20px;
    position: relative;
    z-index: 10;
  }
  .global-search form,
  .global-search form div {
    display: flex;
    gap: 8px;
  }
  .global-search form {
    flex-direction: column;
  }
  .global-search input {
    flex: 1;
    min-width: 0;
  }
  .global-search ul {
    display: grid;
    gap: 4px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .global-search li a {
    color: inherit;
    display: grid;
    gap: 3px;
    grid-template-columns: 90px minmax(0, 1fr);
    padding: 6px;
    text-decoration: none;
  }
  .global-search small {
    grid-column: 2;
  }
  main {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
