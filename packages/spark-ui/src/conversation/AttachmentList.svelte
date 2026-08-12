<script lang="ts">
  import Icon from "../Icon.svelte";
  import { formatAttachmentSize, safeConversationHref } from "./chat-view";
  import type { ConversationAttachmentView } from "./chat-types";

  type Props = {
    items: readonly ConversationAttachmentView[];
    label: string;
    removeLabel?: string;
    openLabel?: string;
    onRemove?: (attachment: ConversationAttachmentView) => void;
  };

  let { items, label, removeLabel, openLabel, onRemove }: Props = $props();

  function extension(name: string) {
    return name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE";
  }
</script>

{#if items.length > 0}
  <div class="attachment-list" role="list" aria-label={label}>
    {#each items as attachment (attachment.id)}
      {@const safeHref = safeConversationHref(attachment.href)}
      <article class:image={attachment.kind === "image"} class="attachment-card" role="listitem">
        {#if attachment.kind === "image" && attachment.previewHref}
          <img src={attachment.previewHref} alt="" />
        {:else}
          <span class="attachment-file-mark {attachment.kind}" aria-hidden="true">
            {attachment.kind === "audio" ? "AUDIO" : extension(attachment.name)}
          </span>
        {/if}
        <div class="attachment-copy">
          {#if safeHref && openLabel}
            <a href={safeHref} title={`${openLabel}: ${attachment.name}`}>
              {attachment.name}
            </a>
          {:else}
            <strong title={attachment.name}>{attachment.name}</strong>
          {/if}
          {#if formatAttachmentSize(attachment.sizeBytes)}
            <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
          {:else if attachment.mediaType}
            <span>{attachment.mediaType}</span>
          {/if}
        </div>
        {#if onRemove && removeLabel}
          <button
            type="button"
            class="attachment-remove"
            aria-label={`${removeLabel}: ${attachment.name}`}
            title={removeLabel}
            onclick={() => onRemove?.(attachment)}
          >
            <Icon name="close" size={13} stroke={2.3} />
          </button>
        {/if}
      </article>
    {/each}
  </div>
{/if}

<style>
  .attachment-list {
    display: flex;
    gap: 8px;
    min-width: 0;
    overflow-x: auto;
    padding-block-end: 2px;
    scrollbar-width: thin;
  }

  .attachment-card {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 10px;
    display: grid;
    flex: 0 0 184px;
    gap: 8px;
    grid-template-columns: 40px minmax(0, 1fr) auto;
    min-height: 52px;
    overflow: hidden;
    padding: 5px;
  }

  .attachment-card.image {
    flex-basis: 154px;
  }

  img,
  .attachment-file-mark {
    border-radius: 7px;
    height: 40px;
    object-fit: cover;
    width: 40px;
  }

  .attachment-file-mark {
    align-items: center;
    background: var(--color-primary-weak);
    color: var(--color-primary);
    display: flex;
    font-size: 9px;
    font-weight: 750;
    justify-content: center;
    letter-spacing: 0.02em;
  }

  .attachment-file-mark.audio {
    background: var(--color-purple-soft);
    color: var(--color-purple);
    font-size: 8px;
  }

  .attachment-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .attachment-copy strong,
  .attachment-copy a {
    color: var(--color-ink);
    font-size: 11px;
    font-weight: 650;
    overflow: hidden;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-copy a:hover {
    text-decoration: underline;
  }

  .attachment-copy span {
    color: var(--color-ink-muted);
    font-size: 10px;
  }

  .attachment-remove {
    align-items: center;
    align-self: start;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    height: 22px;
    justify-content: center;
    width: 22px;
  }

  .attachment-remove:hover {
    background: var(--color-surface-raised);
    color: var(--color-ink);
  }

  .attachment-remove:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }
</style>
