<script lang="ts">
  import { ordinarySessionsForWorkspace, type SparkWebSession } from "$lib/daemon-surface";

  let { data } = $props();
  const sessions = $derived(data.sessions as SparkWebSession[]);
</script>

<section class="page">
  <header>
    <h1>Workspaces</h1>
    <p>Every workspace bound to this daemon.</p>
  </header>
  {#if data.workspaces.length === 0}
    <p>
      No workspaces on this daemon yet. Register one with
      <code>spark daemon workspace register</code>
      — cwd is not a web identity.
    </p>
  {:else}
    <ul>
      {#each data.workspaces as workspace (workspace.id)}
        {@const count = ordinarySessionsForWorkspace(sessions, workspace.id).length}
        <li>
          <a href="/workspaces/{workspace.id}">
            <strong>{workspace.displayName}</strong>
            <span>{workspace.localPath}</span>
          </a>
          <span class="meta">
            {count} session{count === 1 ? "" : "s"}
            {#if data.cwdWorkspaceId === workspace.id}· cwd{/if}
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
    gap: 16px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px 16px;
  }
  a {
    display: grid;
    gap: 4px;
    color: inherit;
    text-decoration: none;
    min-width: 0;
  }
  span {
    color: var(--color-ink-muted);
    font-size: 0.9rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    white-space: nowrap;
    align-self: center;
  }
  code {
    font-size: 0.9em;
  }
</style>
