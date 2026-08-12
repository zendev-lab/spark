<script lang="ts">
  import Icon from "../Icon.svelte";
  import { formatAttachmentSize, safeConversationHref } from "./chat-view";
  import type { ConversationAttachmentView } from "./chat-types";

  type Props = {
    attachment: ConversationAttachmentView;
    openLabel: string;
  };

  let { attachment, openLabel }: Props = $props();
  let safeHref = $derived(safeConversationHref(attachment.href));
</script>

<figure class="media-attachment {attachment.kind}">
  {#if attachment.kind === "image" && attachment.previewHref}
    <img src={attachment.previewHref} alt={attachment.name} loading="lazy" />
  {:else if attachment.kind === "audio" && attachment.previewHref}
    <audio controls preload="metadata" src={attachment.previewHref} aria-label={attachment.name}>
      <a href={attachment.previewHref}>{openLabel}: {attachment.name}</a>
    </audio>
  {:else}
    <span class="file-mark" aria-hidden="true"><Icon name="file" size={18} /></span>
  {/if}
  <figcaption>
    <span>
      <strong>{attachment.name}</strong>
      {#if formatAttachmentSize(attachment.sizeBytes)}
        <small>{formatAttachmentSize(attachment.sizeBytes)}</small>
      {/if}
    </span>
    {#if safeHref}
      <a href={safeHref} aria-label={`${openLabel}: ${attachment.name}`}>
        <Icon name="external-link" size={14} />
      </a>
    {/if}
  </figcaption>
</figure>

<style>
  .media-attachment {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-lg);
    display: grid;
    gap: 8px;
    margin: 0;
    max-width: min(100%, 560px);
    overflow: hidden;
    padding: 8px;
  }

  img {
    border-radius: var(--rounded-md);
    display: block;
    height: auto;
    max-height: 420px;
    max-width: 100%;
    object-fit: contain;
  }

  audio {
    max-width: 100%;
    width: 420px;
  }

  .file-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-md);
    color: var(--color-primary);
    display: flex;
    height: 56px;
    justify-content: center;
    width: 56px;
  }

  figcaption {
    align-items: center;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    min-width: 0;
  }

  figcaption > span {
    display: grid;
    min-width: 0;
  }

  strong {
    color: var(--color-ink);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    color: var(--color-ink-muted);
    font-size: 10px;
  }

  figcaption a {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    height: 30px;
    justify-content: center;
    width: 30px;
  }

  figcaption a:hover {
    background: var(--color-surface-raised);
    color: var(--color-ink);
  }
</style>
