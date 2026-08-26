<script lang="ts">
  import { Notice, PageHeader, PageLayout, Panel, StatusPill } from "@zendev-lab/spark-ui";
  let { data } = $props();
  let copy = $derived(data.messages.web.invocation);
  let status = $derived(data.view.status);

  function statusLabel(value: string): string {
    return data.messages.shared.status[value] ?? value;
  }

  function formatTime(value: string | undefined): string {
    if (!value) return copy.notAvailable;
    return new Intl.DateTimeFormat(data.locale, { dateStyle: "medium", timeStyle: "long" }).format(new Date(value));
  }
</script>

{#snippet invocationStatus()}
  <StatusPill label={statusLabel(status.status)} status={status.status} />
{/snippet}

<PageLayout>
  <PageHeader eyebrow={copy.eyebrow} title={status.invocationId} lede={copy.lede} badge={invocationStatus} />

  <dl class="facts">
    <div><dt>{copy.session}</dt><dd>{#if status.sessionId}<a href={`/sessions/${encodeURIComponent(status.sessionId)}`}>{status.sessionId}</a>{:else}{copy.notAvailable}{/if}</dd></div>
    <div><dt>{copy.created}</dt><dd>{formatTime(status.createdAt)}</dd></div>
    <div><dt>{copy.started}</dt><dd>{formatTime(status.startedAt)}</dd></div>
    <div><dt>{copy.finished}</dt><dd>{formatTime(status.finishedAt)}</dd></div>
    <div><dt>{copy.cursor}</dt><dd>{status.eventCursor}</dd></div>
    <div><dt>{copy.retryOf}</dt><dd>{status.retryOfInvocationId ?? copy.notAvailable}</dd></div>
  </dl>

  {#if status.error || data.view.result.error}
    {@const error = status.error ?? data.view.result.error}
    <Notice tone="danger" message={`${copy.failure}: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? ""}`} />
  {/if}

  <Panel title={copy.result} compact>
    {#if data.view.result.assistantText}<pre>{data.view.result.assistantText}</pre>{:else}<p class="empty">{copy.noResult}</p>{/if}
  </Panel>

  <Panel title={copy.events} badge={String(data.view.events.length)} compact>
    {#if data.view.events.length === 0}
      <p class="empty">{copy.noEvents}</p>
    {:else}
      <ol>
        {#each data.view.events as event (event.sequence)}
          <li>
            <div><strong>{event.sequence}. {event.kind}</strong><time datetime={event.createdAt}>{formatTime(event.createdAt)}</time></div>
            {#if Object.keys(event.payload).length > 0}<pre>{JSON.stringify(event.payload, null, 2)}</pre>{/if}
          </li>
        {/each}
      </ol>
      {#if data.view.hasMoreEvents}<p class="empty">{copy.truncated}</p>{/if}
    {/if}
  </Panel>
</PageLayout>

<style>
  .facts { display: grid; gap: 10px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; }
  .facts div { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--rounded-lg); box-shadow: var(--shadow-card); padding: var(--spacing-md); }
  dt { color: var(--color-ink-muted); font-size: .78rem; }
  dd { margin: 4px 0 0; overflow-wrap: anywhere; }
  a { color: var(--color-primary); }
  ol li > div { align-items: center; display: flex; justify-content: space-between; gap: 12px; }
  time, .empty { color: var(--color-ink-muted); }
  ol { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
  ol li { border-top: 1px solid var(--color-border); display: grid; gap: 8px; padding-top: 10px; }
  ol li:first-child { border-top: 0; padding-top: 0; }
  pre { background: var(--color-canvas); border-radius: 8px; margin: 0; max-height: 36rem; overflow: auto; padding: 12px; white-space: pre-wrap; }
  @media (max-width: 760px) { .facts { grid-template-columns: 1fr; } }
</style>
