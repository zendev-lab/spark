<script lang="ts">
  import Icon from "../Icon.svelte";
  import { workbenchStatusTone } from "./view";
  import type { WorkbenchPanelProps } from "./types";

  let {
    id,
    title,
    status,
    statusLabel = status,
    summary,
    defaultOpen = false,
    nested = false,
    children,
    details,
    actions,
  }: WorkbenchPanelProps = $props();

  let tone = $derived(workbenchStatusTone(status));
</script>

<details class="workbench-panel {tone}" class:nested open={defaultOpen} data-status={status}>
  <summary aria-controls={`${id}-details`}>
    <span class="title">{title}</span>
    {#if summary}<span class="summary">{summary}</span>{/if}
    {#if statusLabel}<span class="status {tone}">{statusLabel}</span>{/if}
    <span class="disclosure" aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
  </summary>
  <div class="panel-details" id={`${id}-details`}>
    {#if children}<div class="body">{@render children()}</div>{/if}
    {#if details}<div class="details">{@render details()}</div>{/if}
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
</details>

<style>
  .workbench-panel {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-lg);
    color: var(--color-ink-muted);
    overflow: hidden;
  }

  .workbench-panel.nested { background: transparent; }
  .workbench-panel.active { border-color: var(--color-primary-soft); }
  .workbench-panel.warning { border-color: var(--color-warning); }
  .workbench-panel.danger { border-color: var(--color-danger-soft); }

  summary {
    align-items: center;
    cursor: pointer;
    display: grid;
    font-size: 12px;
    gap: 10px;
    grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto auto;
    list-style: none;
    min-height: 40px;
    padding: 0 10px;
  }

  summary::-webkit-details-marker { display: none; }
  summary:focus-visible { box-shadow: inset var(--shadow-focus); outline: none; }

  .title {
    color: var(--color-ink);
    font-weight: 650;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .summary {
    font-family: var(--font-mono);
    font-size: 11px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
  }

  .status.success { background: var(--color-success-soft); color: var(--color-success-strong); }
  .status.danger { background: var(--color-danger-soft); color: var(--color-danger-strong); }
  .status.warning { background: var(--color-warning-soft); color: var(--color-warning-strong); }
  .status.active { background: var(--color-primary-soft); color: var(--color-info-strong); }

  .disclosure { display: inline-flex; transition: transform var(--motion-fast) ease; }
  details[open] .disclosure { transform: rotate(180deg); }

  .panel-details {
    border-block-start: 1px solid var(--color-border-soft);
    display: grid;
    gap: 10px;
    padding: 10px;
  }

  .body, .details { display: grid; gap: 8px; min-width: 0; }
  .actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }

  @media (max-width: 640px) {
    summary { grid-template-columns: minmax(0, 1fr) auto auto; }
    .summary { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure { transition: none; }
  }
</style>
