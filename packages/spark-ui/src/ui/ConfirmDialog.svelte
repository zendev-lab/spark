<script lang="ts">
  import type { Snippet } from "svelte";
  import Dialog from "./Dialog.svelte";
  import Button from "./Button.svelte";
  import { DialogDescription, DialogTitle } from "./headless";

  let {
    open = $bindable(false),
    title,
    description,
    danger = false,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    loading = false,
    trigger,
    onConfirm,
  }: {
    open?: boolean;
    title: string;
    description: string;
    danger?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    loading?: boolean;
    trigger?: Snippet;
    onConfirm?: () => void;
  } = $props();

  function handleConfirm() {
    onConfirm?.();
  }

  function handleCancel() {
    open = false;
  }

  let triggerSnippet = $derived(trigger);
</script>

<Dialog bind:open mobile="center">
  {#snippet trigger()}
    {@render triggerSnippet?.()}
  {/snippet}

  <div class="ui-confirm-dialog">
    <div class="ui-confirm-dialog-title">
      <DialogTitle>{title}</DialogTitle>
    </div>
    <div class="ui-confirm-dialog-description">
      <DialogDescription>{description}</DialogDescription>
    </div>

    <div class="ui-confirm-dialog-actions">
      <Button type="button" variant="secondary" onclick={handleCancel} disabled={loading}>
        {cancelLabel}
      </Button>
      <Button type="button" variant={danger ? "danger" : "primary"} onclick={handleConfirm} {loading}>
        {confirmLabel}
      </Button>
    </div>
  </div>
</Dialog>

<style>
  .ui-confirm-dialog-title {
    font-size: var(--text-section-title);
    font-weight: var(--weight-section-title);
    line-height: var(--leading-section-title);
  }

  .ui-confirm-dialog-title :global(*) {
    margin: 0;
  }

  .ui-confirm-dialog-description {
    color: var(--color-ink-muted);
    line-height: var(--leading-body);
  }

  .ui-confirm-dialog-description :global(*) {
    margin: 0;
  }

  .ui-confirm-dialog {
    display: grid;
    gap: var(--spacing-lg);
    padding: var(--spacing-md);
  }

  .ui-confirm-dialog-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-sm);
    justify-content: flex-end;
    padding-top: var(--spacing-sm);
  }
</style>
