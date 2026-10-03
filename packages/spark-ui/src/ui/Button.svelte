<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    variant = "primary",
    size = "default",
    type = "button",
    href,
    loading = false,
    disabled = false,
    title,
    name,
    value,
    form,
    target,
    rel,
    ariaLabel,
    ariaExpanded,
    ariaControls,
    element = $bindable(),
    class: className = "",
    onclick,
    children,
  }: {
    variant?: "primary" | "secondary" | "danger" | "ghost";
    size?: "compact" | "default";
    type?: "button" | "submit";
    href?: string;
    loading?: boolean;
    disabled?: boolean;
    title?: string;
    name?: string;
    value?: string;
    form?: string;
    target?: "_blank" | "_self" | "_parent" | "_top";
    rel?: string;
    ariaLabel?: string;
    ariaExpanded?: boolean;
    ariaControls?: string;
    element?: HTMLButtonElement | HTMLAnchorElement;
    class?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

{#if href}
  <a
    bind:this={element}
    class="ui-button {className}"
    class:loading
    data-variant={variant}
    data-size={size}
    {href}
    {title}
    {target}
    {rel}
    aria-label={ariaLabel}
  >
    {#if loading}
      <span class="ui-button-spinner" aria-hidden="true"></span>
    {/if}
    {@render children()}
  </a>
{:else}
  <button
    bind:this={element}
    class="ui-button {className}"
    class:loading
    data-variant={variant}
    data-size={size}
    {type}
    disabled={disabled || loading}
    {title}
    {name}
    {value}
    {form}
    aria-busy={loading || undefined}
    aria-label={ariaLabel}
    aria-expanded={ariaExpanded}
    aria-controls={ariaControls}
    {onclick}
  >
    {#if loading}
      <span class="ui-button-spinner" aria-hidden="true"></span>
    {/if}
    {@render children()}
  </button>
{/if}

<style>
  .ui-button {
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    box-sizing: border-box;
    cursor: pointer;
    display: inline-flex;
    font-family: var(--font-sans);
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    gap: var(--spacing-xs);
    justify-content: center;
    line-height: var(--leading-button);
    min-height: var(--control-height-default);
    padding: 8px 14px;
    text-decoration: none;
    transition:
      background var(--motion-fast) ease,
      border-color var(--motion-fast) ease,
      color var(--motion-fast) ease;
  }

  .ui-button[data-size="compact"] {
    font-size: var(--text-caption);
    min-height: var(--control-height-compact);
    padding: 5px 10px;
  }

  .ui-button[data-variant="primary"] {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-on-primary);
  }

  .ui-button[data-variant="primary"]:not(:disabled):hover {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }

  .ui-button[data-variant="secondary"] {
    background: var(--color-surface);
    border-color: var(--color-border-strong);
    color: var(--color-ink-muted);
  }

  .ui-button[data-variant="secondary"]:not(:disabled):hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .ui-button[data-variant="danger"] {
    background: var(--color-danger);
    border-color: var(--color-danger);
    color: var(--color-on-primary);
  }

  .ui-button[data-variant="danger"]:not(:disabled):hover {
    filter: brightness(0.94);
  }

  .ui-button[data-variant="ghost"] {
    background: transparent;
    border-color: var(--color-border);
    color: var(--color-ink-muted);
  }

  .ui-button[data-variant="ghost"]:not(:disabled):hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .ui-button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .ui-button:disabled {
    background: var(--color-border);
    border-color: var(--color-border);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }

  .ui-button.loading,
  .ui-button.loading:disabled {
    cursor: wait;
  }

  .ui-button-spinner {
    border: 2px solid currentColor;
    border-bottom-color: transparent;
    border-radius: var(--rounded-full);
    box-sizing: border-box;
    display: inline-block;
    flex: 0 0 auto;
    height: 1em;
    opacity: 0.7;
    width: 1em;
  }

  @media (prefers-reduced-motion: no-preference) {
    .ui-button-spinner {
      animation: ui-button-spin 0.8s linear infinite;
    }
  }

  @keyframes ui-button-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ui-button-spinner {
      animation: none;
    }
  }

  @media (pointer: coarse) {
    .ui-button,
    .ui-button[data-size="compact"] {
      min-height: var(--control-height-touch);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ui-button {
      transition: none;
    }
  }
</style>
