<script lang="ts">
  import { goto } from "$app/navigation";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let creating = $state(false);

  async function createSession() {
    creating = true;
    try {
      const created = await webRpc("session.create", {
        scope: { kind: "workspace", workspaceId: data.workspaceId },
      });
      await goto(`/sessions/${created.sessionId}`);
    } finally {
      creating = false;
    }
  }
</script>

<section class="page">
  <header>
    <h1>Sessions</h1>
    <button type="button" onclick={() => void createSession()} disabled={creating}>
      {creating ? "Creating…" : "New session"}
    </button>
  </header>
  {#if data.sessions.length === 0}
    <p>No sessions yet. Create one to start a local daemon turn.</p>
  {:else}
    <ul>
      {#each data.sessions as session (session.sessionId)}
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
    align-items: center;
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
  button {
    background: var(--color-primary);
    color: var(--color-on-primary);
    border: 0;
    border-radius: 8px;
    padding: 8px 12px;
  }
</style>
