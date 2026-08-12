<script lang="ts">
  import Icon from "../Icon.svelte";
  import { safeWorkbenchHref, workbenchStatusTone } from "./view";
  import type { Snippet } from "svelte";
  import type { ArtifactView } from "./types";

  type Props = {
    view: ArtifactView;
    previewLabel: string;
    statusLabel: (status: string) => string;
    actions?: Snippet<[ArtifactView]>;
  };

  let { view, previewLabel, statusLabel, actions }: Props = $props();
  let previewHref = $derived(safeWorkbenchHref(view.previewHref));
  let tone = $derived(workbenchStatusTone(view.status));
</script>

<article class="artifact {tone}" aria-labelledby={`${view.id}-title`}>
  <header>
    <span class="icon" aria-hidden="true"><Icon name="artifacts" size={15} /></span>
    <div>
      <strong id={`${view.id}-title`}>{view.title}</strong>
      <code>{view.id}</code>
    </div>
    {#if view.kind}<span class="badge">{view.kind}</span>{/if}
    {#if view.status}<span class="badge {tone}">{statusLabel(view.status)}</span>{/if}
  </header>
  {#if view.summary}<p>{view.summary}</p>{/if}
  {#if previewHref}<a href={previewHref} target="_blank" rel="noreferrer">{previewLabel}</a>{/if}
  {#if actions}<div class="actions">{@render actions(view)}</div>{/if}
</article>

<style>
  .artifact { background: var(--color-surface); border: 1px solid var(--color-border-soft); border-radius: var(--rounded-lg); display: grid; gap: 8px; padding: 11px 12px; }
  .artifact.danger { border-color: var(--color-danger-soft); }
  header { align-items: center; display: grid; gap: 9px; grid-template-columns: auto minmax(0, 1fr) auto auto; }
  .icon { align-items: center; background: var(--color-primary-weak); border-radius: var(--rounded-md); color: var(--color-primary); display: inline-flex; height: 28px; justify-content: center; width: 28px; }
  header div { display: grid; min-width: 0; }
  strong { color: var(--color-ink); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code { color: var(--color-ink-subtle); font-family: var(--font-mono); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { background: var(--color-surface-soft); border-radius: var(--rounded-full); color: var(--color-ink-muted); font-size: 10px; font-weight: 650; padding: 3px 7px; }
  .badge.success { background: var(--color-success-soft); color: var(--color-success-strong); }
  .badge.danger { background: var(--color-danger-soft); color: var(--color-danger-strong); }
  p { color: var(--color-ink-muted); font-size: 12px; line-height: 1.5; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  a { color: var(--color-primary); font-size: 12px; font-weight: 700; text-decoration: none; width: fit-content; }
  a:hover { text-decoration: underline; }
  .actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 640px) { header { grid-template-columns: auto minmax(0, 1fr) auto; } .badge:first-of-type { display: none; } }
</style>
