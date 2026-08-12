<script lang="ts">
  import Icon from "../Icon.svelte";
  import { safeConversationHref } from "./chat-view";
  import type { ConversationSourceView } from "./chat-types";

  type Props = {
    sources: readonly ConversationSourceView[];
    label: string;
    sourceLabel: string;
    open?: boolean;
  };

  let { sources, label, sourceLabel, open = $bindable(false) }: Props = $props();
</script>

{#if sources.length > 0}
  <details class="sources" bind:open>
    <summary>
      <Icon name="quote" size={14} />
      <span>{label}</span>
      <small>{sources.length}</small>
      <Icon name="chevron-down" size={14} />
    </summary>
    <ol>
      {#each sources as source, index (source.id)}
        {@const safeHref = safeConversationHref(source.href)}
        <li>
          <span class="source-index" aria-hidden="true">{index + 1}</span>
          {#if safeHref}
            <a href={safeHref} aria-label={`${sourceLabel} ${index + 1}: ${source.title}`}>
              <strong>{source.title}</strong>
              {#if source.description}<span>{source.description}</span>{/if}
              {#if source.domain}<small>{source.domain}</small>{/if}
            </a>
          {:else}
            <span class="source-copy">
              <strong>{source.title}</strong>
              {#if source.description}<span>{source.description}</span>{/if}
              {#if source.domain}<small>{source.domain}</small>{/if}
            </span>
          {/if}
        </li>
      {/each}
    </ol>
  </details>
{/if}

<style>
  .sources {
    border-block-start: 1px solid var(--color-border-soft);
    color: var(--color-ink-muted);
    padding-block-start: 8px;
  }

  summary {
    align-items: center;
    cursor: pointer;
    display: grid;
    font-size: 12px;
    font-weight: 650;
    gap: 7px;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    list-style: none;
    min-height: 30px;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    border-radius: var(--rounded-sm);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  summary small {
    color: var(--color-ink-subtle);
  }

  details[open] summary :global(svg:last-child) {
    transform: rotate(180deg);
  }

  ol {
    display: grid;
    gap: 6px;
    list-style: none;
    margin: 7px 0 0;
    padding: 0;
  }

  li {
    align-items: start;
    display: grid;
    gap: 8px;
    grid-template-columns: 20px minmax(0, 1fr);
  }

  .source-index {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: var(--rounded-full);
    display: inline-flex;
    font-size: 9px;
    height: 20px;
    justify-content: center;
    width: 20px;
  }

  li a,
  .source-copy {
    color: var(--color-ink-muted);
    display: grid;
    min-width: 0;
    text-decoration: none;
  }

  li a:hover strong {
    text-decoration: underline;
  }

  li strong {
    color: var(--color-ink);
    font-size: 11px;
  }

  li span,
  li small {
    color: var(--color-ink-muted);
    font-size: 10px;
    line-height: 1.4;
  }
</style>
