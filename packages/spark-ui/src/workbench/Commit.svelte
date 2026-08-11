<script lang="ts">
  import Icon from "../Icon.svelte";
  import { safeWorkbenchHref } from "./view";
  import type { CommitView } from "./types";

  type Props = { view: CommitView; openLabel: string };
  let { view, openLabel }: Props = $props();
  let href = $derived(safeWorkbenchHref(view.href));
</script>

<article class="commit">
  <Icon name="repos" size={16} />
  <div>
    <strong>{view.title}</strong>
    {#if view.description}<p>{view.description}</p>{/if}
    <span>{#if view.author}{view.author} · {/if}{view.timestamp ?? ""}</span>
  </div>
  <code>{view.hash}</code>
  {#if href}<a href={href} target="_blank" rel="noreferrer" aria-label={`${openLabel}: ${view.title}`}><Icon name="external-link" size={14} /></a>{/if}
</article>

<style>
  .commit { align-items: start; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--rounded-lg); color: var(--color-ink-muted); display: grid; gap: 10px; grid-template-columns: auto minmax(0, 1fr) auto auto; padding: 10px; }
  .commit > div { display: grid; gap: 2px; min-width: 0; }
  strong { color: var(--color-ink); font-size: 12px; } p { font-size: 11px; line-height: 1.4; margin: 0; } span { color: var(--color-ink-subtle); font-size: 10px; }
  code { background: var(--color-surface-soft); border-radius: var(--rounded-sm); color: var(--color-ink-muted); font-family: var(--font-mono); font-size: 10px; padding: 3px 6px; }
  a { align-items: center; border-radius: var(--rounded-sm); color: var(--color-ink-muted); display: inline-flex; height: 26px; justify-content: center; width: 26px; } a:focus-visible { box-shadow: var(--shadow-focus); outline: none; }
  @media (max-width: 640px) { .commit { grid-template-columns: auto minmax(0, 1fr) auto; } code { grid-column: 2; grid-row: 2; width: fit-content; } }
</style>
