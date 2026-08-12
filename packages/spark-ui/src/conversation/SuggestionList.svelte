<script lang="ts">
  import type { ConversationSuggestionView } from "./chat-types";

  type Props = {
    suggestions: readonly ConversationSuggestionView[];
    label: string;
    disabled?: boolean;
    onSelect?: (suggestion: ConversationSuggestionView) => void;
  };

  let { suggestions, label, disabled = false, onSelect }: Props = $props();
</script>

{#if suggestions.length > 0}
  <ul class="suggestion-list" aria-label={label}>
    {#each suggestions as suggestion (suggestion.id)}
      <li>
        <button type="button" {disabled} onclick={() => onSelect?.(suggestion)}>
          <strong>{suggestion.label}</strong>
          {#if suggestion.description}<span>{suggestion.description}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .suggestion-list {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  button {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: 2px;
    max-width: min(100%, 280px);
    padding: 8px 11px;
    text-align: start;
  }

  button:hover:not(:disabled) {
    background: var(--color-surface-soft);
    border-color: var(--color-border-strong);
  }

  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  strong {
    color: var(--color-ink);
    font-size: 12px;
  }

  span {
    font-size: 10px;
    line-height: 1.4;
  }
</style>
