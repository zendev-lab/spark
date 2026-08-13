<script lang="ts">
  let { delegations, workspaces, authorizedWorkspaceId, messages, audits } = $props();

  function workspaceName(id: string) {
    return workspaces.find((workspace: { id: string }) => workspace.id === id)?.name ?? id;
  }

  function workspaceSlug(id: string) {
    return workspaces.find((workspace: { id: string }) => workspace.id === id)?.slug ?? id;
  }
</script>

<svelte:head><title>{messages.title} · Spark</title></svelte:head>

<section class="delegations-page">
  <header>
    <p class="eyebrow">{messages.eyebrow}</p>
    <h1>{messages.title}</h1>
    <p>{messages.lede}</p>
  </header>

  {#if delegations.length === 0}
    <div class="empty">{messages.empty}</div>
  {:else}
    <div class="delegation-list">
      {#each delegations as delegation}
        <article class="delegation-card">
          <div class="delegation-heading">
            <div>
              <code>{delegation.request.delegationId}</code>
              <h2>{delegation.request.goal}</h2>
            </div>
            <span class="status" data-status={delegation.status}>{delegation.status}</span>
          </div>
          <dl>
            <div><dt>{messages.source}</dt><dd>{workspaceName(delegation.request.sourceWorkspaceId)}</dd></div>
            <div><dt>{messages.target}</dt><dd>{workspaceName(delegation.request.targetWorkspaceId)}</dd></div>
            <div><dt>{messages.status}</dt><dd>{delegation.status}</dd></div>
          </dl>
          {#if delegation.receipt}
            <section class="receipt">
              <h3>{messages.receipt}</h3>
              <p>{delegation.receipt.summary}</p>
              {#if delegation.receipt.artifactRefs.length > 0}
                <p><strong>{messages.artifacts}:</strong> {delegation.receipt.artifactRefs.join(", ")}</p>
              {/if}
              {#if delegation.receipt.verification.length > 0}
                <ul aria-label={messages.verification}>
                  {#each delegation.receipt.verification as check}
                    <li>{check.status} · {check.label}{check.summary ? ` — ${check.summary}` : ""}</li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/if}
          {#if audits?.[delegation.request.delegationId]?.length}
            <section class="audit">
              <h3>{messages.audit}</h3>
              <ol>
                {#each audits[delegation.request.delegationId] as message}
                  <li>
                    <code>#{message.sequence}</code>
                    {message.kind} · {message.deliveryStatus} ·
                    {workspaceName(message.fromWorkspaceId)} → {workspaceName(message.toWorkspaceId)}
                    {#if message.runtimeControlCommandId}<code>{message.runtimeControlCommandId}</code>{/if}
                  </li>
                {/each}
              </ol>
            </section>
          {/if}
          {#if delegation.targetSessionId && (!authorizedWorkspaceId || authorizedWorkspaceId === delegation.request.targetWorkspaceId)}
            <a class="session-link" href={`/${encodeURIComponent(workspaceSlug(delegation.request.targetWorkspaceId))}/sessions/${encodeURIComponent(delegation.targetSessionId)}`}>
              {messages.openAdministratorSession}
            </a>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .delegations-page { display: grid; gap: 24px; max-width: 1080px; margin: 0 auto; padding: 32px; }
  header { display: grid; gap: 8px; }
  header h1, header p { margin: 0; }
  .eyebrow { color: var(--color-accent, #6d5efc); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
  .delegation-list { display: grid; gap: 16px; }
  .delegation-card, .empty { border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); padding: 20px; }
  .delegation-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .delegation-heading h2 { margin: 8px 0 0; font-size: 1.05rem; }
  .status { border-radius: 999px; background: var(--color-surface-raised); padding: 5px 9px; font-size: 0.75rem; font-weight: 700; }
  .status[data-status="completed"] { color: var(--color-success); }
  .status[data-status="failed"], .status[data-status="rejected"] { color: var(--color-danger); }
  dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 18px 0 0; }
  dl div { display: grid; gap: 4px; }
  dt { color: var(--color-ink-muted); font-size: 0.75rem; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .receipt { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--color-border); }
  .receipt h3, .receipt p { margin: 0 0 8px; }
  .audit { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--color-border); }
  .audit h3 { margin: 0 0 8px; }
  .audit ol { display: grid; gap: 6px; margin: 0; padding-left: 20px; color: var(--color-ink-muted); font-size: 0.82rem; }
  .audit li code:last-child { margin-left: 8px; }
  .session-link { display: inline-flex; margin-top: 14px; font-weight: 650; }
  @media (max-width: 720px) { .delegations-page { padding: 20px; } dl { grid-template-columns: 1fr; } }
</style>
