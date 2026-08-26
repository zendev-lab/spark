<script lang="ts">
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

<section class="page">
  <header class="hero">
    <div><p class="eyebrow">{copy.eyebrow}</p><h1>{status.invocationId}</h1><p>{copy.lede}</p></div>
    <span class="status" data-status={status.status}>{statusLabel(status.status)}</span>
  </header>

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
    <section class="panel error"><h2>{copy.failure}</h2><p>{error?.code ? `${error.code}: ` : ""}{error?.message}</p></section>
  {/if}

  <section class="panel">
    <h2>{copy.result}</h2>
    {#if data.view.result.assistantText}<pre>{data.view.result.assistantText}</pre>{:else}<p class="empty">{copy.noResult}</p>{/if}
  </section>

  <section class="panel">
    <header><h2>{copy.events}</h2><span>{data.view.events.length}</span></header>
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
  </section>
</section>

<style>
  .page { display: grid; gap: 18px; padding: 24px; }
  .hero { align-items: end; display: flex; justify-content: space-between; gap: 16px; }
  .hero h1, .hero p, .panel h2 { margin: 0; }
  .hero > div > p:last-child { color: var(--color-ink-muted); margin-top: 4px; }
  .eyebrow { color: var(--color-primary); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .status { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 999px; padding: 5px 10px; }
  .status[data-status="running"] { color: var(--color-primary); }
  .status[data-status="failed"], .error { color: var(--color-danger, #dc2626); }
  .facts { display: grid; gap: 10px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; }
  .facts div, .panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 10px; padding: 14px; }
  dt { color: var(--color-ink-muted); font-size: .78rem; }
  dd { margin: 4px 0 0; overflow-wrap: anywhere; }
  a { color: var(--color-primary); }
  .panel { display: grid; gap: 10px; }
  .panel > header, ol li > div { align-items: center; display: flex; justify-content: space-between; gap: 12px; }
  .panel header span, time, .empty { color: var(--color-ink-muted); }
  ol { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
  ol li { border-top: 1px solid var(--color-border); display: grid; gap: 8px; padding-top: 10px; }
  ol li:first-child { border-top: 0; padding-top: 0; }
  pre { background: var(--color-canvas); border-radius: 8px; margin: 0; max-height: 36rem; overflow: auto; padding: 12px; white-space: pre-wrap; }
  @media (max-width: 760px) { .facts { grid-template-columns: 1fr; } .hero { align-items: start; flex-direction: column; } }
</style>
