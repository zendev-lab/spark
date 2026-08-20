<script lang="ts">
  import {
    ordinaryDaemonSessions,
    sessionWorkspaceId,
    type SparkWebSession,
  } from "$lib/daemon-surface";

  let { data } = $props();
  const sessions = $derived(ordinaryDaemonSessions(data.sessions as SparkWebSession[]));
  function workspaceLabel(workspaceId: string | null): string {
    if (!workspaceId) return "daemon";
    return data.workspaces.find((workspace) => workspace.id === workspaceId)?.displayName ?? workspaceId;
  }

</script>

<section class="page">
  <header>
    <h1>Sessions</h1>
    <p>Ordinary sessions on this daemon.</p>
  </header>
  {#if sessions.length === 0}
    <p>No sessions yet. Open a workspace to create one.</p>
  {:else}
    <ul>
      {#each sessions as session (session.sessionId)}
        <li>
          <a href="/sessions/{session.sessionId}">{session.name ?? session.sessionId}</a>
          <span>
            {#if sessionWorkspaceId(session)}
              <a href="/workspaces/{sessionWorkspaceId(session)}">{workspaceLabel(sessionWorkspaceId(session))}</a>
            {:else}
              daemon
            {/if}
            · {session.activity}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .page {
    padding: 24px;
    display: grid;
    gap: 16px;
  }
  header p {
    margin: 4px 0 0;
    color: var(--color-ink-muted);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
  }
  li {
    display: flex;
    justify-content: space-between;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px 16px;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  span,
  span a {
    color: var(--color-ink-muted);
  }
</style>
