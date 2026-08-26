<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import type { SparkAuthFlow } from "@zendev-lab/spark-protocol";
  import {
    Button,
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
  import {
    authFlowStatusLabel,
    isTerminalAuthFlow,
    latestAuthProgress,
  } from "$lib/provider-auth";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let copy = $derived(data.messages.web.settings);
  let flow = $state<SparkAuthFlow | null>(null);
  let errorText = $state("");
  let promptValue = $state("");
  let lastPromptId = $state("");
  let starting = $state(true);
  let responding = $state(false);
  let promptGroups = $derived<SelectGroup[]>([
    {
      id: "oauth-prompt",
      options: flow?.prompt?.kind === "select"
        ? flow.prompt.options.map((option) => ({ value: option.id, label: option.label }))
        : [],
    },
  ]);

  onMount(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (timer) clearInterval(timer);
    };

    const poll = async () => {
      if (!flow || isTerminalAuthFlow(flow.status)) {
        stop();
        return;
      }
      try {
        flow = await webRpc("provider.auth.login.status", { flowId: flow.id });
        if (isTerminalAuthFlow(flow.status)) stop();
      } catch (caught) {
        errorText = caught instanceof Error ? caught.message : String(caught);
        stop();
      }
    };

    void (async () => {
      try {
        const started = await webRpc("provider.auth.login.start", {
          providerName: data.provider.providerName,
        });
        if (cancelled) {
          await webRpc("provider.auth.login.cancel", { flowId: started.id }).catch(() => undefined);
          return;
        }
        flow = started;
        starting = false;
        if (!isTerminalAuthFlow(started.status)) {
          timer = setInterval(() => void poll(), 1000);
          void poll();
        }
      } catch (caught) {
        if (!cancelled) {
          errorText = caught instanceof Error ? caught.message : String(caught);
          starting = false;
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  });

  $effect(() => {
    const prompt = flow?.prompt;
    if (!prompt || prompt.id === lastPromptId) return;
    lastPromptId = prompt.id;
    promptValue = prompt.kind === "select" ? (prompt.options[0]?.id ?? "") : "";
  });

  async function respond() {
    if (!flow?.prompt) return;
    responding = true;
    errorText = "";
    try {
      flow = await webRpc("provider.auth.login.respond", {
        flowId: flow.id,
        promptId: flow.prompt.id,
        value: promptValue,
      });
    } catch (caught) {
      errorText = caught instanceof Error ? caught.message : String(caught);
    } finally {
      responding = false;
    }
  }

  async function cancel() {
    if (!flow) {
      await goto("/settings");
      return;
    }
    errorText = "";
    try {
      flow = await webRpc("provider.auth.login.cancel", { flowId: flow.id });
      await goto("/settings");
    } catch (caught) {
      errorText = caught instanceof Error ? caught.message : String(caught);
    }
  }
</script>

<PageLayout width="compact">
  <p class="crumb"><a href="/settings">← {copy.providersBack}</a></p>
  <PageHeader title={`${copy.signInTo} ${data.provider.label}`} lede={copy.oauthLede} />

  {#if starting && !flow}
    <Notice message={copy.startingOAuth} />
  {/if}
  {#if errorText}<Notice tone="danger" message={errorText} />{/if}

  {#if flow}
    <Panel>
      <div class="heading">
        <h2>{flow.providerLabel ?? flow.providerName}</h2>
        <StatusPill label={authFlowStatusLabel(flow.status)} status={flow.status} />
      </div>

      {#if flow.authorization}
        <Button class="authorization-action" href={flow.authorization.url} target="_blank" rel="noreferrer">{copy.openAuthorization}</Button>
        {#if flow.authorization.instructions}
          <p class="muted">{flow.authorization.instructions}</p>
        {/if}
      {/if}

      {#if flow.deviceCode}
        <div class="device">
          <span>{copy.deviceCode}</span>
          <strong>{flow.deviceCode.userCode}</strong>
          <a href={flow.deviceCode.verificationUri} target="_blank" rel="noreferrer">
            {flow.deviceCode.verificationUri}
          </a>
        </div>
      {/if}

      {#if flow.prompt}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void respond();
          }}
        >
          <Field id="oauth-prompt" label={flow.prompt.message} required={flow.prompt.kind === "select" || flow.prompt.allowEmpty !== true} reserveMeta={false}>
            {#if flow.prompt.kind === "select"}
              <Select id="oauth-prompt" bind:value={promptValue} groups={promptGroups} label={flow.prompt.message} required />
            {:else}
              <Input
                id="oauth-prompt"
                type="text"
                placeholder={flow.prompt.placeholder ?? ""}
                required={flow.prompt.allowEmpty !== true}
                autocomplete="off"
                bind:value={promptValue}
              />
            {/if}
          </Field>
          <Button type="submit" loading={responding}>{responding ? copy.sending : copy.continue}</Button>
        </form>
      {/if}

      {#if latestAuthProgress(flow)}
        <p class="muted">{latestAuthProgress(flow)}</p>
      {/if}
      {#if flow.error}<Notice tone="danger" message={flow.error} />{/if}

      <div class="actions">
        {#if flow.status === "succeeded"}
          <Button href="/settings">{copy.done}</Button>
        {:else if !isTerminalAuthFlow(flow.status)}
          <Button variant="secondary" onclick={() => void cancel()}>{copy.cancel}</Button>
        {:else}
          <Button variant="secondary" href="/settings">{copy.backToProviders}</Button>
        {/if}
      </div>
    </Panel>
  {/if}
</PageLayout>

<style>
  .crumb,
  .muted {
    color: var(--color-ink-muted);
    margin: 0;
  }
  .crumb a,
  a {
    color: inherit;
  }
  h2 {
    margin: 0;
  }
  .heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
  }
  .device {
    display: grid;
    gap: 4px;
    padding: 12px;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
  }
  .device strong {
    font-family: var(--font-mono);
    font-size: 22px;
    letter-spacing: 0.12em;
  }
  form {
    display: grid;
    gap: var(--spacing-sm);
  }
  :global(.authorization-action),
  form > :global(.ui-button) {
    justify-self: start;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
