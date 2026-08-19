<script lang="ts">
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let keyByProvider = $state<Record<string, string>>({});
  let status = $state("");

  async function saveKey(providerName: string) {
    const apiKey = keyByProvider[providerName]?.trim();
    if (!apiKey) return;
    await webRpc("provider.auth.api-key.set", { providerName, apiKey });
    status = `Saved ${providerName} API key.`;
    keyByProvider[providerName] = "";
  }
</script>

<section class="page">
  <h1>Providers</h1>
  <p>API keys stay in the daemon auth store. Spark web never echoes a stored secret.</p>
  {#if status}<p class="status">{status}</p>{/if}
  <ul>
    {#each data.catalog.providers as provider (provider.providerName)}
      <li>
        <h2>{provider.label}</h2>
        <p>
          {provider.auth.configured ? "Configured" : "Not configured"}
          {#if provider.auth.reference}· {provider.auth.reference}{/if}
        </p>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void saveKey(provider.providerName);
          }}
        >
          <label>
            API key
            <input
              type="password"
              autocomplete="off"
              bind:value={keyByProvider[provider.providerName]}
            />
          </label>
          <button type="submit">Save</button>
        </form>
      </li>
    {/each}
  </ul>
</section>

<style>
  .page {
    padding: 24px;
    display: grid;
    gap: 16px;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 16px;
  }
  li {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 16px;
    display: grid;
    gap: 8px;
  }
  form {
    display: flex;
    gap: 8px;
    align-items: end;
  }
  input {
    display: block;
    min-width: 240px;
  }
</style>
