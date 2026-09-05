<script lang="ts">
  import { Icon } from "@zendev-lab/spark-ui";
  import { SafeMarkdown } from "@zendev-lab/spark-ui/markdown";
  import type { ConversationPartLabels } from "@zendev-lab/spark-ui/conversation";

  type Props = {
    bindingLabel?: string;
    state: "running" | "completed" | "failed";
    request: string;
    result?: string;
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
  };

  let {
    bindingLabel,
    state: runtimeState,
    request,
    result,
    labels,
    statusLabel,
  }: Props = $props();
  let expanded = $state(false);
  let title = $derived(
    `${labels.runtimeControl}${bindingLabel?.trim() ? ` · ${bindingLabel.trim()}` : ""} ${labels.runtimeTick}`,
  );
</script>

<details class="runtime-control {runtimeState}" bind:open={expanded}>
  <summary>
    <span class="runtime-icon" aria-hidden="true"><Icon name="activity" size={13} /></span>
    <span class="runtime-title">{title}</span>
    <span class="runtime-state">{statusLabel(runtimeState)}</span>
    <span class="disclosure" aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
  </summary>
  {#if expanded}
    <div class="runtime-details">
      <section>
        <strong>{labels.runtimeRequest}</strong>
        <pre>{request}</pre>
      </section>
      {#if result?.trim()}
        <section>
          <strong>{labels.runtimeResult}</strong>
          <div class="runtime-result">
            <SafeMarkdown source={result} streaming={false} />
          </div>
        </section>
      {/if}
    </div>
  {/if}
</details>

<style>
  .runtime-control {
    background: color-mix(in srgb, var(--color-surface-soft) 72%, transparent);
    border: 1px solid var(--color-border-soft);
    border-radius: 9px;
    color: var(--color-ink-subtle);
    min-width: 0;
    overflow: hidden;
  }

  .runtime-control.failed {
    border-color: color-mix(in srgb, var(--color-danger-strong, #b91c1c) 24%, var(--color-border));
  }

  summary {
    align-items: center;
    cursor: pointer;
    display: grid;
    font-size: 11px;
    gap: 7px;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    list-style: none;
    min-height: 34px;
    padding: 0 10px;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    box-shadow: inset var(--shadow-focus);
    outline: none;
  }

  .runtime-icon,
  .disclosure {
    align-items: center;
    display: inline-flex;
  }

  .runtime-icon {
    color: var(--color-primary);
  }

  .runtime-title {
    color: var(--color-ink-muted);
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-state {
    color: var(--color-ink-subtle);
    font-size: 10px;
  }

  .disclosure {
    transition: transform 120ms ease;
  }

  details[open] .disclosure {
    transform: rotate(180deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure {
      transition: none;
    }
  }

  .runtime-details {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    gap: 12px;
    padding: 10px 12px 12px;
  }

  section {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  section > strong {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.02em;
  }

  pre {
    color: var(--color-ink-muted);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    line-height: 1.55;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .runtime-result {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.55;
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
