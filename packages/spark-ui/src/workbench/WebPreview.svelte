<script lang="ts">
  import Icon from "../Icon.svelte";
  import { safeWorkbenchHref } from "./view";
  import WebPreviewNavigation from "./WebPreviewNavigation.svelte";
  import type { Snippet } from "svelte";
  import type { WebPreviewView } from "./types";

  type Props = {
    view: WebPreviewView;
    openLabel: string;
    imageAlt?: string;
    children?: Snippet;
    navigation?: Snippet<[WebPreviewView]>;
    class?: string;
  };

  let {
    view,
    openLabel,
    imageAlt = "",
    children,
    navigation,
    class: className = "",
  }: Props = $props();
  let screenshotHref = $derived(safeWorkbenchHref(view.screenshotHref));
</script>

<section class="web-preview {className}" aria-label={view.title}>
  {#if navigation}
    {@render navigation(view)}
  {:else}
    <WebPreviewNavigation
      title={view.title}
      href={view.href}
      {openLabel}
    />
  {/if}

  <div class="preview-body">
    {#if children}
      {@render children()}
    {:else if screenshotHref}
      <img src={screenshotHref} alt={imageAlt} loading="lazy" />
    {:else}
      <div class="placeholder" aria-hidden="true"><Icon name="workspace" size={28} /></div>
    {/if}
  </div>

  {#if view.description}<p class="description">{view.description}</p>{/if}
</section>

<style>
  .web-preview { border: 1px solid var(--color-border); border-radius: var(--rounded-lg); margin: 0; overflow: hidden; }
  .preview-body { background: var(--color-surface-soft); min-width: 0; }
  img, .placeholder { aspect-ratio: 16 / 9; background: var(--color-surface-soft); display: flex; height: auto; max-height: 440px; object-fit: cover; width: 100%; }
  .placeholder { align-items: center; color: var(--color-ink-subtle); justify-content: center; }
  .description { border-block-start: 1px solid var(--color-border-soft); color: var(--color-ink-muted); font-size: 10px; margin: 0; padding: 8px 10px; }
</style>
