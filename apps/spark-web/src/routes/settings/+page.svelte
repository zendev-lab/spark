<script lang="ts">
  import { onMount } from "svelte";
  import type {
    SparkModelControlSnapshot,
    SparkModelRef,
  } from "@zendev-lab/spark-protocol";
  import {
    Button,
    Checkbox,
    ConfirmDialog,
    Field,
    Input,
    Notice,
    PageHeader,
    PageLayout,
    Panel,
    Select,
    StatusPill,
    type SelectGroup,
  } from "@zendev-lab/spark-ui";
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
  let restartOpen = $state(false);

  onMount(() => {
    notificationPermission = "Notification" in globalThis ? Notification.permission : "unsupported";
  });

  const allModels = $derived(catalog.providers.flatMap((provider) => provider.models));
  let modelGroups = $derived<SelectGroup[]>([
    {
      id: "models",
      options: [
        { value: "", label: copy.chooseDefault },
        ...allModels.map((entry) => ({
          value: modelValue(entry.model),
          label: `${entry.model.modelLabel ?? entry.model.modelId} · ${entry.model.providerLabel ?? entry.model.providerName}`,
          disabled: !entry.available,
        })),
      ],
    },
  ]);

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
    await run("Daemon restart", async () => {
      const result = await webRpc("daemon.restart", {});
      restartOpen = false;
      return `Daemon restart ${result.restartId} accepted; active work is draining.`;
    });
  }

  function toggleEnabledModel(value: string, checked: boolean) {
    enabledValues = checked
      ? [...enabledValues, value]
      : enabledValues.filter((candidate) => candidate !== value);
  }

  async function enableNotifications() {
    if (!("Notification" in globalThis)) return;
    notificationPermission = await Notification.requestPermission();
  }
</script>

