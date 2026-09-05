<script lang="ts">
  import type { Snippet } from "svelte";

  import Icon from "../Icon.svelte";

  let {
    title,
    summary,
    facts = [],
    tone = "warning",
    actions,
    diagnostics,
    diagnosticsLabel,
    embedded = false,
  }: {
    title: string;
    summary: string;
    facts?: Array<{ label: string; value: string }>;
    tone?: "warning" | "danger" | "info";
    actions?: Snippet;
    diagnostics?: Snippet;
    diagnosticsLabel?: string;
    embedded?: boolean;
  } = $props();
</script>

<section class="recovery-panel" class:embedded data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
  <header>
    <span class="recovery-icon" aria-hidden="true">
      <Icon name={tone === "danger" ? "warning" : "activity"} size={19} />
    </span>
    <div>
      <h2>{title}</h2>
      <p>{summary}</p>
    </div>
  </header>

  {#if facts.length > 0}
    <dl>
      {#each facts as fact}
        <div>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#if actions}
    <div class="recovery-actions">{@render actions()}</div>
  {/if}

  {#if diagnostics && diagnosticsLabel}
    <details>
      <summary>{diagnosticsLabel}</summary>
      <div class="recovery-diagnostics">{@render diagnostics()}</div>
    </details>
  {/if}
</section>

<style>
  .recovery-panel {
    background: var(--color-warning-weak);
    border: 1px solid color-mix(in srgb, var(--color-warning) 28%, var(--color-border));
    border-radius: var(--rounded-lg);
    color: var(--color-warning-strong);
    display: grid;
    gap: var(--spacing-md);
    padding: var(--spacing-lg);
  }

  .recovery-panel[data-tone="danger"] {
    background: var(--color-danger-weak);
    border-color: color-mix(in srgb, var(--color-danger) 28%, var(--color-border));
    color: var(--color-danger-strong);
  }

  .recovery-panel[data-tone="info"] {
    background: var(--color-primary-weak);
    border-color: color-mix(in srgb, var(--color-primary) 24%, var(--color-border));
    color: var(--color-info-strong);
  }

  .recovery-panel.embedded {
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0;
  }

  header {
    align-items: start;
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr);
  }

  .recovery-icon {
    align-items: center;
    background: color-mix(in srgb, currentColor 10%, transparent);
    border-radius: var(--rounded-md);
    display: flex;
    height: 36px;
    justify-content: center;
    width: 36px;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    color: currentColor;
    font-size: var(--text-card-title);
    font-weight: 680;
  }

  p {
    color: color-mix(in srgb, currentColor 82%, var(--color-ink));
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
    margin-top: 3px;
    max-width: 68ch;
  }

  dl {
    display: grid;
    gap: var(--spacing-xs);
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    margin: 0;
  }

  dl > div {
    border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    display: grid;
    gap: 2px;
    padding-top: var(--spacing-xs);
  }

  dt {
    font-size: 11px;
    font-weight: 650;
  }

  dd {
    color: color-mix(in srgb, currentColor 82%, var(--color-ink));
    font-size: var(--text-caption);
    margin: 0;
  }

  .recovery-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
  }

  details {
    border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    padding-top: var(--spacing-sm);
  }

  summary {
    cursor: pointer;
    font-size: var(--text-caption);
    font-weight: 650;
  }

  .recovery-diagnostics {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    margin-top: var(--spacing-sm);
  }
</style>
