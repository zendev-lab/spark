<script lang="ts">
  import Icon from "../Icon.svelte";
  import { safeWorkbenchHref } from "./view";
  import type { WebPreviewView } from "./types";

  type Props = { view: WebPreviewView; openLabel: string; imageAlt: string };
  let { view, openLabel, imageAlt }: Props = $props();
  let href = $derived(safeWorkbenchHref(view.href));
  let screenshotHref = $derived(safeWorkbenchHref(view.screenshotHref));
</script>

<figure class="web-preview">
  {#if screenshotHref}
    <img src={screenshotHref} alt={imageAlt} loading="lazy" />
  {:else}
    <div class="placeholder" aria-hidden="true"><Icon name="workspace" size={28} /></div>
  {/if}
  <figcaption>
    <div><strong>{view.title}</strong>{#if view.description}<p>{view.description}</p>{/if}</div>
    {#if href}<a href={href} target="_blank" rel="noreferrer">{openLabel}<Icon name="external-link" size={13} /></a>{/if}
  </figcaption>
</figure>

<style>
  .web-preview { border: 1px solid var(--color-border); border-radius: var(--rounded-lg); margin: 0; overflow: hidden; }
  img, .placeholder { aspect-ratio: 16 / 9; background: var(--color-surface-soft); display: flex; height: auto; max-height: 440px; object-fit: cover; width: 100%; }
  .placeholder { align-items: center; color: var(--color-ink-subtle); justify-content: center; }
  figcaption { align-items: center; display: flex; gap: 12px; justify-content: space-between; padding: 9px 10px; }
  figcaption div { display: grid; gap: 2px; min-width: 0; }
  strong { color: var(--color-ink); font-size: 12px; } p { color: var(--color-ink-muted); font-size: 10px; margin: 0; }
  a { align-items: center; color: var(--color-primary); display: inline-flex; font-size: 11px; font-weight: 650; gap: 5px; text-decoration: none; white-space: nowrap; }
  a:hover { text-decoration: underline; } a:focus-visible { border-radius: var(--rounded-sm); box-shadow: var(--shadow-focus); outline: none; }
</style>
