<script lang="ts">
  import type {
    SparkTokenUsageAggregate,
    SparkTokenUsageByPersistence,
  } from "@zendev-lab/spark-protocol/token-usage";

  export interface ReproTokenUsageLabels {
    title: string;
    reported: string;
    estimated: string;
    missingResponses: string;
    coverageGaps: string;
    activeExecutions: string;
    lowerBound: string;
    breakdown: string;
    executionKinds: string;
    models: string;
    persistence: string;
    anonymousSessions: string;
    persistentSessions: string;
    responses: string;
    noBreakdown: string;
    unknownUsage: string;
  }

  let {
    usage,
    usageByPersistence,
    labels,
  }: {
    usage: SparkTokenUsageAggregate;
    usageByPersistence?: SparkTokenUsageByPersistence;
    labels: ReproTokenUsageLabels;
  } = $props();

  const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  let kindRows = $derived(sortedRows(usage.byExecutionKind));
  let modelRows = $derived(sortedRows(usage.byModel));
  let isLowerBound = $derived(usage.quality === "partial");
  let isUnknown = $derived(usage.quality === "unknown");

  function count(value: number): string {
    return formatter.format(value);
  }

  function sortedRows(
    values: SparkTokenUsageAggregate["byExecutionKind"],
  ): Array<[string, number]> {
    return Object.entries(values)
      .map(([name, breakdown]) => [name, breakdown.totalTokens] as [string, number])
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }
</script>

<article class="token-card" aria-label={labels.title}>
  <header>
    <div>
      <p class="field-label">{labels.title}</p>
      <p class="token-summary">
        {#if isUnknown}
          <strong>{labels.unknownUsage}</strong>
        {:else}
          <strong>{count(usage.totalTokens)} tokens</strong>
          <span>· {count(usage.reported.totalTokens)} {labels.reported}</span>
          <span>+ {count(usage.estimated.totalTokens)} {labels.estimated}</span>
          <span>· {count(usage.missingResponseCount)} {labels.missingResponses}</span>
          {#if (usage.coverageGapCount ?? 0) > 0}
            <span>· {count(usage.coverageGapCount ?? 0)} {labels.coverageGaps}</span>
          {/if}
        {/if}
      </p>
    </div>
    <span class:partial={isLowerBound} class="quality">
      {usage.quality}{isLowerBound ? ` · ${labels.lowerBound}` : ""}
    </span>
  </header>

  {#if usage.activeExecutionCount > 0}
    <p class="active-note">
      {count(usage.activeExecutionCount)} {labels.activeExecutions}; {labels.lowerBound}
    </p>
  {/if}

  <details>
    <summary>{labels.breakdown}</summary>
    <div class="breakdown-grid">
      <section>
        <h4>{labels.executionKinds}</h4>
        {#if kindRows.length > 0}
          <dl>
            {#each kindRows as [name, tokens]}
              <div><dt>{name}</dt><dd>{count(tokens)}</dd></div>
            {/each}
          </dl>
        {:else}
          <p>{labels.noBreakdown}</p>
        {/if}
      </section>
      {#if usageByPersistence}
        <section>
          <h4>{labels.persistence}</h4>
          <dl>
            <div>
              <dt>{labels.anonymousSessions}</dt>
              <dd>
                {count(usageByPersistence.byPersistence.anonymous.totalTokens)} ·
                {count(usageByPersistence.byPersistence.anonymous.responseCount)} {labels.responses}
              </dd>
            </div>
            <div>
              <dt>{labels.persistentSessions}</dt>
              <dd>
                {count(usageByPersistence.byPersistence.persistent.totalTokens)} ·
                {count(usageByPersistence.byPersistence.persistent.responseCount)} {labels.responses}
              </dd>
            </div>
          </dl>
        </section>
      {/if}
      <section>
        <h4>{labels.models}</h4>
        {#if modelRows.length > 0}
          <dl>
            {#each modelRows as [name, tokens]}
              <div><dt>{name}</dt><dd>{count(tokens)}</dd></div>
            {/each}
          </dl>
        {:else}
          <p>{labels.noBreakdown}</p>
        {/if}
      </section>
    </div>
  </details>
</article>

<style>
  .token-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-card);
    display: grid;
    gap: 10px;
    grid-column: 1 / -1;
    min-width: 0;
    padding: var(--spacing-md);
  }

  header {
    align-items: start;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  .field-label,
  h4 {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    margin: 0;
    text-transform: uppercase;
  }

  .token-summary {
    color: var(--color-ink-muted);
    display: flex;
    flex-wrap: wrap;
    font-size: 13px;
    gap: 4px;
    line-height: 1.55;
    margin: 4px 0 0;
  }

  .token-summary strong {
    color: var(--color-ink);
  }

  .quality {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    font-size: 11px;
    padding: 4px 8px;
    white-space: nowrap;
  }

  .quality.partial,
  .active-note {
    color: var(--color-warning-strong);
  }

  .quality.partial {
    background: var(--color-warning-weak);
    border-color: var(--color-warning-soft);
  }

  .active-note {
    font-size: 12px;
    margin: 0;
  }

  details {
    border-top: 1px solid var(--color-border);
    padding-top: 8px;
  }

  summary {
    color: var(--color-ink-muted);
    cursor: pointer;
    font-size: 12px;
  }

  .breakdown-grid {
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    padding-top: 10px;
  }

  h4 {
    margin-bottom: 6px;
  }

  dl {
    display: grid;
    gap: 5px;
    margin: 0;
  }

  dl div {
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }

  dt,
  dd,
  section p {
    color: var(--color-ink-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    margin: 0;
    overflow-wrap: anywhere;
  }

  dd {
    color: var(--color-ink);
  }

  @media (max-width: 620px) {
    header {
      align-items: stretch;
      flex-direction: column;
    }

    .quality {
      align-self: start;
    }

    .breakdown-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
