<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { Dialog as DialogShell, Icon } from "@zendev-lab/spark-ui";
  import { DialogDescription, DialogTitle, DialogTrigger } from "@zendev-lab/spark-ui/headless";
  import type { AppMessages } from "$lib/i18n";
  import { hubOpenSearchEvent } from "$lib/slash-actions";
  import { workspaceSessionsPath } from "$lib/workspace-routes";
  import {
    buildHubSearchResults,
    type HubSearchResult,
    type HubSearchSession,
    type HubSearchWorkspace,
  } from "./hub-search";

  interface Props {
    activeWorkspace?: HubSearchWorkspace | null;
    common: AppMessages["common"];
    layout: AppMessages["layout"];
    sessions?: HubSearchSession[];
    sessionMessages: AppMessages["sessions"];
    workspaces?: HubSearchWorkspace[];
  }

  let {
    activeWorkspace = null,
    common,
    layout,
    sessions = [],
    sessionMessages,
    workspaces = [],
  }: Props = $props();

  let open = $state(false);
  let query = $state("");
  let selectedIndex = $state(0);
  let inputElement = $state<HTMLInputElement>();
  let shortcutLabel = $state("⌘K");
  let pageShortcuts = $derived.by(() => {
    const pages: HubSearchResult[] = [
      { id: "models", type: "page", title: layout.nav.models, description: null, href: "/settings/models" },
    ];
    if (!activeWorkspace) return pages;
    const base = `/${encodeURIComponent(activeWorkspace.slug)}`;
    const workspacePages: HubSearchResult[] = [
      {
        id: "new-workspace",
        type: "page",
        title: sessionMessages.newSession,
        description: activeWorkspace.name,
        href: workspaceSessionsPath(activeWorkspace),
      },
      { id: "overview", type: "page", title: layout.nav.overview, description: activeWorkspace.name, href: base },
      { id: "inbox", type: "page", title: layout.nav.inbox, description: activeWorkspace.name, href: `${base}/inbox` },
      { id: "artifacts", type: "page", title: layout.nav.artifacts, description: activeWorkspace.name, href: `${base}/artifacts` },
      { id: "resources", type: "page", title: layout.nav.repos, description: activeWorkspace.name, href: `${base}/repos` },
      { id: "workspace-settings", type: "page", title: layout.nav.workspaceSettings, description: activeWorkspace.name, href: `${base}/settings` },
      ...pages,
    ];
    return workspacePages;
  });
  let results = $derived(
    buildHubSearchResults({
      query,
      sessions,
      workspaces,
      untitledConversationLabel: sessionMessages.untitledConversation,
      channelLabels: sessionMessages.channelLabels,
      statusLabels: common.status as Record<string, string>,
      pages: pageShortcuts,
    }),
  );
  let activeOptionId = $derived.by(() => {
    const active = results[selectedIndex];
    return active ? `search-result-${active.type}-${active.id}` : undefined;
  });

  onMount(() => {
    shortcutLabel = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘K" : "Ctrl K";
    const handleOpenSearch = () => openSearch();
    window.addEventListener(hubOpenSearchEvent, handleOpenSearch);
    return () => window.removeEventListener(hubOpenSearchEvent, handleOpenSearch);
  });

  $effect(() => {
    if (open) {
      requestAnimationFrame(() => inputElement?.focus());
    }
  });

  $effect(() => {
    resetSelection(query, results.length);
  });

  function openSearch() {
    open = true;
  }

  function handleOpenChangeComplete(nextOpen: boolean) {
    if (nextOpen) return;
    query = "";
    selectedIndex = 0;
  }

  function resetSelection(_query: string, _resultCount: number) {
    selectedIndex = 0;
  }

  function moveSelection(delta: number) {
    if (results.length === 0) return;
    selectedIndex = (selectedIndex + delta + results.length) % results.length;
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Enter" && results[selectedIndex]) {
      event.preventDefault();
      void chooseResult(results[selectedIndex]);
    }
  }

  async function chooseResult(result: (typeof results)[number]) {
    open = false;
    await goto(result.href);
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<DialogShell
  bind:open
  layout="grid"
  overflow="hidden"
  mobile="sheet"
  maxHeight="min(620px, calc(100dvh - 32px))"
  contentClass="search-dialog"
  describedBy="global-search-description"
  onOpenChangeComplete={handleOpenChangeComplete}
>
  {#snippet trigger()}
    <DialogTrigger class="topbar-search" type="button" aria-label={layout.aria.globalSearch}>
      <Icon name="search" size={16} />
      <span>{layout.search.placeholder}</span>
      <kbd>{shortcutLabel}</kbd>
    </DialogTrigger>
  {/snippet}

  <div class="search-dialog-header">
    <div>
      <DialogDescription id="global-search-description" class="search-dialog-scope">
        {layout.search.scope}
      </DialogDescription>
      <DialogTitle id="global-search-title" class="search-dialog-title">
        {layout.search.title}
      </DialogTitle>
    </div>
    <kbd>{shortcutLabel}</kbd>
  </div>

  <label class="search-field">
    <Icon name="search" size={20} />
    <input
      bind:this={inputElement}
      bind:value={query}
      role="combobox"
      aria-expanded="true"
      aria-autocomplete="list"
      aria-controls="global-search-results"
      aria-activedescendant={activeOptionId}
      autocomplete="off"
      onkeydown={handleSearchKeydown}
      placeholder={layout.search.inputPlaceholder}
      type="search"
    />
  </label>

  <div
    class="search-results"
    id="global-search-results"
    role="listbox"
    aria-label={layout.search.resultsLabel}
    aria-live="polite"
  >
    {#if results.length === 0}
      <p class="search-state">{query.trim() ? layout.search.empty : layout.search.hint}</p>
    {:else}
      <p class="search-section-label">{query.trim() ? layout.search.resultsLabel : layout.search.shortcuts}</p>
      {#each results as result, index}
        <button
          class="search-result"
          class:selected={index === selectedIndex}
          id={`search-result-${result.type}-${result.id}`}
          onclick={() => void chooseResult(result)}
          onmouseenter={() => (selectedIndex = index)}
          role="option"
          aria-selected={index === selectedIndex}
          type="button"
          tabindex="-1"
        >
          <span class="search-result-icon">
            <Icon
              name={result.type === "session" ? "agents" : result.type === "workspace" ? "workspace" : "chevron"}
              size={18}
              stroke={2.1}
            />
          </span>
          <span class="search-result-copy">
            <strong>{result.title}</strong>
            {#if result.description}
              <small>{result.description}</small>
            {/if}
          </span>
          {#if result.status}
            <span class="search-result-meta">
              <em>{common.status[result.status as keyof typeof common.status] ?? result.status}</em>
            </span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
  <p class="search-keyboard-hint">{layout.search.keyboardHint}</p>
</DialogShell>

<style>
  :global(.topbar-search) {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: 7px;
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-grid;
    font: inherit;
    gap: 8px;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    height: 32px;
    max-width: 440px;
    padding: 0 8px 0 10px;
    text-align: left;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease,
      color 120ms ease;
    width: min(42vw, 440px);
  }

  :global(.topbar-search:hover),
  :global(.topbar-search:focus-visible) {
    background: var(--color-surface);
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    color: var(--color-ink);
    outline: none;
  }

  :global(.topbar-search) span {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  kbd {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 5px;
    color: var(--color-ink-subtle);
    font:
      700 10px/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    padding: 4px 5px;
  }

  input {
    font: inherit;
  }

  :global(.search-dialog) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    display: grid;
    gap: 14px;
    left: 50%;
    max-height: min(620px, calc(100dvh - 32px));
    max-width: calc(100vw - 32px);
    overflow: hidden;
    padding: 16px;
    position: fixed;
    top: 15vh;
    transform: translateX(-50%);
    width: min(720px, calc(100vw - 32px));
    z-index: 101;
  }

  :global(.search-dialog:focus-visible) {
    outline: none;
  }

  .search-dialog-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border-soft);
    display: flex;
    justify-content: space-between;
    padding: 0 2px 12px;
  }

  :global(.search-dialog-scope) {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    margin: 0 0 4px;
  }

  :global(.search-dialog-title) {
    color: var(--color-ink);
    font-size: 18px;
    line-height: 1.35;
    margin: 0;
  }

  .search-field {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    color: var(--color-ink-subtle);
    display: grid;
    gap: 10px;
    grid-template-columns: 20px minmax(0, 1fr);
    min-height: 48px;
    padding: 0 13px;
  }

  .search-field:focus-within {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
  }

  .search-field input {
    background: transparent;
    border: 0;
    color: var(--color-ink);
    min-width: 0;
    outline: none;
    padding: 0;
  }

  .search-results {
    display: grid;
    gap: 6px;
    max-height: 440px;
    overflow: auto;
    padding: 2px;
  }

  .search-state {
    color: var(--color-ink-subtle);
    font-size: 14px;
    line-height: 1.5;
    margin: 0;
    padding: 16px 4px 18px;
  }

  .search-section-label {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    margin: 0;
    padding: 2px 4px 4px;
  }

  .search-keyboard-hint {
    border-top: 1px solid var(--color-border-soft);
    color: var(--color-ink-subtle);
    font-size: 11px;
    margin: 0;
    padding: 10px 2px 0;
    text-align: right;
  }

  .search-result {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-ink);
    cursor: pointer;
    display: grid;
    gap: 12px;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    min-height: 68px;
    padding: 10px 12px;
    text-align: left;
    width: 100%;
  }

  .search-result:hover,
  .search-result.selected {
    background: var(--color-primary-weak);
    border-color: var(--color-focus-ring);
  }

  .search-result-icon {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: 8px;
    color: var(--color-primary);
    display: inline-flex;
    height: 34px;
    justify-content: center;
    width: 34px;
  }

  .search-result-copy,
  .search-result-meta {
    min-width: 0;
  }

  .search-result-copy {
    display: grid;
    gap: 3px;
  }

  .search-result-copy strong,
  .search-result-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-result-copy strong {
    font-size: 14px;
    line-height: 1.35;
  }

  .search-result-copy small {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
  }

  .search-result-meta em {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-style: normal;
    font-weight: 800;
    line-height: 1;
    padding: 5px 8px;
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    :global(.topbar-search) {
      width: min(48vw, 280px);
    }

    :global(.topbar-search) kbd {
      display: none;
    }

    :global(.search-dialog) {
      max-height: calc(100dvh - 32px);
      padding: 14px;
      top: 8vh;
    }

    .search-result {
      align-items: start;
      grid-template-columns: 34px minmax(0, 1fr);
    }

    .search-result-meta {
      grid-column: 2;
    }
  }

  @media (max-width: 480px) {
    :global(.topbar-search) {
      grid-template-columns: 16px minmax(0, 1fr);
      width: min(46vw, 210px);
    }
  }
</style>
