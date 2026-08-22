<script lang="ts">
  import { onMount } from "svelte";
  import type {
    SparkModelControlSnapshot,
    SparkModelRef,
  } from "@zendev-lab/spark-protocol";
  import { oauthHref } from "$lib/provider-auth";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let copy = $derived(data.messages.web.settings);
  let catalogOverride = $state<SparkModelControlSnapshot | null>(null);
  let catalog = $derived(catalogOverride ?? data.catalog);
  let daemonOverride = $state<typeof data.daemon | null>(null);
  let daemon = $derived(daemonOverride ?? data.daemon);
  let keyByProvider = $state<Record<string, string>>({});
  let enabledValues = $state<string[]>([]);
  let defaultValue = $state("");
  let modelPolicyInitialized = $state(false);
  let piSourcePath = $state("");
  let piOverwrite = $state(false);
  let busy = $state("");
  let status = $state<{ tone: "status" | "error"; message: string } | null>(null);
  let notificationPermission = $state<NotificationPermission | "unsupported">("unsupported");

  onMount(() => {
    notificationPermission = "Notification" in globalThis ? Notification.permission : "unsupported";
  });

  const allModels = $derived(catalog.providers.flatMap((provider) => provider.models));

  $effect(() => {
    if (modelPolicyInitialized) return;
    enabledValues = catalog.enabledModels?.map(modelValue) ?? [];
    defaultValue = catalog.defaultModel ? modelValue(catalog.defaultModel) : "";
    modelPolicyInitialized = true;
  });

  function modelValue(model: SparkModelRef) {
    return `${model.providerName}/${model.modelId}`;
  }

  function modelForValue(value: string): SparkModelRef | undefined {
    return allModels.find((entry) => modelValue(entry.model) === value)?.model;
  }

  async function run(label: string, operation: () => Promise<string | void>) {
    if (busy) return;
    busy = label;
    status = null;
    try {
      const message = await operation();
      status = { tone: "status", message: message ?? `${label} completed.` };
    } catch (error) {
      status = { tone: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      busy = "";
    }
  }

  async function saveKey(providerName: string) {
    const apiKey = keyByProvider[providerName]?.trim();
    if (!apiKey) return;
    await run(`Save ${providerName}`, async () => {
      catalogOverride = await webRpc("provider.auth.api-key.set", { providerName, apiKey });
      keyByProvider[providerName] = "";
      return `Saved ${providerName} API key. The secret was not returned to the browser.`;
    });
  }

  async function logout(providerName: string) {
    await run(`Logout ${providerName}`, async () => {
      const result = await webRpc("provider.auth.logout", { providerName });
      catalogOverride = result.snapshot;
      return result.removed ? `Logged out ${providerName}.` : `${providerName} had no stored credential.`;
    });
  }

  async function saveDefaultModel() {
    const model = modelForValue(defaultValue);
    if (!model) return;
    await run("Default model", async () => {
      catalogOverride = await webRpc("model.default.set", { model });
      return `Default model set to ${modelValue(model)}.`;
    });
  }

  async function saveEnabledModels() {
    const models = enabledValues.flatMap((value) => {
      const model = modelForValue(value);
      return model ? [model] : [];
    });
    await run("Enabled models", async () => {
      catalogOverride = await webRpc("model.enabled.set", {
        models,
        intent: { kind: "user-initiated", via: "settings-ui" },
      });
      return `Saved ${models.length} enabled model${models.length === 1 ? "" : "s"}.`;
    });
  }

  async function importPiAuth() {
    const sourcePath = piSourcePath.trim();
    if (!sourcePath) return;
    await run("Pi import", async () => {
      const report = await webRpc("provider.auth.import.pi", { sourcePath, overwrite: piOverwrite });
      catalogOverride = await webRpc("model.catalog", {});
      return `Pi import: ${report.totals.imported} imported, ${report.totals.overwritten} overwritten, ${report.totals.skipped} skipped.`;
    });
  }

  async function refreshDaemon() {
    await run("Daemon status", async () => {
      daemonOverride = await webRpc("daemon.status", {});
      return `Daemon is ${daemonOverride.lifecycle.state}.`;
    });
  }

  async function restartDaemon() {
    if (typeof globalThis.confirm === "function" && !globalThis.confirm(copy.restartConfirm)) return;
    await run("Daemon restart", async () => {
      const result = await webRpc("daemon.restart", {});
      return `Daemon restart ${result.restartId} accepted; active work is draining.`;
    });
  }

  async function enableNotifications() {
    if (!("Notification" in globalThis)) return;
    notificationPermission = await Notification.requestPermission();
  }
</script>

<section class="page">
  <header>
    <h1>{copy.title}</h1>
    <p>{copy.lede}</p>
  </header>
  {#if status}
    <p class:error={status.tone === "error"} class="status" role={status.tone === "error" ? "alert" : "status"}>{status.message}</p>
  {/if}

  <section class="settings-card" aria-labelledby="model-policy-heading">
    <h2 id="model-policy-heading">{copy.modelPolicy}</h2>
    <label>{copy.defaultModel}
      <select bind:value={defaultValue}>
        <option value="">{copy.chooseDefault}</option>
        {#each allModels as entry (modelValue(entry.model))}
          <option value={modelValue(entry.model)} disabled={!entry.available}>{entry.model.modelLabel ?? entry.model.modelId} · {entry.model.providerLabel ?? entry.model.providerName}</option>
        {/each}
      </select>
    </label>
    <button type="button" disabled={!defaultValue || Boolean(busy)} onclick={() => void saveDefaultModel()}>{copy.saveDefault}</button>
    <fieldset>
      <legend>{copy.enabledModels}</legend>
      <div class="model-grid">
        {#each allModels as entry (modelValue(entry.model))}
          <label class="checkbox"><input type="checkbox" bind:group={enabledValues} value={modelValue(entry.model)} disabled={!entry.available} /><span>{entry.model.modelLabel ?? entry.model.modelId}<small>{entry.model.providerLabel ?? entry.model.providerName}</small></span></label>
        {/each}
      </div>
    </fieldset>
    <button type="button" disabled={Boolean(busy)} onclick={() => void saveEnabledModels()}>{copy.saveEnabledModels}</button>
    {#if catalog.diagnostics.length > 0}<ul class="diagnostics">{#each catalog.diagnostics as diagnostic}<li>{diagnostic}</li>{/each}</ul>{/if}
  </section>

  <section aria-labelledby="providers-heading">
    <h2 id="providers-heading">{copy.providers}</h2>
    <div class="provider-grid">
      {#each catalog.providers as provider (provider.providerName)}
        <article>
          <header><div><h3>{provider.label}</h3><code>{provider.providerName}</code></div><span>{provider.auth.configured ? copy.configured : copy.notConfigured}</span></header>
          {#if provider.auth.reference}<p>{copy.source}: {provider.auth.reference}</p>{/if}
          {#if provider.auth.kind === "api_key"}
            <form onsubmit={(event) => { event.preventDefault(); void saveKey(provider.providerName); }}>
              <label>{copy.apiKey}<input type="password" autocomplete="new-password" bind:value={keyByProvider[provider.providerName]} /></label>
              <button type="submit" disabled={Boolean(busy)}>{copy.saveKey}</button>
            </form>
          {:else if provider.auth.kind === "oauth"}
            <a class="button" href={oauthHref(provider.providerName)}>{copy.startOAuth}</a>
          {/if}
          {#if provider.auth.configured}<button type="button" class="secondary danger" disabled={Boolean(busy)} onclick={() => void logout(provider.providerName)}>{copy.logout}</button>{/if}
        </article>
      {/each}
    </div>
  </section>

  <section class="settings-card" aria-labelledby="pi-import-heading">
    <h2 id="pi-import-heading">{copy.importPi}</h2>
    <p>{copy.importPiHint}</p>
    <form onsubmit={(event) => { event.preventDefault(); void importPiAuth(); }}>
      <label>{copy.sourcePath}<input type="text" autocomplete="off" bind:value={piSourcePath} required /></label>
      <label class="checkbox"><input type="checkbox" bind:checked={piOverwrite} />{copy.overwriteCredentials}</label>
      <button type="submit" disabled={Boolean(busy)}>{copy.import}</button>
    </form>
  </section>

  <section class="settings-card" aria-labelledby="daemon-heading">
    <h2 id="daemon-heading">{copy.daemon}</h2>
    <dl><div><dt>{copy.lifecycle}</dt><dd>{daemon.lifecycle.state}</dd></div><div><dt>{copy.build}</dt><dd>{daemon.buildFingerprint ?? copy.unavailable}</dd></div><div><dt>{copy.invocations}</dt><dd>{daemon.invocations.running} {copy.running} · {daemon.invocations.queued} {copy.queued} · {daemon.invocations.failed} {copy.failed}</dd></div><div><dt>{copy.observed}</dt><dd>{daemon.observedAt}</dd></div></dl>
    <div class="row"><button type="button" class="secondary" disabled={Boolean(busy)} onclick={() => void refreshDaemon()}>{copy.refresh}</button><button type="button" class="danger" disabled={Boolean(busy)} onclick={() => void restartDaemon()}>{copy.restart}</button></div>
  </section>

  <section class="settings-card" aria-labelledby="notification-heading">
    <h2 id="notification-heading">{copy.notifications}</h2>
    <p>{copy.notificationsHint}</p>
    <div class="row"><button type="button" class="secondary" disabled={notificationPermission === "unsupported" || notificationPermission === "granted"} onclick={() => void enableNotifications()}>{notificationPermission === "granted" ? copy.notificationsEnabled : notificationPermission === "unsupported" ? copy.notificationsUnavailable : copy.enableNotifications}</button><span>{notificationPermission}</span></div>
  </section>
</section>

<style>
  .page { display: grid; gap: 20px; margin: 0 auto; max-width: 1120px; padding: 24px; }
  h1, h2, h3, p { margin: 0; }
  .page > header, .settings-card, article, form, label { display: grid; gap: 8px; }
  .page > header p, article p, .settings-card > p { color: var(--color-ink-muted); }
  .settings-card, article { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; padding: 16px; }
  .provider-grid, .model-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); }
  article > header { align-items: start; display: flex; justify-content: space-between; }
  article > header div { display: grid; gap: 3px; }
  article > header span { color: var(--color-ink-muted); font-size: 12px; }
  input, select { background: var(--color-canvas); border: 1px solid var(--color-border); border-radius: 7px; box-sizing: border-box; color: var(--color-ink); min-width: 0; padding: 8px; width: 100%; }
  button, .button { background: var(--color-primary); border: 1px solid transparent; border-radius: 8px; color: var(--color-on-primary); cursor: pointer; justify-self: start; padding: 8px 12px; text-decoration: none; }
  button.secondary { background: transparent; border-color: var(--color-border); color: var(--color-ink); }
  button.danger { background: var(--color-danger); color: white; }
  button.secondary.danger { background: transparent; border-color: var(--color-danger); color: var(--color-danger); }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { box-shadow: var(--shadow-focus); outline: none; }
  .checkbox { align-items: start; display: grid; grid-template-columns: auto minmax(0, 1fr); }
  .checkbox input { margin-top: 2px; width: auto; }
  .checkbox span { display: grid; }
  .checkbox small { color: var(--color-ink-muted); }
  fieldset { border: 0; margin: 0; padding: 0; }
  legend { font-weight: 650; margin-bottom: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .status { background: var(--color-success-soft); border-radius: 8px; color: var(--color-success-strong); padding: 10px; }
  .status.error, .error { background: var(--color-danger-soft); color: var(--color-danger-strong); }
  .diagnostics { color: var(--color-warning-strong); }
  dl { display: grid; gap: 5px; margin: 0; }
  dl div { display: grid; gap: 8px; grid-template-columns: 110px minmax(0, 1fr); }
  dt { color: var(--color-ink-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 640px) { .page { padding: 14px; } .provider-grid, .model-grid { grid-template-columns: 1fr; } }
</style>
