<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import type { SparkAuthFlow } from "@zendev-lab/spark-protocol";
  import {
    authFlowStatusLabel,
    isTerminalAuthFlow,
    latestAuthProgress,
  } from "$lib/provider-auth";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let flow = $state<SparkAuthFlow | null>(null);
  let errorText = $state("");
  let promptValue = $state("");
  let lastPromptId = $state("");
  let starting = $state(true);
  let responding = $state(false);

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

<section class="page">
  <p class="crumb"><a href="/settings">Providers</a></p>
  <header>
    <h1>Sign in to {data.provider.label}</h1>
    <p>Spark opens the provider's OAuth flow. Secrets stay in the daemon; this page only shows the public login state.</p>
  </header>

  {#if starting && !flow}
    <p>Starting OAuth…</p>
  {/if}
  {#if errorText}<p class="error">{errorText}</p>{/if}

  {#if flow}
    <article class="card">
      <div class="heading">
        <h2>{flow.providerLabel ?? flow.providerName}</h2>
        <span class="badge {flow.status}">{authFlowStatusLabel(flow.status)}</span>
      </div>

      {#if flow.authorization}
        <a class="button" href={flow.authorization.url} target="_blank" rel="noreferrer">
          Open authorization
        </a>
        {#if flow.authorization.instructions}
          <p class="muted">{flow.authorization.instructions}</p>
        {/if}
      {/if}

      {#if flow.deviceCode}
        <div class="device">
          <span>Device code</span>
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
          <label>
            {flow.prompt.message}
            {#if flow.prompt.kind === "select"}
              <select bind:value={promptValue} required>
                {#each flow.prompt.options as option (option.id)}
                  <option value={option.id}>{option.label}</option>
                {/each}
              </select>
            {:else}
              <input
                type="text"
                placeholder={flow.prompt.placeholder ?? ""}
                required={flow.prompt.allowEmpty !== true}
                autocomplete="off"
                bind:value={promptValue}
              />
            {/if}
          </label>
          <button type="submit" disabled={responding}>{responding ? "Sending…" : "Continue"}</button>
        </form>
      {/if}

      {#if latestAuthProgress(flow)}
        <p class="muted">{latestAuthProgress(flow)}</p>
      {/if}
      {#if flow.error}<p class="error">{flow.error}</p>{/if}

      <div class="actions">
        {#if flow.status === "succeeded"}
          <a class="button" href="/settings">Done</a>
        {:else if !isTerminalAuthFlow(flow.status)}
          <button type="button" class="secondary" onclick={() => void cancel()}>Cancel</button>
        {:else}
          <a href="/settings">Back to providers</a>
        {/if}
      </div>
    </article>
  {/if}
</section>

<style>
  .page {
    padding: 24px;
    display: grid;
    gap: 16px;
    max-width: 640px;
  }
  .crumb,
  .muted {
    color: var(--color-ink-muted);
    margin: 0;
  }
  .crumb a,
  a {
    color: inherit;
  }
  header p {
    color: var(--color-ink-muted);
  }
  h1,
  h2 {
    margin: 0;
  }
  .card {
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
    align-items: center;
  }
  .badge {
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: 12px;
    padding: 4px 8px;
  }
  .badge.waiting_for_user,
  .badge.pending {
    color: var(--color-primary, #2563eb);
  }
  .badge.succeeded {
    color: var(--color-success-strong, #15803d);
  }
  .badge.failed {
    color: var(--color-danger, #b91c1c);
  }
  .device {
    display: grid;
    gap: 4px;
    padding: 12px;
    border-radius: 8px;
    background: var(--color-canvas);
  }
  .device strong {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 22px;
    letter-spacing: 0.12em;
  }
  form,
  label {
    display: grid;
    gap: 8px;
  }
  .actions {
    display: flex;
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
  .error {
    color: var(--color-danger, #b91c1c);
    margin: 0;
  }
</style>
