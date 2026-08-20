<script lang="ts">
  import "@zendev-lab/spark-ui/tokens.css";

  let { children } = $props();
</script>

<svelte:head>
  <title>Spark</title>
</svelte:head>

<div class="shell">
  <header class="top">
    <a href="/" class="brand">Spark</a>
    <nav>
      <a href="/">Workspaces</a>
      <a href="/sessions">Sessions</a>
      <a href="/settings">Settings</a>
    </nav>
  </header>
  <main>{@render children()}</main>
</div>

<style>
  :global(body) {
    margin: 0;
    background: var(--color-canvas);
    color: var(--color-ink);
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .shell {
    min-height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  .brand {
    font-weight: 650;
    color: inherit;
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 16px;
  }
  nav a {
    color: var(--color-ink-muted);
    text-decoration: none;
  }
  main {
    min-height: 0;
  }
</style>
