<script lang="ts">
  type Props = {
    id: string;
    value?: string;
    label: string;
    saveLabel: string;
    cancelLabel: string;
    disabled?: boolean;
    onSave?: (value: string) => void | Promise<void>;
    onCancel?: () => void;
  };

  let {
    id,
    value = $bindable(""),
    label,
    saveLabel,
    cancelLabel,
    disabled = false,
    onSave,
    onCancel,
  }: Props = $props();

  function save() {
    const next = value.trim();
    if (!next || disabled) return;
    void onSave?.(next);
  }
</script>

<div class="message-editor">
  <label for={id}>{label}</label>
  <textarea {id} bind:value {disabled} rows="4"></textarea>
  <div class="editor-actions">
    <button type="button" class="secondary" {disabled} onclick={() => onCancel?.()}>
      {cancelLabel}
    </button>
    <button type="button" class="primary" disabled={disabled || !value.trim()} onclick={save}>
      {saveLabel}
    </button>
  </div>
</div>

<style>
  .message-editor {
    display: grid;
    gap: 8px;
  }

  label {
    color: var(--color-ink-muted);
    font-size: 11px;
    font-weight: 650;
  }

  textarea {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    font: inherit;
    line-height: 1.5;
    min-height: 88px;
    padding: 9px 10px;
    resize: vertical;
  }

  textarea:focus-visible {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .editor-actions {
    display: flex;
    gap: 7px;
    justify-content: end;
  }

  button {
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    min-height: 32px;
    padding-inline: 11px;
  }

  button.secondary {
    background: var(--color-surface);
    color: var(--color-ink-muted);
  }

  button.primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-on-primary);
  }

  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
