<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { ConversationBranchView } from "./chat-types";

  type Props = {
    view: ConversationBranchView;
    label: string;
    previousLabel: string;
    nextLabel: string;
    onPrevious?: () => void;
    onNext?: () => void;
  };

  let { view, label, previousLabel, nextLabel, onPrevious, onNext }: Props = $props();
</script>

<div class="branch-selector" role="group" aria-label={label}>
  <button
    type="button"
    aria-label={previousLabel}
    title={previousLabel}
    disabled={view.current <= 1 || !onPrevious}
    onclick={() => onPrevious?.()}
  >
    <Icon name="arrow-left" size={14} />
  </button>
  <span aria-live="polite">{view.current} / {view.total}</span>
  <button
    type="button"
    aria-label={nextLabel}
    title={nextLabel}
    disabled={view.current >= view.total || !onNext}
    onclick={() => onNext?.()}
  >
    <Icon name="arrow-right" size={14} />
  </button>
</div>

<style>
  .branch-selector {
    align-items: center;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 11px;
    gap: 4px;
  }

  button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-sm);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    height: 26px;
    justify-content: center;
    width: 26px;
  }

  button:hover:not(:disabled) {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  button:disabled {
    cursor: default;
    opacity: 0.35;
  }
</style>
