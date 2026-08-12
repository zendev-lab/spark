<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { TestResultView } from "./types";

  type Props = {
    results: readonly TestResultView[];
    label: string;
    statusLabel: (status: string) => string;
    durationLabel: (milliseconds: number) => string;
  };
  const componentId = $props.id();
  const titleId = `${componentId}-test-results-title`;
  let { results, label, statusLabel, durationLabel }: Props = $props();
  let passed = $derived(results.filter((result) => result.status === "passed").length);
  let failed = $derived(results.filter((result) => result.status === "failed").length);
</script>

<section class="test-results" aria-labelledby={titleId}>
  <header>
    <strong id={titleId}>{label}</strong>
    <span class="passed">{passed} {statusLabel("passed")}</span>
    <span class:has-failures={failed > 0}>{failed} {statusLabel("failed")}</span>
  </header>
  <ul>
    {#each results as result (result.id)}
      <li class={result.status}>
        <Icon name={result.status === "passed" ? "check" : result.status === "failed" ? "close" : "activity"} size={13} />
        <div><strong>{result.name}</strong>{#if result.message}<p>{result.message}</p>{/if}</div>
        <span>{statusLabel(result.status)}</span>
        {#if result.durationMs !== undefined}<time>{durationLabel(result.durationMs)}</time>{/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .test-results { border: 1px solid var(--color-border); border-radius: var(--rounded-lg); overflow: hidden; }
  header { align-items: center; background: var(--color-surface-soft); display: flex; font-size: 11px; gap: 10px; min-height: 36px; padding-inline: 10px; }
  header strong { margin-inline-end: auto; } header span { color: var(--color-success-strong); } header .has-failures { color: var(--color-danger-strong); }
  ul { display: grid; list-style: none; margin: 0; padding: 4px 0; }
  li { align-items: start; color: var(--color-ink-subtle); display: grid; font-size: 11px; gap: 8px; grid-template-columns: auto minmax(0, 1fr) auto auto; padding: 7px 10px; }
  li.failed { color: var(--color-danger-strong); } li.passed { color: var(--color-success-strong); }
  li div { color: var(--color-ink); display: grid; gap: 2px; }
  li p { color: var(--color-ink-muted); font-size: 10px; margin: 0; }
  li > span, time { color: var(--color-ink-subtle); font-size: 10px; }
</style>
