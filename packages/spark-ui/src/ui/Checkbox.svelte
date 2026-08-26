<script lang="ts">
  let {
    id,
    label,
    description,
    name,
    value,
    checked = $bindable(false),
    disabled = false,
    required = false,
    compact = false,
    onchange,
  }: {
    id: string;
    label: string;
    description?: string;
    name?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    required?: boolean;
    compact?: boolean;
    onchange?: (event: Event & { currentTarget: HTMLInputElement }) => void;
  } = $props();
</script>

<label class="ui-checkbox" class:compact class:disabled for={id}>
  <input
    class="ui-checkbox-input"
    {id}
    type="checkbox"
    {name}
    {value}
    bind:checked
    {disabled}
    {required}
    {onchange}
  />
  <span class="ui-checkbox-control" aria-hidden="true"></span>
  <span class="ui-checkbox-copy">
    <span class="ui-checkbox-label">{label}</span>
    {#if description}<small>{description}</small>{/if}
  </span>
</label>

<style>
  .ui-checkbox {
    align-items: start;
    color: var(--color-ink);
    cursor: pointer;
    display: grid;
    gap: var(--spacing-xs);
    grid-template-columns: 18px minmax(0, 1fr);
    min-width: 0;
  }

  .ui-checkbox.compact {
    gap: 6px;
  }

  .ui-checkbox-input {
    block-size: 16px;
    inline-size: 16px;
    margin: 0;
    opacity: 0;
    position: absolute;
  }

  .ui-checkbox-control {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-xs);
    display: inline-flex;
    height: 16px;
    justify-content: center;
    margin-top: 2px;
    transition:
      background var(--motion-fast) ease,
      border-color var(--motion-fast) ease,
      box-shadow var(--motion-fast) ease;
    width: 16px;
  }

  .ui-checkbox-control::after {
    border: solid var(--color-on-primary);
    border-width: 0 0 2px 2px;
    content: "";
    height: 4px;
    transform: translateY(-1px) rotate(-45deg) scale(0);
    transition: transform var(--motion-fast) ease;
    width: 8px;
  }

  .ui-checkbox-input:checked + .ui-checkbox-control {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }

  .ui-checkbox-input:checked + .ui-checkbox-control::after {
    transform: translateY(-1px) rotate(-45deg) scale(1);
  }

  .ui-checkbox-input:focus-visible + .ui-checkbox-control {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .ui-checkbox-input:disabled + .ui-checkbox-control {
    background: var(--color-surface-soft);
    border-color: var(--color-border);
  }

  .ui-checkbox-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .ui-checkbox-label {
    font-size: var(--text-body);
    line-height: var(--leading-body);
  }

  small {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
  }

  .ui-checkbox.disabled {
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }
</style>
