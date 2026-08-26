<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    Button,
    EmptyState,
    Field,
    Input,
    Notice,
    PageHeader,
    PageLayout,
    Panel,
    StatCard,
    StatusPill,
  } from "@zendev-lab/spark-ui";
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

{#snippet observedBadge()}
  <time datetime={data.observedAt}>{copy.observed} {formatTime(data.observedAt)}</time>
{/snippet}

<PageLayout width="full">
  <PageHeader eyebrow="Spark daemon" title={copy.title} lede={copy.lede} badge={observedBadge} />

  <section class="metrics" aria-label={copy.metrics}>
    <StatCard label={copy.sessionsStat} value={data.sessions.length} icon="message" tone="primary" />
    <StatCard label={copy.activeInvocationsStat} value={activeInvocations.length} icon="activity" tone={activeInvocations.length > 0 ? "success" : "default"} />
    <StatCard label={copy.waitsStat} value={data.waits.length} icon="inbox" tone={data.waits.length > 0 ? "warning" : "default"} />
    <StatCard label={copy.artifactsStat} value={data.artifactTotal} icon="artifacts" tone="purple" />
  </section>

  <div class="primary-grid">
    <Panel class="sessions-panel" title={copy.sessionTreeTitle} note={copy.sessionTreeLede} compact>
      <SessionTree
        sessions={data.sessions}
        includeArchived={true}
        labels={data.messages.web.session.tree}
        hrefFor={(sessionId) => `/sessions/${encodeURIComponent(sessionId)}`}
      />
    </Panel>

    <Panel title={copy.activeInvocations} badge={`${activeInvocations.length} / ${data.invocationTotal}`} id="invocations" compact>
      {#if activeInvocations.length === 0}
        <EmptyState compact icon="activity" title={copy.noActiveInvocations} />
      {:else}
        <ul class="records">
          {#each activeInvocations as invocation (invocation.invocationId)}
            <li>
              <a href={`/invocations/${encodeURIComponent(invocation.invocationId)}`}>
                <strong>{invocation.invocationId}</strong>
                <StatusPill label={statusLabel(invocation.status)} status={invocation.status} />
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
                <StatusPill label={statusLabel(invocation.status)} status={invocation.status} />
              </a>
              <small>{sessionLabel(invocation.sessionId)} · {formatTime(invocation.updatedAt)}</small>
            </li>
          {/each}
        </ul>
      {/if}
    </Panel>
  </div>

  <div class="secondary-grid">
    <Panel title={copy.waitsTitle} badge={String(data.waits.length)} compact>
      {#if data.waits.length === 0}
        <EmptyState compact icon="inbox" title={copy.noWaits} />
      {:else}
        <ul class="records">
          {#each data.waits as wait (wait.humanRequestId)}
            <li>
              <a href={`/sessions/${encodeURIComponent(wait.sessionId)}`}>
                <strong>{wait.title || wait.kind}</strong>
                <StatusPill label={wait.mode ?? wait.kind} tone="warning" />
              </a>
              <p>{wait.prompt}</p>
              <small>{sessionLabel(wait.sessionId)} · {formatTime(wait.updatedAt)}</small>
            </li>
          {/each}
        </ul>
      {/if}
    </Panel>

    <Panel title={copy.artifactsTitle} badge={String(data.artifactTotal)} compact>
      {#if data.artifacts.length === 0}
        <EmptyState compact icon="artifacts" title={copy.noArtifacts} />
      {:else}
        <ul class="records compact">
          {#each data.artifacts as artifact (`${artifact.workspaceId}:${artifact.ref}`)}
            <li>
              <a href={`/workspaces/${encodeURIComponent(artifact.workspaceId)}`}>
                <strong>{artifact.title}</strong><StatusPill label={artifact.kind} />
              </a>
              <small>{workspaceLabel(artifact.workspaceId)} · {formatTime(artifact.updatedAt)}</small>
            </li>
          {/each}
        </ul>
      {/if}
      {#if data.artifactUnavailableWorkspaceIds.length > 0}
        <Notice tone="warning" message={`${copy.artifactsUnavailable}: ${data.artifactUnavailableWorkspaceIds.length}`} />
      {/if}
    </Panel>
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
      <Field id="workspace-local-path" label={copy.localPath} required reserveMeta={false}>
        <Input id="workspace-local-path" type="text" autocomplete="off" bind:value={localPath} required />
      </Field>
      <Field id="workspace-display-name" label={copy.displayName} reserveMeta={false}>
        <Input id="workspace-display-name" type="text" autocomplete="off" bind:value={displayName} placeholder={copy.optional} />
      </Field>
      {#if registerError}<Notice tone="danger" message={registerError} />{/if}
      <Button type="submit" loading={registering}>{registering ? copy.registering : copy.register}</Button>
    </form>
  </details>
</PageLayout>

<style>
  time { color: var(--color-ink-muted); font-size: .8rem; white-space: nowrap; }
  .metrics { display: grid; gap: var(--spacing-md); grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .primary-grid, .secondary-grid { align-items: start; display: grid; gap: var(--spacing-md); grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); }
  h3 { font-size: var(--text-card-title); margin: var(--spacing-xs) 0 0; }
  .records, .workspace-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
  .records li { border-top: 1px solid var(--color-border); display: grid; gap: 4px; padding-top: 9px; }
  .records li:first-child { border-top: 0; padding-top: 0; }
  .records a { align-items: center; color: inherit; display: flex; justify-content: space-between; gap: 12px; text-decoration: none; }
  .records a:hover strong, .context-link:hover { color: var(--color-primary); }
  .records .context-link { color: var(--color-ink-muted); display: block; font-size: .85rem; }
  .records small, .workspace-list small, .empty { color: var(--color-ink-muted); }
  .records p { margin: 0; }
  .contexts { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--rounded-lg); box-shadow: var(--shadow-card); padding: var(--spacing-md) var(--spacing-lg); }
  .contexts summary { cursor: pointer; font-weight: 650; }
  .workspace-list { margin-top: 14px; }
  .workspace-list li { align-items: center; display: flex; justify-content: space-between; gap: 16px; }
  .workspace-list a { color: inherit; display: grid; text-decoration: none; }
  .workspace-list a span { color: var(--color-ink-muted); font-size: .85rem; }
  .register { border-top: 1px solid var(--color-border); display: grid; gap: 10px; margin-top: 16px; max-width: 680px; padding-top: 16px; }
  .register h3, .register p { margin: 0; }
  .register > :global(.ui-button) { justify-self: start; }
  .hint { color: var(--color-ink-muted); font-size: .9rem; }
  @media (max-width: 860px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .primary-grid, .secondary-grid { grid-template-columns: 1fr; } }
</style>
