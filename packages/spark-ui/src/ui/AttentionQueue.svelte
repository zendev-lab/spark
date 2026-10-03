<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { AttentionGroupId, AttentionQueueItem, AttentionQueueLabels } from "./attention-types";

  let {
    items,
    labels,
    selectedId,
    onSelect,
    emptyTone = "success",
    detailRegionId,
  }: {
    items: AttentionQueueItem[];
    labels: AttentionQueueLabels;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    emptyTone?: "success" | "warning";
    detailRegionId?: string;
  } = $props();

  const groupOrder: AttentionGroupId[] = ["needs-you", "running", "failed", "recent"];
  let grouped = $derived(
    groupOrder.map((id) => ({ id, items: items.filter((item) => item.group === id) })),
  );
</script>

<section class="attention-queue" aria-label={labels.ariaLabel}>
  {#if items.length === 0}
    <div class="attention-empty" data-tone={emptyTone}>
      <Icon name={emptyTone === "warning" ? "warning" : "check"} size={21} />
      <div>
        <h3>{labels.emptyTitle}</h3>
        {#if labels.emptyBody}<p>{labels.emptyBody}</p>{/if}
      </div>
    </div>
  {:else}
    {#each grouped as group (group.id)}
      {#if group.items.length > 0}
        <section class="attention-group" aria-labelledby={`attention-${group.id}`}>
          <header>
            <h3 id={`attention-${group.id}`}>{labels.groups[group.id]}</h3>
            <span>{group.items.length}</span>
          </header>
          <div class="attention-items">
            {#each group.items as item (item.id)}
              <article class="attention-item" class:selected={item.id === selectedId} data-tone={item.tone}>
                <button
                  type="button"
                  class="attention-select"
                  aria-pressed={item.id === selectedId}
                  aria-controls={detailRegionId}
                  onclick={() => onSelect?.(item.id)}
                >
                  <span class="attention-icon" aria-hidden="true">
                    <Icon name={item.icon ?? (item.group === "needs-you" ? "inbox" : "activity")} size={16} />
                  </span>
                  <span class="attention-copy">
                    <span class="attention-title-row">
                      <strong>{item.title}</strong>
                      <span class="attention-status">{item.statusLabel}</span>
                    </span>
                    <span class="attention-context">{item.context}</span>
                    {#if item.detail}<span class="attention-detail">{item.detail}</span>{/if}
                    {#if item.meta}<small>{item.meta}</small>{/if}
                  </span>
                </button>
                {#if item.href && item.actionLabel}
                  <a class="attention-action" href={item.href}>
                    {item.actionLabel}
                    <Icon name="arrow-right" size={14} />
                  </a>
                {/if}
              </article>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  {/if}
</section>

<style>
  .attention-queue {
    display: grid;
    min-width: 0;
  }

  .attention-group {
    border-top: 1px solid var(--color-border);
    min-width: 0;
    padding: var(--spacing-md) 0;
  }

  .attention-group:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .attention-group > header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    padding: 0 var(--spacing-md) var(--spacing-xs);
  }

  .attention-group h3 {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    font-weight: 650;
    letter-spacing: 0.01em;
    margin: 0;
  }

  .attention-group header > span {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    font-variant-numeric: tabular-nums;
  }

  .attention-items {
    display: grid;
  }

  .attention-item {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    min-width: 0;
    transition:
      background var(--motion-fast) ease,
      box-shadow var(--motion-default) ease;
  }

  .attention-item:first-child {
    border-top: 0;
  }

  .attention-item:hover,
  .attention-item:focus-within {
    background: var(--color-surface-soft);
  }

  .attention-item.selected {
    background: var(--color-primary-weak);
    box-shadow: inset 1px 0 0 var(--color-primary);
    animation: pulse-handoff 420ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .attention-select {
    align-items: start;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr);
    min-width: 0;
    padding: var(--spacing-sm) var(--spacing-md);
    text-align: left;
  }

  .attention-select:focus-visible {
    outline-offset: -3px;
  }

  .attention-icon {
    align-items: center;
    background: var(--color-surface-muted);
    border-radius: var(--rounded-sm);
    color: var(--color-ink-muted);
    display: flex;
    height: 30px;
    justify-content: center;
    margin-top: 1px;
    width: 30px;
  }

  [data-tone="warning"] .attention-icon,
  [data-tone="warning"] .attention-status {
    background: var(--color-warning-weak);
    color: var(--color-warning-strong);
  }

  [data-tone="running"] .attention-icon,
  [data-tone="running"] .attention-status {
    background: var(--color-info-soft);
    color: var(--color-info-strong);
  }

  [data-tone="danger"] .attention-icon,
  [data-tone="danger"] .attention-status {
    background: var(--color-danger-weak);
    color: var(--color-danger-strong);
  }

  [data-tone="success"] .attention-icon,
  [data-tone="success"] .attention-status {
    background: var(--color-success-weak);
    color: var(--color-success-strong);
  }

  .attention-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .attention-title-row {
    align-items: center;
    display: flex;
    gap: var(--spacing-xs);
    justify-content: space-between;
    min-width: 0;
  }

  .attention-title-row strong {
    font-size: var(--text-body);
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attention-status {
    background: var(--color-surface-muted);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 650;
    line-height: 1;
    padding: 5px 7px;
  }

  .attention-context,
  .attention-detail,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attention-context {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
  }

  .attention-detail {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  small {
    color: var(--color-ink-subtle);
    font-size: 11px;
  }

  .attention-action {
    align-items: center;
    align-self: center;
    color: var(--color-primary);
    display: inline-flex;
    font-size: var(--text-caption);
    font-weight: 600;
    gap: 4px;
    margin-right: var(--spacing-md);
    min-height: var(--control-height-compact);
    padding: 0 var(--spacing-xs);
    text-decoration: none;
    white-space: nowrap;
  }

  .attention-action:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .attention-empty {
    align-items: start;
    color: var(--color-success-strong);
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr);
    padding: var(--spacing-xl);
  }

  .attention-empty[data-tone="warning"] {
    color: var(--color-warning-strong);
  }

  .attention-empty h3,
  .attention-empty p {
    margin: 0;
  }

  .attention-empty h3 {
    font-size: var(--text-card-title);
  }

  .attention-empty p {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    margin-top: 3px;
  }

  @keyframes pulse-handoff {
    0% {
      background: var(--color-primary-soft);
      box-shadow: inset 1px 0 0 var(--color-primary), 0 0 0 8px color-mix(in srgb, var(--color-primary) 0%, transparent);
    }
    55% {
      box-shadow: inset 1px 0 0 var(--color-primary), 0 0 0 2px color-mix(in srgb, var(--color-primary) 18%, transparent);
    }
    100% {
      background: var(--color-primary-weak);
      box-shadow: inset 1px 0 0 var(--color-primary), 0 0 0 0 transparent;
    }
  }

  @media (max-width: 640px) {
    .attention-item {
      grid-template-columns: minmax(0, 1fr);
    }

    .attention-action {
      justify-self: start;
      margin: -4px 0 var(--spacing-xs) 50px;
      min-height: var(--control-height-touch);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .attention-item.selected {
      animation: none;
    }
  }
</style>
