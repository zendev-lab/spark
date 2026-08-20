<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    ordinarySessionsForWorkspace,
    workspaceAdministratorSessionId,
    type SparkWebSession,
  } from "$lib/daemon-surface";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let creating = $state(false);
  let createError = $state("");
  const sessions = $derived(
    ordinarySessionsForWorkspace(data.sessions as SparkWebSession[], data.workspace.id),
  );

  async function createSession() {
    const supervisorSessionId = workspaceAdministratorSessionId(
      data.sessions as SparkWebSession[],
      data.workspace.id,
    );
    if (!supervisorSessionId) {
      createError = "Workspace administrator session is missing on this daemon.";
      return;
    }
    creating = true;
    createError = "";
    try {
      const created = await webRpc("session.create", {
        scope: { kind: "workspace", workspaceId: data.workspace.id },
        supervisorSessionId,
        placement: "child",
      });
      await goto(`/sessions/${created.sessionId}`);
    } catch (caught) {
      createError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      creating = false;
    }
  }
</script>

<section class="page">
  <header>
    <div>
      <p class="crumb"><a href="/">Workspaces</a></p>
      <h1>{data.workspace.displayName}</h1>
      <p>{data.workspace.localPath}</p>
    </div>
    <button type="button" onclick={() => void createSession()} disabled={creating}>
      {creating ? "Creating…" : "New session"}
    </button>
  </header>
  {#if createError}
    <p class="error">{createError}</p>
  {/if}
  {#if sessions.length === 0}
    <p>No sessions in this workspace yet.</p>
  {:else}
    <ul>
      {#each sessions as session (session.sessionId)}
        <li>
          <a href="/sessions/{session.sessionId}">{session.name ?? session.sessionId}</a>
          <span>{session.activity}</span>
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
  header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 16px;
  }
  .crumb {
    margin: 0 0 8px;
    font-size: 0.85rem;
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
  button {
    background: var(--color-primary);
    color: var(--color-on-primary);
    border: 0;
    border-radius: 8px;
    padding: 8px 12px;
  }
  .error {
    color: var(--color-danger, #f87171);
  }
</style>
