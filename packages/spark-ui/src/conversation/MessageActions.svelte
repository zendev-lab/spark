<script lang="ts">
  import Icon from "../Icon.svelte";

  type Props = {
    text: string;
    copyLabel: string;
    copiedLabel: string;
    retryLabel?: string;
    editLabel?: string;
    downloadLabel?: string;
    shareLabel?: string;
    positiveFeedbackLabel?: string;
    negativeFeedbackLabel?: string;
    onRetry?: () => void;
    onEdit?: () => void;
    onDownload?: () => void;
    onShare?: () => void;
    onPositiveFeedback?: () => void;
    onNegativeFeedback?: () => void;
  };

  let {
    text,
    copyLabel,
    copiedLabel,
    retryLabel,
    editLabel,
    downloadLabel,
    shareLabel,
    positiveFeedbackLabel,
    negativeFeedbackLabel,
    onRetry,
    onEdit,
    onDownload,
    onShare,
    onPositiveFeedback,
    onNegativeFeedback,
  }: Props = $props();
  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyMessage() {
    if (!text.trim() || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => (copied = false), 1_500);
    } catch {
      copied = false;
    }
  }
</script>

<div class="message-actions">
  <button
    type="button"
    aria-label={copied ? copiedLabel : copyLabel}
    title={copied ? copiedLabel : copyLabel}
    disabled={!text.trim()}
    onclick={copyMessage}
  >
    <Icon name={copied ? "check" : "copy"} size={14} stroke={2.1} />
    <span class="sr-only">{copied ? copiedLabel : copyLabel}</span>
  </button>
  {#if onRetry && retryLabel}
    <button type="button" aria-label={retryLabel} title={retryLabel} onclick={() => onRetry?.()}>
      <Icon name="retry" size={14} stroke={2.1} />
    </button>
  {/if}
  {#if onEdit && editLabel}
    <button type="button" aria-label={editLabel} title={editLabel} onclick={() => onEdit?.()}>
      <span aria-hidden="true">✎</span>
    </button>
  {/if}
  {#if onDownload && downloadLabel}
    <button
      type="button"
      aria-label={downloadLabel}
      title={downloadLabel}
      onclick={() => onDownload?.()}
    >
      <Icon name="download" size={14} stroke={2.1} />
    </button>
  {/if}
  {#if onPositiveFeedback && positiveFeedbackLabel}
    <button
      type="button"
      aria-label={positiveFeedbackLabel}
      title={positiveFeedbackLabel}
      onclick={() => onPositiveFeedback?.()}
    >
      <Icon name="thumbs-up" size={14} stroke={2.1} />
    </button>
  {/if}
  {#if onNegativeFeedback && negativeFeedbackLabel}
    <button
      type="button"
      aria-label={negativeFeedbackLabel}
      title={negativeFeedbackLabel}
      onclick={() => onNegativeFeedback?.()}
    >
      <Icon name="thumbs-down" size={14} stroke={2.1} />
    </button>
  {/if}
  {#if onShare && shareLabel}
    <button type="button" aria-label={shareLabel} title={shareLabel} onclick={() => onShare?.()}>
      <Icon name="share" size={14} stroke={2.1} />
    </button>
  {/if}
</div>

<style>
  .message-actions {
    align-items: center;
    display: flex;
    min-height: 26px;
  }

  button {
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    height: 26px;
    justify-content: center;
    padding: 0;
    width: 26px;
  }

  button:hover:not(:disabled) {
    background: var(--color-surface-soft);
    border-color: var(--color-border-soft);
    color: var(--color-ink-muted);
  }

  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
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

  @media (hover: hover) {
    .message-actions {
      opacity: 0;
      transition: opacity 120ms ease;
    }

    :global(.conversation-message:hover) .message-actions,
    :global(.conversation-message:focus-within) .message-actions {
      opacity: 1;
    }
  }
</style>
