<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    description?: string;
    actions?: Snippet;
  };

  let { title, description, actions }: Props = $props();
</script>

<section class="conversation-empty-state">
  <span class="empty-mark" aria-hidden="true">✦</span>
  <div>
    <h2>{title}</h2>
    {#if description}<p>{description}</p>{/if}
  </div>
  {#if actions}<div class="empty-actions">{@render actions()}</div>{/if}
</section>

<style>
  .conversation-empty-state {
    align-items: center;
    color: var(--color-ink-muted);
    display: grid;
    gap: 12px;
    justify-items: center;
    margin: auto;
    max-width: 480px;
    padding: 42px 20px;
    text-align: center;
  }

  .empty-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: var(--rounded-lg);
    color: var(--color-primary);
    display: inline-flex;
    font-size: 18px;
    height: 42px;
    justify-content: center;
    width: 42px;
  }

  h2 {
    color: var(--color-ink);
    font-size: 16px;
    margin: 0;
  }

  p {
    font-size: 12px;
    line-height: 1.55;
    margin: 5px 0 0;
  }

  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }
</style>
