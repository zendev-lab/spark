<script lang="ts">
  import Icon from "../Icon.svelte";
  import { safeWorkbenchHref } from "./view";
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    href?: string;
    openLabel: string;
    actions?: Snippet;
  };

  let { title, href: candidateHref, openLabel, actions }: Props = $props();
  let href = $derived(safeWorkbenchHref(candidateHref));
</script>

<header class="web-preview-navigation">
  <strong>{title}</strong>
  {#if href}<code dir="ltr" title={href}>{href}</code>{/if}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
  {#if href}
    <a href={href} target="_blank" rel="noreferrer">
      {openLabel}<Icon name="external-link" size={13} />
    </a>
  {/if}
</header>

<style>
  .web-preview-navigation {
    align-items: center;
    background: var(--color-surface);
    border-block-end: 1px solid var(--color-border-soft);
    display: grid;
    gap: 8px;
    grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto auto;
    min-height: 42px;
    padding: 6px 9px;
  }
  strong { color: var(--color-ink); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code { background: var(--color-surface-soft); border: 1px solid var(--color-border-soft); border-radius: var(--rounded-sm); color: var(--color-ink-subtle); font-family: var(--font-mono); font-size: 10px; overflow: hidden; padding: 4px 7px; text-overflow: ellipsis; white-space: nowrap; }
  .actions { align-items: center; display: flex; gap: 4px; }
  a { align-items: center; color: var(--color-primary); display: inline-flex; font-size: 11px; font-weight: 650; gap: 5px; text-decoration: none; white-space: nowrap; }
  a:hover { text-decoration: underline; }
  a:focus-visible { border-radius: var(--rounded-sm); box-shadow: var(--shadow-focus); outline: none; }
  @media (max-width: 640px) {
    .web-preview-navigation { grid-template-columns: minmax(0, 1fr) auto auto; }
    code { display: none; }
  }
</style>
