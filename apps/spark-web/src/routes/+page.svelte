<script lang="ts">
  import { goto } from "$app/navigation";
  import { SessionTree } from "@zendev-lab/spark-ui/workbench";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let copy = $derived(data.messages.web.home);
  let localPath = $state("");
  let displayName = $state("");
  let registering = $state(false);
  let registerError = $state("");
  const activeInvocations = $derived(
    data.invocations.filter((invocation) =>
      invocation.status === "queued" || invocation.status === "running"
    ),
  );
  const recentInvocations = $derived(
    data.invocations.filter((invocation) =>
      invocation.status !== "queued" && invocation.status !== "running"
    ).slice(0, 12),
  );
  const sessionById = $derived(
    new Map(data.sessions.map((session) => [session.sessionId, session])),
  );
  const workspaceById = $derived(
    new Map(data.workspaces.map((workspace) => [workspace.id, workspace])),
  );

  $effect(() => {
    if (!localPath) localPath = data.launchCwd;
  });

  function sessionLabel(sessionId: string | undefined): string {
    if (!sessionId) return copy.noSession;
    return sessionById.get(sessionId)?.name ?? sessionId;
  }

  function workspaceLabel(workspaceId: string): string {
    return workspaceById.get(workspaceId)?.displayName ?? workspaceId;
  }

  function statusLabel(status: string): string {
    return data.messages.shared.status[status] ?? status;
  }

  function formatTime(value: string): string {
    return new Intl.DateTimeFormat(data.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  async function registerWorkspace(event: SubmitEvent) {
    event.preventDefault();
    const path = localPath.trim();
    if (!path) {
      registerError = copy.localPathRequired;
      return;
    }
    registering = true;
    registerError = "";
    try {
      const name = displayName.trim();
      const created = await webRpc("workspace.register", {
        localPath: path,
        ...(name ? { displayName: name } : {}),
      });
      await goto(`/workspaces/${created.id}`);
    } catch (caught) {
      registerError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      registering = false;
    }
  }
</script>

<section class="page">
  <header class="hero">
    <div>
      <p class="eyebrow">Spark daemon</p>
      <h1>{copy.title}</h1>
      <p>{copy.lede}</p>
    </div>
    <time datetime={data.observedAt}>{copy.observed} {formatTime(data.observedAt)}</time>
  </header>

  <section class="metrics" aria-label={copy.metrics}>
    <article><strong>{data.sessions.length}</strong><span>{copy.sessionsStat}</span></article>
    <article><strong>{activeInvocations.length}</strong><span>{copy.activeInvocationsStat}</span></article>
    <article><strong>{data.waits.length}</strong><span>{copy.waitsStat}</span></article>
    <article><strong>{data.artifactTotal}</strong><span>{copy.artifactsStat}</span></article>
  </section>

  <div class="primary-grid">
    <section class="panel sessions-panel">
      <header>
        <div><h2>{copy.sessionTreeTitle}</h2><p>{copy.sessionTreeLede}</p></div>
      </header>
      <SessionTree
        sessions={data.sessions}
        includeArchived={true}
        labels={data.messages.web.session.tree}
        hrefFor={(sessionId) => `/sessions/${encodeURIComponent(sessionId)}`}
      />
    </section>

    <section class="panel" id="invocations">
      <header><h2>{copy.activeInvocations}</h2><span>{activeInvocations.length} / {data.invocationTotal}</span></header>
      {#if activeInvocations.length === 0}
        <p class="empty">{copy.noActiveInvocations}</p>
      {:else}
        <ul class="records">
          {#each activeInvocations as invocation (invocation.invocationId)}
            <li>
              <a href={`/invocations/${encodeURIComponent(invocation.invocationId)}`}>
                <strong>{invocation.invocationId}</strong>
                <span class="status" data-status={invocation.status}>{statusLabel(invocation.status)}</span>
              </a>
              {#if invocation.sessionId}
                <a class="context-link" href={`/sessions/${encodeURIComponent(invocation.sessionId)}`}>{sessionLabel(invocation.sessionId)}</a>
              {:else}<span class="context-link">{copy.noSession}</span>{/if}
              <small>{copy.attempts}: {invocation.attemptCount} · {formatTime(invocation.updatedAt)}</small>
            </li>
          {/each}
        </ul>
      {/if}

      <h3>{copy.recentInvocations}</h3>
      {#if recentInvocations.length === 0}
        <p class="empty">{copy.noInvocations}</p>
      {:else}
        <ul class="records compact">
          {#each recentInvocations as invocation (invocation.invocationId)}
            <li>
              <a href={`/invocations/${encodeURIComponent(invocation.invocationId)}`}>
                <strong>{invocation.invocationId}</strong>
                <span class="status" data-status={invocation.status}>{statusLabel(invocation.status)}</span>
              </a>
              <small>{sessionLabel(invocation.sessionId)} · {formatTime(invocation.updatedAt)}</small>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <div class="secondary-grid">
    <section class="panel">
      <header><h2>{copy.waitsTitle}</h2><span>{data.waits.length}</span></header>
      {#if data.waits.length === 0}
        <p class="empty">{copy.noWaits}</p>
      {:else}
        <ul class="records">
          {#each data.waits as wait (wait.humanRequestId)}
            <li>
              <a href={`/sessions/${encodeURIComponent(wait.sessionId)}`}>
                <strong>{wait.title || wait.kind}</strong>
                <span class="status" data-status="waiting">{wait.mode ?? wait.kind}</span>
              </a>
              <p>{wait.prompt}</p>
              <small>{sessionLabel(wait.sessionId)} · {formatTime(wait.updatedAt)}</small>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="panel">
      <header><h2>{copy.artifactsTitle}</h2><span>{data.artifactTotal}</span></header>
      {#if data.artifacts.length === 0}
        <p class="empty">{copy.noArtifacts}</p>
      {:else}
        <ul class="records compact">
          {#each data.artifacts as artifact (`${artifact.workspaceId}:${artifact.ref}`)}
            <li>
              <a href={`/workspaces/${encodeURIComponent(artifact.workspaceId)}`}>
                <strong>{artifact.title}</strong><span class="status">{artifact.kind}</span>
              </a>
              <small>{workspaceLabel(artifact.workspaceId)} · {formatTime(artifact.updatedAt)}</small>
            </li>
          {/each}
        </ul>
      {/if}
      {#if data.artifactUnavailableWorkspaceIds.length > 0}
        <p class="warning">{copy.artifactsUnavailable}: {data.artifactUnavailableWorkspaceIds.length}</p>
      {/if}
    </section>
  </div>

  <details class="contexts">
    <summary>{copy.contextsTitle} · {data.workspaces.length}</summary>
    <p>{copy.contextsLede}</p>
    {#if data.workspaces.length === 0}
      <p>{copy.empty}</p>
    {:else}
      <ul class="workspace-list">
        {#each data.workspaces as workspace (workspace.id)}
          <li>
            <a href={`/workspaces/${encodeURIComponent(workspace.id)}`}><strong>{workspace.displayName}</strong><span>{workspace.localPath}</span></a>
            {#if data.cwdWorkspaceId === workspace.id}<small>{copy.currentDirectory}</small>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    <form class="register" onsubmit={(event) => void registerWorkspace(event)}>
      <h3>{copy.registerTitle}</h3>
      <p class="hint">{copy.registerHintBefore} <code>spark daemon login</code> {copy.registerHintAfter}</p>
      <label>{copy.localPath}<input type="text" autocomplete="off" bind:value={localPath} required /></label>
      <label>{copy.displayName}<input type="text" autocomplete="off" bind:value={displayName} placeholder={copy.optional} /></label>
      {#if registerError}<p class="error" role="alert">{registerError}</p>{/if}
      <button type="submit" disabled={registering}>{registering ? copy.registering : copy.register}</button>
    </form>
  </details>
</section>

<style>
  .page { display: grid; gap: 20px; padding: 24px; }
  .hero { align-items: end; display: flex; justify-content: space-between; gap: 24px; }
  .hero h1, .panel h2, .panel h3 { margin: 0; }
  .hero p:not(.eyebrow), .panel header p, .contexts > p { color: var(--color-ink-muted); margin: 4px 0 0; }
  .eyebrow { color: var(--color-primary); font-size: .75rem; font-weight: 700; letter-spacing: .08em; margin: 0 0 4px; text-transform: uppercase; }
  time { color: var(--color-ink-muted); font-size: .8rem; white-space: nowrap; }
  .metrics { display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .metrics article, .panel, .contexts { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; }
  .metrics article { display: grid; gap: 2px; padding: 14px 16px; }
  .metrics strong { font-size: 1.6rem; }
  .metrics span { color: var(--color-ink-muted); font-size: .85rem; }
  .primary-grid, .secondary-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); }
  .panel { display: grid; gap: 12px; min-width: 0; padding: 16px; }
  .panel > header { align-items: start; display: flex; justify-content: space-between; gap: 16px; }
  .panel > header span { color: var(--color-ink-muted); }
  .panel h3 { font-size: 1rem; margin-top: 6px; }
  .records, .workspace-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
  .records li { border-top: 1px solid var(--color-border); display: grid; gap: 4px; padding-top: 9px; }
  .records li:first-child { border-top: 0; padding-top: 0; }
  .records a { align-items: center; color: inherit; display: flex; justify-content: space-between; gap: 12px; text-decoration: none; }
  .records a:hover strong, .context-link:hover { color: var(--color-primary); }
  .records .context-link { color: var(--color-ink-muted); display: block; font-size: .85rem; }
  .records small, .workspace-list small, .empty { color: var(--color-ink-muted); }
  .records p { margin: 0; }
  .status { background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-ink-muted); font-size: .75rem; padding: 2px 7px; }
  .status[data-status="running"] { color: var(--color-primary); }
  .status[data-status="failed"], .error, .warning { color: var(--color-danger, #dc2626); }
  .contexts { padding: 14px 16px; }
  .contexts summary { cursor: pointer; font-weight: 650; }
  .workspace-list { margin-top: 14px; }
  .workspace-list li { align-items: center; display: flex; justify-content: space-between; gap: 16px; }
  .workspace-list a { color: inherit; display: grid; text-decoration: none; }
  .workspace-list a span { color: var(--color-ink-muted); font-size: .85rem; }
  .register { border-top: 1px solid var(--color-border); display: grid; gap: 10px; margin-top: 16px; max-width: 680px; padding-top: 16px; }
  .register h3, .register p { margin: 0; }
  .register label { display: grid; gap: 4px; }
  .register input { min-width: 0; width: 100%; }
  .register button { background: var(--color-primary); border: 0; border-radius: 8px; color: var(--color-on-primary); justify-self: start; padding: 8px 12px; }
  .hint { color: var(--color-ink-muted); font-size: .9rem; }
  @media (max-width: 860px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .primary-grid, .secondary-grid { grid-template-columns: 1fr; } .hero { align-items: start; flex-direction: column; } }
</style>
