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
  <PageHeader title={copy.title} lede={copy.lede} badge={invocationStatus} />

  <dl class="facts">
    <div><dt>{copy.session}</dt><dd>{#if status.sessionId}<a href={`/sessions/${encodeURIComponent(status.sessionId)}`}>{status.sessionId}</a>{:else}{copy.notAvailable}{/if}</dd></div>
    <div><dt>{copy.created}</dt><dd>{formatTime(status.createdAt)}</dd></div>
    <div><dt>{copy.started}</dt><dd>{formatTime(status.startedAt)}</dd></div>
    <div><dt>{copy.finished}</dt><dd>{formatTime(status.finishedAt)}</dd></div>
  </dl>

  <details class="technical-details">
    <summary>{copy.technicalDetails}</summary>
    <dl>
      <div><dt>{copy.identifier}</dt><dd><code>{status.invocationId}</code></dd></div>
      <div><dt>{copy.cursor}</dt><dd><code>{status.eventCursor}</code></dd></div>
      <div><dt>{copy.retryOf}</dt><dd>{#if status.retryOfInvocationId}<code>{status.retryOfInvocationId}</code>{:else}{copy.notAvailable}{/if}</dd></div>
    </dl>
  </details>

  {#if status.error || data.view.result.error}
    {@const error = status.error ?? data.view.result.error}
    <Notice tone="danger" message={`${copy.failure}: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? ""}`} />
  {/if}

  <Panel title={copy.result} compact>
    {#if data.view.result.assistantText}<pre>{data.view.result.assistantText}</pre>{:else}<p class="empty">{copy.noResult}</p>{/if}
  </Panel>

  <details class="event-log">
    <summary>{copy.events} <span>{data.view.events.length}</span></summary>
    <div class="event-log-body">
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
    </div>
  </details>
</PageLayout>

<style>
  .facts { border-block: 1px solid var(--color-border); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; }
  .facts > div { border-inline-start: 1px solid var(--color-border); padding: var(--spacing-md); }
  .facts > div:first-child { border-inline-start: 0; }
  dt { color: var(--color-ink-muted); font-size: .78rem; }
  dd { margin: 4px 0 0; overflow-wrap: anywhere; }
  a { color: var(--color-primary); }
  details { border-top: 1px solid var(--color-border); }
  details > summary { color: var(--color-ink-muted); cursor: pointer; font-size: .86rem; font-weight: 650; list-style-position: outside; padding: 12px 2px; }
  details > summary:hover { color: var(--color-ink); }
  details > summary:focus-visible { border-radius: var(--rounded-sm); box-shadow: var(--shadow-focus); outline: none; }
  .technical-details dl { display: grid; gap: 10px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; padding: 0 0 var(--spacing-md); }
  .event-log > summary { align-items: center; display: flex; gap: 8px; }
  .event-log > summary span { background: var(--color-surface-muted); border-radius: 999px; color: var(--color-ink); font-size: .72rem; padding: 2px 7px; }
  .event-log-body { padding-block: 4px var(--spacing-md); }
  ol li > div { align-items: center; display: flex; justify-content: space-between; gap: 12px; }
  time, .empty { color: var(--color-ink-muted); }
  ol { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
  ol li { border-top: 1px solid var(--color-border); display: grid; gap: 8px; padding-top: 10px; }
  ol li:first-child { border-top: 0; padding-top: 0; }
  pre { background: var(--color-canvas); border-radius: 8px; margin: 0; max-height: 36rem; overflow: auto; padding: 12px; white-space: pre-wrap; }
  @media (max-width: 760px) {
    .facts, .technical-details dl { grid-template-columns: 1fr; }
    .facts > div { border-inline-start: 0; border-top: 1px solid var(--color-border); }
    .facts > div:first-child { border-top: 0; }
  }
</style>
