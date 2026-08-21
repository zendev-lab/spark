<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import type { SparkModelCatalogProvider } from "@zendev-lab/spark-protocol";
  import {
    oauthHref,
    providerAuthKindLabel,
    providerAuthStatusLabel,
  } from "$lib/provider-auth";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let keyByProvider = $state<Record<string, string>>({});
  let status = $state("");
  let errorText = $state("");
  let busy = $state("");
  let importPath = $state("");
  let importOverwrite = $state(false);

  async function refresh(message: string) {
    status = message;
    errorText = "";
    await invalidateAll();
  }

  async function saveKey(providerName: string) {
    const apiKey = keyByProvider[providerName]?.trim();
    if (!apiKey) return;
    busy = `key:${providerName}`;
    errorText = "";
    try {
      await webRpc("provider.auth.api-key.set", { providerName, apiKey });
      keyByProvider[providerName] = "";
      await refresh(`Saved ${providerName} API key.`);
    } catch (caught) {
      errorText = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy = "";
    }
  }

  async function logout(providerName: string) {
    busy = `logout:${providerName}`;
    errorText = "";
    try {
      await webRpc("provider.auth.logout", { providerName });
      await refresh(`Signed out ${providerName}.`);
    } catch (caught) {
      errorText = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy = "";
    }
  }

  async function importPi() {
    const sourcePath = importPath.trim();
    if (!sourcePath) return;
    busy = "import";
    errorText = "";
    try {
      const report = await webRpc("provider.auth.import.pi", {
        sourcePath,
        overwrite: importOverwrite,
      });
      await refresh(
        `Imported ${report.totals.imported}, overwritten ${report.totals.overwritten}, skipped ${report.totals.skipped}.`,
      );
    } catch (caught) {
      errorText = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy = "";
    }
  }

  function configuredSource(provider: SparkModelCatalogProvider): string {
    if (!provider.auth.configured) return "";
    if (provider.auth.source === "environment") return "from environment";
    if (provider.auth.source === "literal") return "literal";
    return "stored";
  }
</script>

<section class="page">
  <header>
    <p class="crumb"><a href="/">Workspaces</a></p>
    <h1>Providers</h1>
    <p>
      Credentials stay in the daemon auth store. API-key providers can be saved here. OAuth
      providers use a dedicated login page. Spark web never echoes a stored secret.
    </p>
  </header>
  {#if status}<p class="status">{status}</p>{/if}
  {#if errorText}<p class="error">{errorText}</p>{/if}
  <ul>
    {#each data.catalog.providers as provider (provider.providerName)}
      <li>
        <div class="heading">
          <div>
            <h2>{provider.label}</h2>
            <p>
              {providerAuthKindLabel(provider.auth.kind)}
              {#if provider.auth.reference}· {provider.auth.reference}{/if}
              {#if configuredSource(provider)}· {configuredSource(provider)}{/if}
            </p>
          </div>
          <span class:configured={provider.auth.configured} class:neutral={provider.auth.kind === "none"} class="badge">
            {providerAuthStatusLabel(provider)}
          </span>
        </div>

        {#if provider.auth.kind === "api_key"}
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
                placeholder={provider.auth.configured ? "Replace stored key" : "Paste API key"}
                bind:value={keyByProvider[provider.providerName]}
              />
            </label>
            <button type="submit" disabled={busy === `key:${provider.providerName}`}>
              {busy === `key:${provider.providerName}` ? "Saving…" : "Save"}
            </button>
          </form>
          {#if provider.auth.configured && provider.auth.source === "stored"}
            <button
              type="button"
              class="secondary"
              disabled={busy === `logout:${provider.providerName}`}
              onclick={() => void logout(provider.providerName)}
            >
              {busy === `logout:${provider.providerName}` ? "Signing out…" : "Sign out"}
            </button>
          {/if}
        {:else if provider.auth.kind === "oauth"}
          <div class="actions">
            <a class="button" href={oauthHref(provider.providerName)}>
              {provider.auth.configured ? "Re-authenticate" : "Sign in with OAuth"}
            </a>
            {#if provider.auth.configured}
              <button
                type="button"
                class="secondary"
                disabled={busy === `logout:${provider.providerName}`}
                onclick={() => void logout(provider.providerName)}
              >
                {busy === `logout:${provider.providerName}` ? "Signing out…" : "Sign out"}
              </button>
            {/if}
          </div>
        {:else}
          <p class="muted">This provider does not need a credential.</p>
        {/if}
      </li>
    {/each}
  </ul>

  <section class="import">
    <h2>Import from Pi</h2>
    <p>Copy supported API keys and OAuth records from a Pi `auth.json` into Spark's store.</p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void importPi();
      }}
    >
      <label>
        Source path
        <input type="text" placeholder="~/.pi/agent/auth.json" bind:value={importPath} />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={importOverwrite} />
        Overwrite existing Spark credentials
      </label>
      <button type="submit" disabled={busy === "import"}>
        {busy === "import" ? "Importing…" : "Import"}
      </button>
    </form>
  </section>
</section>

<style>
  .page {
    padding: 24px;
    display: grid;
    gap: 16px;
    max-width: 880px;
  }
  .crumb {
    margin: 0;
    color: var(--color-ink-muted);
  }
  .crumb a {
    color: inherit;
  }
  header p,
  .muted {
    color: var(--color-ink-muted);
    margin: 0;
  }
  h1,
  h2 {
    margin: 0;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 16px;
  }
  li,
  .import {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 16px;
    display: grid;
    gap: 12px;
  }
  .heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
  }
  .heading p {
    margin: 4px 0 0;
    color: var(--color-ink-muted);
  }
  .badge {
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: 12px;
    padding: 4px 8px;
    color: var(--color-ink-muted);
    white-space: nowrap;
  }
  .badge.configured {
    color: var(--color-success-strong, #15803d);
    border-color: var(--color-success-soft, #86efac);
  }
  .badge.neutral {
    color: var(--color-ink-muted);
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: end;
    margin: 0;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 13px;
  }
  input[type="password"],
  input[type="text"] {
    display: block;
    min-width: 240px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button,
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: var(--color-ink);
    color: var(--color-canvas);
    text-decoration: none;
    cursor: pointer;
  }
  .secondary {
    background: transparent;
    color: inherit;
  }
  .status {
    color: var(--color-success-strong, #15803d);
    margin: 0;
  }
  .error {
    color: var(--color-danger, #b91c1c);
    margin: 0;
  }
</style>
