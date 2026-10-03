<script lang="ts">
  import { buildSessionTreeRows } from "./session-tree.ts";

  export interface SessionTreeItem {
    sessionId: string;
    name?: string;
    lifecycle: "open" | "closing" | "closed";
    placement: "active" | "archived";
    activity?: "idle" | "queued" | "running";
    lineage: {
      kind: "root" | "child";
      parentSessionId?: string;
      origin?: { kind: string; generation?: number };
    };
  }

  export interface SessionTreeLabels {
    region: string;
    search: string;
    empty: string;
    untitled: string;
    archived: string;
    orphan: string;
    cycle: string;
    archive: string;
    restore: string;
    close: string;
  }

  let {
    sessions,
    selectedSessionId,
    includeArchived = false,
    labels,
    hrefFor,
    busySessionId,
    onArchive,
    onRestore,
    onClose,
  }: {
    sessions: SessionTreeItem[];
    selectedSessionId?: string;
    includeArchived?: boolean;
    labels: SessionTreeLabels;
    hrefFor: (sessionId: string) => string;
    busySessionId?: string;
    onArchive?: (session: SessionTreeItem) => void | Promise<void>;
    onRestore?: (session: SessionTreeItem) => void | Promise<void>;
    onClose?: (session: SessionTreeItem) => void | Promise<void>;
  } = $props();

  let query = $state("");
  const rows = $derived(
    buildSessionTreeRows(sessions, { includeArchived }).filter(({ session }) => {
      const normalized = query.trim().toLowerCase();
      return (
        !normalized ||
        session.sessionId.toLowerCase().includes(normalized) ||
        session.name?.toLowerCase().includes(normalized)
      );
    }),
  );
</script>

<section class="session-tree" aria-label={labels.region}>
  <label class="tree-search">
    <span>{labels.search}</span>
    <input type="search" bind:value={query} placeholder={labels.search} />
  </label>
  {#if rows.length === 0}
    <p class="empty">{labels.empty}</p>
  {:else}
    <div class="tree-rows" role="list" aria-label={labels.region}>
      {#each rows as row (row.session.sessionId)}
        <div
          class="tree-row"
          class:selected={row.session.sessionId === selectedSessionId}
          role="listitem"
          aria-level={row.ariaLevel}
          style={`--tree-level: ${row.ariaLevel - 1}`}
          data-session-id={row.session.sessionId}
        >
          <a href={hrefFor(row.session.sessionId)} aria-current={row.session.sessionId === selectedSessionId ? "page" : undefined}>
            <strong>{row.session.name ?? labels.untitled}</strong>
            <small>
              {row.session.activity ?? row.session.lifecycle}
              {#if row.session.placement === "archived"} · {labels.archived}{/if}
              {#if row.diagnostic === "orphan"} · {labels.orphan}{/if}
              {#if row.diagnostic === "cycle"} · {labels.cycle}{/if}
            </small>
          </a>
          {#if onArchive || onRestore || onClose}
            <div class="tree-actions">
              {#if row.session.placement === "archived" && onRestore}
                <button type="button" disabled={busySessionId === row.session.sessionId} onclick={() => void onRestore?.(row.session)}>
                  {labels.restore}
                </button>
              {:else if row.session.placement !== "archived" && onArchive}
                <button type="button" disabled={busySessionId === row.session.sessionId} onclick={() => void onArchive?.(row.session)}>
                  {labels.archive}
                </button>
              {/if}
              {#if row.session.lifecycle !== "closed" && onClose}
                <button class="danger" type="button" disabled={busySessionId === row.session.sessionId} onclick={() => void onClose?.(row.session)}>
                  {labels.close}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .session-tree {
    display: grid;
    gap: 10px;
    min-width: 0;
  }
  .tree-search {
    display: grid;
    gap: 4px;
    font-size: var(--text-caption);
  }
  .tree-search input {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    min-width: 0;
    padding: 7px 9px;
  }
  .tree-rows {
    display: grid;
    gap: 4px;
  }
  .tree-row {
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    display: grid;
    gap: 4px;
    grid-template-columns: minmax(0, 1fr) auto;
    margin-inline-start: calc(var(--tree-level) * 14px);
    padding: 5px;
  }
  .tree-row.selected {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
  }
  .tree-row > a {
    color: inherit;
    display: grid;
    gap: 2px;
    min-width: 0;
    text-decoration: none;
  }
  .tree-row strong,
  .tree-row small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-row small,
  .empty {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
  }
  .tree-actions {
    display: flex;
    gap: 3px;
  }
  .tree-actions button {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-sm);
    color: var(--color-ink-muted);
    cursor: pointer;
    font-size: 10px;
    padding: 3px 5px;
  }
  .tree-actions button.danger {
    color: var(--color-danger);
  }
  .tree-actions button:focus-visible,
  .tree-search input:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }
</style>
