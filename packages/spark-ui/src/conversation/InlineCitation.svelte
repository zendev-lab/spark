<script lang="ts">
  import type { ConversationSourceView } from "./chat-types";
  import { safeConversationHref } from "./chat-view";

  type Props = {
    source: ConversationSourceView;
    index: number;
    label: string;
  };

  let { source, index, label }: Props = $props();
  let safeHref = $derived(safeConversationHref(source.href));
</script>

{#if safeHref}
  <a
    class="inline-citation"
    href={safeHref}
    aria-label={`${label} ${index}: ${source.title}`}
    title={source.title}
  >
    {index}
  </a>
{:else}
  <span class="inline-citation" title={source.title}>{index}</span>
{/if}

<style>
  .inline-citation {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: inline-flex;
    font-size: 9px;
    font-weight: 700;
    height: 17px;
    justify-content: center;
    line-height: 1;
    min-width: 17px;
    padding-inline: 4px;
    text-decoration: none;
    vertical-align: super;
  }
</style>
