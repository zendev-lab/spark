<script lang="ts">
  import Icon from "../Icon.svelte";
  import { workbenchStatusTone } from "./view";
  import type { Snippet } from "svelte";
  import type { ConfirmationView } from "./types";

  type Props = {
    view: ConfirmationView;
    statusLabel: (status: string) => string;
    actions?: Snippet<[ConfirmationView]>;
  };

  let { view, statusLabel, actions }: Props = $props();
  let tone = $derived(workbenchStatusTone(view.status));
</script>

<section class="confirmation {tone}" aria-labelledby={`${view.id}-title`}>
  <header>
    <Icon name="warning" size={15} />
    <strong id={`${view.id}-title`}>{view.title}</strong>
    <span>{statusLabel(view.status)}</span>
  </header>
  {#if view.description}<p>{view.description}</p>{/if}
  {#if view.detail}<pre>{view.detail}</pre>{/if}
  {#if actions && (view.status === "pending" || view.status === "requested")}
    <div class="actions">{@render actions(view)}</div>
  {/if}
  <code>{view.id}</code>
</section>

<style>
  .confirmation { background: var(--color-warning-weak); border: 1px solid var(--color-warning); border-radius: var(--rounded-lg); display: grid; gap: 8px; padding: 10px; }
  .confirmation.success { background: var(--color-success-weak); border-color: var(--color-success); }
  .confirmation.danger, .confirmation.neutral { background: var(--color-surface-soft); border-color: var(--color-border); }
  header { align-items: center; color: var(--color-warning-strong); display: grid; font-size: 12px; gap: 8px; grid-template-columns: auto minmax(0, 1fr) auto; }
  header span { color: var(--color-ink-muted); font-size: 10px; font-weight: 700; }
  p, pre { color: var(--color-ink-muted); font-size: 12px; line-height: 1.5; margin: 0; white-space: pre-wrap; }
  pre, code { font-family: var(--font-mono); }
  code { color: var(--color-ink-muted); font-size: 10px; }
  .actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
</style>
