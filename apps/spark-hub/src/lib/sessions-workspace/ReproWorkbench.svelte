<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { A2uiRenderer, type SparkA2uiInteractiveBinding } from "@zendev-lab/spark-ui/a2ui";
  import type { SparkWorkbenchActionRequest } from "@zendev-lab/spark-protocol";

  let {
    sessionId,
    binding,
    canControl,
    labels,
  }: {
    sessionId: string;
    binding: SparkA2uiInteractiveBinding;
    canControl: boolean;
    labels: {
      aria: string;
      loading: string;
      syncing: string;
      pendingTitle: string;
      pendingBody: string;
      unavailable: string;
      retry: string;
    };
  } = $props();

  type ReadyDocument = {
    status: "ready";
    binding: SparkA2uiInteractiveBinding;
    artifactId: string;
    content: string;
  };

  let document = $state<ReadyDocument | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let loadedKey = $state("");
  let requestGeneration = 0;
  let acceptedGeneration = $state(0);
  let bindingKey = $derived(
    `${sessionId}:${binding.artifactRef}:${binding.revision}:${binding.generation}:${binding.lifecycle}`,
  );

  $effect(() => {
    if (bindingKey === loadedKey) return;
    loadedKey = bindingKey;
    void loadDocument();
  });

  async function loadDocument() {
    const generation = ++requestGeneration;
    loading = true;
    error = null;
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/workbench`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (generation !== requestGeneration) return;
      if (response.status === 202) {
        document = null;
        error = labels.syncing;
        return;
      }
      if (!response.ok || !isReadyDocument(payload)) {
        throw new Error(messageFrom(payload) ?? labels.unavailable);
      }
      document = payload;
    } catch (caught) {
      if (generation !== requestGeneration) return;
      document = null;
      error = caught instanceof Error ? caught.message : labels.unavailable;
    } finally {
      if (generation === requestGeneration) loading = false;
    }
  }

  async function control(action: SparkWorkbenchActionRequest) {
    const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/workbench`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(action),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(messageFrom(payload) ?? "Workbench action was rejected.");
    }
    const nextGeneration =
      isRecord(payload) && isRecord(payload.loop) && typeof payload.loop.generation === "number"
        ? payload.loop.generation
        : binding.generation + 1;
    acceptedGeneration = Math.max(acceptedGeneration, nextGeneration);
    document = null;
    loading = true;
    await invalidateAll();
    loadedKey = "";
    await loadDocument();
  }

  function isReadyDocument(value: unknown): value is ReadyDocument {
    if (!isRecord(value) || value.status !== "ready" || typeof value.content !== "string") {
      return false;
    }
    const candidate = value.binding;
    return (
      isRecord(candidate) &&
      candidate.artifactRef === binding.artifactRef &&
      candidate.revision === binding.revision &&
      candidate.loopId === binding.loopId &&
      candidate.generation === binding.generation &&
      candidate.generation >= acceptedGeneration &&
      candidate.lifecycle === binding.lifecycle
    );
  }

  function messageFrom(value: unknown): string | null {
    return isRecord(value) && typeof value.message === "string" ? value.message : null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
</script>

<section class="repro-workbench" aria-label={labels.aria} aria-busy={loading}>
  {#if document}
    <A2uiRenderer
      content={document.content}
      binding={document.binding}
      interactive={canControl && document.binding.lifecycle === "live"}
      onAction={control}
    />
  {:else if loading}
    <div class="workbench-loading" role="status">{labels.loading}</div>
  {:else}
    <div class="workbench-pending" role="status">
      <strong>{labels.pendingTitle}</strong>
      <span>{error ?? labels.pendingBody}</span>
      <button type="button" onclick={() => loadDocument()}>{labels.retry}</button>
    </div>
  {/if}
</section>

<style>
  .repro-workbench {
    min-width: 0;
  }

  .workbench-loading,
  .workbench-pending {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    color: var(--color-ink-muted);
    display: grid;
    gap: 8px;
    min-height: 96px;
    padding: 18px;
    place-content: center;
    text-align: center;
  }

  .workbench-pending button {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    cursor: pointer;
    justify-self: center;
    min-height: 36px;
    padding: 6px 12px;
  }
</style>
