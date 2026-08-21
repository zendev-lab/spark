<script lang="ts">
  import { goto } from "$app/navigation";
  import { ordinarySessionsForWorkspace, type SparkWebSession } from "$lib/daemon-surface";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  const sessions = $derived(data.sessions as SparkWebSession[]);
  let localPath = $state("");
  let displayName = $state("");
  let registering = $state(false);
  let registerError = $state("");

  $effect(() => {
    if (!localPath) localPath = data.launchCwd;
  });

  async function registerWorkspace(event: SubmitEvent) {
    event.preventDefault();
    const path = localPath.trim();
    if (!path) {
      registerError = "Local path is required.";
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
  <header>
    <h1>Workspaces</h1>
    <p>Every workspace bound to this daemon.</p>
  </header>
  {#if data.workspaces.length === 0}
    <p>No workspaces on this daemon yet. Register a local directory below.</p>
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
  <form class="register" onsubmit={(event) => void registerWorkspace(event)}>
    <h2>Register a local workspace</h2>
    <p class="hint">
      Binds a directory to this daemon. Hub origin stays on
      <code>spark daemon login</code>
      — this form does not send a server URL or token.
    </p>
    <label>
      Local path
      <input type="text" autocomplete="off" bind:value={localPath} required />
    </label>
    <label>
      Display name
      <input type="text" autocomplete="off" bind:value={displayName} placeholder="optional" />
    </label>
    {#if registerError}
      <p class="error">{registerError}</p>
    {/if}
    <button type="submit" disabled={registering}>
      {registering ? "Registering…" : "Register"}
    </button>
  </form>
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
  form.register {
    display: grid;
    gap: 12px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 16px;
    max-width: 640px;
  }
  form.register h2 {
    margin: 0;
    font-size: 1rem;
  }
  .hint {
    margin: 0;
    color: var(--color-ink-muted);
    font-size: 0.9rem;
  }
  form.register label {
    display: grid;
    gap: 4px;
  }
  form.register input {
    min-width: 0;
    width: 100%;
  }
  form.register button {
    background: var(--color-primary);
    color: var(--color-on-primary);
    border: 0;
    border-radius: 8px;
    padding: 8px 12px;
    justify-self: start;
  }
  .error {
    color: var(--color-danger, #f87171);
    margin: 0;
  }
</style>