<PageLayout width="content">
  <PageHeader title={copy.title} lede={copy.lede} />
  {#if status}
    <Notice tone={status.tone === "error" ? "danger" : "success"} message={status.message} />
  {/if}

  <Panel title={copy.modelPolicy} id="model-policy-heading">
    <div class="policy-row">
      <Field id="default-model" label={copy.defaultModel} reserveMeta={false}>
        <Select id="default-model" bind:value={defaultValue} groups={modelGroups} label={copy.defaultModel} />
      </Field>
      <Button disabled={!defaultValue || Boolean(busy)} onclick={() => void saveDefaultModel()}>{copy.saveDefault}</Button>
    </div>
    <fieldset>
      <legend>{copy.enabledModels}</legend>
      <div class="model-grid">
        {#each allModels as entry (modelValue(entry.model))}
          {@const value = modelValue(entry.model)}
          <Checkbox
            id={`enabled-model-${value.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`}
            label={entry.model.modelLabel ?? entry.model.modelId}
            description={entry.model.providerLabel ?? entry.model.providerName}
            checked={enabledValues.includes(value)}
            disabled={!entry.available}
            onchange={(event) => toggleEnabledModel(value, event.currentTarget.checked)}
          />
        {/each}
      </div>
    </fieldset>
    <Button class="panel-action" disabled={Boolean(busy)} onclick={() => void saveEnabledModels()}>{copy.saveEnabledModels}</Button>
    {#if catalog.diagnostics.length > 0}<ul class="diagnostics">{#each catalog.diagnostics as diagnostic}<li>{diagnostic}</li>{/each}</ul>{/if}
  </Panel>

  <Panel title={copy.providers} id="providers-heading">
    <div class="provider-grid">
      {#each catalog.providers as provider (provider.providerName)}
        <article>
          <header><div><h3>{provider.label}</h3><code>{provider.providerName}</code></div><StatusPill label={provider.auth.configured ? copy.configured : copy.notConfigured} tone={provider.auth.configured ? "success" : "neutral"} /></header>
          {#if provider.auth.reference}<p>{copy.source}: {provider.auth.reference}</p>{/if}
          {#if provider.auth.kind === "api_key"}
            <form onsubmit={(event) => { event.preventDefault(); void saveKey(provider.providerName); }}>
              <Field id={`api-key-${provider.providerName}`} label={copy.apiKey} reserveMeta={false}>
                <Input id={`api-key-${provider.providerName}`} type="password" autocomplete="new-password" bind:value={keyByProvider[provider.providerName]} />
              </Field>
              <Button type="submit" disabled={Boolean(busy)}>{copy.saveKey}</Button>
            </form>
          {:else if provider.auth.kind === "oauth"}
            <Button href={oauthHref(provider.providerName)}>{copy.startOAuth}</Button>
          {/if}
          {#if provider.auth.configured}<Button variant="danger" disabled={Boolean(busy)} onclick={() => void logout(provider.providerName)}>{copy.logout}</Button>{/if}
        </article>
      {/each}
    </div>
  </Panel>

  <Panel title={copy.importPi} note={copy.importPiHint} id="pi-import-heading">
    <form onsubmit={(event) => { event.preventDefault(); void importPiAuth(); }}>
      <Field id="pi-source-path" label={copy.sourcePath} required reserveMeta={false}>
        <Input id="pi-source-path" type="text" autocomplete="off" bind:value={piSourcePath} required />
      </Field>
      <Checkbox id="pi-overwrite" label={copy.overwriteCredentials} bind:checked={piOverwrite} />
      <Button type="submit" disabled={Boolean(busy)}>{copy.import}</Button>
    </form>
  </Panel>

  <Panel title={copy.daemon} id="daemon-heading">
    <dl><div><dt>{copy.lifecycle}</dt><dd>{daemon.lifecycle.state}</dd></div><div><dt>{copy.build}</dt><dd>{daemon.buildFingerprint ?? copy.unavailable}</dd></div><div><dt>{copy.invocations}</dt><dd>{daemon.invocations.running} {copy.running} · {daemon.invocations.queued} {copy.queued} · {daemon.invocations.failed} {copy.failed}</dd></div><div><dt>{copy.observed}</dt><dd>{daemon.observedAt}</dd></div></dl>
    <div class="row"><Button variant="secondary" disabled={Boolean(busy)} onclick={() => void refreshDaemon()}>{copy.refresh}</Button><Button variant="danger" disabled={Boolean(busy)} onclick={() => (restartOpen = true)}>{copy.restart}</Button></div>
  </Panel>

  <Panel title={copy.notifications} note={copy.notificationsHint} id="notification-heading">
    <div class="row"><Button variant="secondary" disabled={notificationPermission === "unsupported" || notificationPermission === "granted"} onclick={() => void enableNotifications()}>{notificationPermission === "granted" ? copy.notificationsEnabled : notificationPermission === "unsupported" ? copy.notificationsUnavailable : copy.enableNotifications}</Button><StatusPill label={notificationPermission} status={notificationPermission} /></div>
  </Panel>
</PageLayout>

<ConfirmDialog
  bind:open={restartOpen}
  title={copy.restart}
  description={copy.restartConfirm}
  confirmLabel={copy.restart}
  cancelLabel={copy.cancel}
  danger
  loading={busy === "Daemon restart"}
  onConfirm={() => void restartDaemon()}
/>

<style>
  h3, p { margin: 0; }
  article, form { display: grid; gap: var(--spacing-sm); }
  article p { color: var(--color-ink-muted); }
  .provider-grid { display: grid; gap: var(--spacing-md); grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); }
  .model-grid { display: grid; gap: var(--spacing-md); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .policy-row { align-items: end; display: grid; gap: var(--spacing-sm); grid-template-columns: minmax(0, 1fr) auto; }
  .policy-row > :global(.ui-button),
  :global(.panel-action),
  form > :global(.ui-button),
  article > :global(.ui-button) { justify-self: start; }
  article { background: var(--color-surface-soft); border: 1px solid var(--color-border); border-radius: var(--rounded-lg); padding: var(--spacing-lg); }
  article > header { align-items: start; display: flex; justify-content: space-between; }
  article > header div { display: grid; gap: 3px; }
  fieldset { border: 0; margin: 0; padding: 0; }
  legend { font-weight: var(--weight-card-title); margin-bottom: var(--spacing-sm); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .diagnostics { color: var(--color-warning-strong); }
  dl { display: grid; gap: 5px; margin: 0; }
  dl div { display: grid; gap: 8px; grid-template-columns: 110px minmax(0, 1fr); }
  dt { color: var(--color-ink-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 900px) { .provider-grid { grid-template-columns: 1fr; } }
  @media (max-width: 640px) { .model-grid, .policy-row { grid-template-columns: 1fr; } }
</style>
