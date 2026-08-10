<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { ConversationSpeechState } from "./chat-types";

  type Props = {
    state: ConversationSpeechState;
    startLabel: string;
    stopLabel: string;
    cancelLabel: string;
    processingLabel: string;
    disabled?: boolean;
    onStart?: () => void;
    onStop?: () => void;
    onCancel?: () => void;
  };

  let {
    state,
    startLabel,
    stopLabel,
    cancelLabel,
    processingLabel,
    disabled = false,
    onStart,
    onStop,
    onCancel,
  }: Props = $props();

  let activeLabel = $derived(
    state === "recording"
      ? stopLabel
      : state === "requesting" || state === "processing"
        ? processingLabel
        : startLabel,
  );
</script>

<div class="speech-input" class:recording={state === "recording"} role="group">
  <button
    type="button"
    class="speech-primary"
    aria-label={activeLabel}
    title={activeLabel}
    disabled={disabled || state === "requesting" || state === "processing"}
    onclick={() => (state === "recording" ? onStop?.() : onStart?.())}
  >
    <Icon name={state === "recording" ? "stop" : "mic"} size={15} />
  </button>
  {#if state === "recording" && onCancel}
    <button
      type="button"
      class="speech-cancel"
      aria-label={cancelLabel}
      title={cancelLabel}
      onclick={() => onCancel?.()}
    >
      <Icon name="close" size={14} />
    </button>
  {/if}
  <span class="sr-only" aria-live="polite">{activeLabel}</span>
</div>

<style>
  .speech-input {
    align-items: center;
    display: inline-flex;
    gap: 3px;
  }

  button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    height: 32px;
    justify-content: center;
    width: 32px;
  }

  .recording .speech-primary {
    background: var(--color-danger-weak);
    color: var(--color-danger);
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
    cursor: not-allowed;
    opacity: 0.5;
  }

  .sr-only {
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
</style>
