<script lang="ts">
  import {
    normalizeSparkA2uiDocument,
    resolveSparkA2uiDataPath,
    sparkWorkbenchActionRequestSchema,
    updateSparkA2uiDataModel,
    type SparkA2uiComponent,
    type SparkA2uiSurface,
    type SparkProtocolJsonValue,
    type SparkWorkbenchActionRequest,
  } from "@zendev-lab/spark-protocol";
  import { onMount, type Component } from "svelte";
  import type { SparkA2uiActionHandler, SparkA2uiInteractiveBinding } from "./a2ui.ts";

  const MAX_RENDER_DEPTH = 64;

  let {
    content,
    interactive = false,
    binding,
    onAction,
    stopConfirmation = "Stop this Repro Loop? This cannot be resumed.",
  }: {
    content: string;
    interactive?: boolean;
    binding?: SparkA2uiInteractiveBinding;
    onAction?: SparkA2uiActionHandler;
    stopConfirmation?: string;
  } = $props();

  let document = $derived(normalizeSparkA2uiDocument(content));
  let surface = $derived(
    document.surfaces.find(
      (candidate) => candidate.surfaceId === document.latestSurfaceId && !candidate.deleted,
    ) ?? document.surfaces.find((candidate) => !candidate.deleted),
  );
  let sourceContent = $state("");
  let dataModel = $state<unknown>({});
  let activeTab = $state<string | null>(null);
  let submitting = $state(false);
  let feedback = $state<string | null>(null);
  let Markdown = $state<Component<{ source: string; streaming?: boolean }> | null>(null);

  onMount(() => {
    void import("./markdown/SafeMarkdown.svelte").then((module) => {
      Markdown = module.default;
    });
  });

  $effect(() => {
    if (sourceContent === content) return;
    sourceContent = content;
    dataModel = structuredClone(surface?.dataModel ?? {});
    activeTab = null;
    submitting = false;
    feedback = null;
  });

  function component(id: string): SparkA2uiComponent | undefined {
    return surface?.components[id];
  }

  function ids(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  function text(value: unknown): string {
    const resolved = resolveValue(value);
    return typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean"
      ? String(resolved)
      : "";
  }

  function resolveValue(value: unknown): unknown {
    if (isRecord(value) && typeof value.path === "string" && Object.keys(value).length === 1) {
      return resolveSparkA2uiDataPath(dataModel, value.path);
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item)]));
    }
    return value;
  }

  function childText(id: unknown): string {
    if (typeof id !== "string") return "";
    const child = component(id);
    return child?.component === "Text" ? text(child.text) : "";
  }

  function tabsFor(node: SparkA2uiComponent): Array<{ title: string; child: string }> {
    if (!Array.isArray(node.tabs)) return [];
    return node.tabs.flatMap((tab) =>
      isRecord(tab) && typeof tab.title === "string" && typeof tab.child === "string"
        ? [{ title: tab.title, child: tab.child }]
        : [],
    );
  }

  function fieldPath(node: SparkA2uiComponent): string | null {
    const value = node.value;
    return isRecord(value) && typeof value.path === "string" ? value.path : null;
  }

  function navigateTabs(
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
    tabs: Array<{ title: string; child: string }>,
    currentChild: string,
  ) {
    const currentIndex = tabs.findIndex((tab) => tab.child === currentChild);
    if (currentIndex < 0) return;
    const nextIndex =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (currentIndex + 1) % tabs.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const tablist = event.currentTarget.parentElement;
    activeTab = tabs[nextIndex]?.child ?? null;
    queueMicrotask(() => {
      tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
    });
  }

  function updateField(node: SparkA2uiComponent, value: SparkProtocolJsonValue) {
    const path = fieldPath(node);
    if (path) dataModel = updateSparkA2uiDataModel(dataModel, path, value);
  }

  async function dispatch(node: SparkA2uiComponent) {
    if (!interactive || !binding || !onAction || submitting || !surface) return;
    const action = isRecord(node.action) && isRecord(node.action.event) ? node.action.event : null;
    if (!action || typeof action.name !== "string") return;
    const candidate = sparkWorkbenchActionRequestSchema.safeParse({
      version: document.version,
      action: {
        name: action.name,
        surfaceId: surface.surfaceId,
        sourceComponentId: node.id,
        timestamp: new Date().toISOString(),
        context: resolveValue(action.context ?? {}),
      },
    });
    if (!candidate.success || !matchesBinding(candidate.data, binding)) {
      feedback = "This Workbench action is stale or untrusted. Refresh before trying again.";
      return;
    }
    if (
      candidate.data.action.context.actionId === "stop" &&
      !globalThis.confirm(stopConfirmation)
    ) {
      return;
    }
    submitting = true;
    feedback = `Sending ${actionLabel(candidate.data.action.context.actionId)}…`;
    try {
      await onAction(candidate.data);
      feedback = `${actionLabel(candidate.data.action.context.actionId)} accepted. Refreshing Workbench…`;
    } catch (error) {
      feedback = error instanceof Error ? error.message : "Workbench action failed.";
    } finally {
      submitting = false;
    }
  }

  function matchesBinding(
    action: SparkWorkbenchActionRequest,
    expected: SparkA2uiInteractiveBinding,
  ): boolean {
    const context = action.action.context;
    return (
      expected.lifecycle === "live" &&
      context.artifactRef === expected.artifactRef &&
      context.revision === expected.revision &&
      context.loopId === expected.loopId &&
      context.generation === expected.generation
    );
  }

  function actionLabel(value: SparkWorkbenchActionRequest["action"]["context"]["actionId"]): string {
    return value.replaceAll("_", " ");
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
</script>

{#snippet renderNode(id: string, ancestors: string[])}
  {@const node = component(id)}
  {#if ancestors.includes(id)}
    <div class="a2ui-unsupported" role="note">Cyclic A2UI component reference: {id}</div>
  {:else if ancestors.length >= MAX_RENDER_DEPTH}
    <div class="a2ui-unsupported" role="note">A2UI component depth limit reached.</div>
  {:else if node}
    {@const nextAncestors = [...ancestors, id]}
    {#if node.component === "Column" || node.component === "Row"}
      <div class:a2ui-column={node.component === "Column"} class:a2ui-row={node.component === "Row"}>
        {#each ids(node.children) as childId (childId)}
          {@render renderNode(childId, nextAncestors)}
        {/each}
      </div>
    {:else if node.component === "Text"}
      <div class="a2ui-text" data-variant={text(node.variant) || undefined}>
        {#if Markdown}
          <Markdown source={text(node.text)} streaming={false} />
        {:else}
          <pre>{text(node.text)}</pre>
        {/if}
      </div>
    {:else if node.component === "Card"}
      <section class="a2ui-card">{#if typeof node.child === "string"}{@render renderNode(node.child, nextAncestors)}{/if}</section>
    {:else if node.component === "Tabs"}
      {@const tabs = tabsFor(node)}
      {@const selected = activeTab && tabs.some((tab) => tab.child === activeTab) ? activeTab : tabs[0]?.child}
      <div class="a2ui-tabs">
        <div class="a2ui-tablist" role="tablist" aria-label="Repro Workbench views">
          {#each tabs as tab (tab.child)}
            <button
              id={`a2ui-tab-${tab.child}`}
              type="button"
              role="tab"
              aria-selected={selected === tab.child}
              aria-controls={`a2ui-panel-${tab.child}`}
              tabindex={selected === tab.child ? 0 : -1}
              onclick={() => (activeTab = tab.child)}
              onkeydown={(event) => navigateTabs(event, tabs, tab.child)}
            >{tab.title}</button>
          {/each}
        </div>
        {#each tabs as tab (tab.child)}
          <div
            id={`a2ui-panel-${tab.child}`}
            class="a2ui-tabpanel"
            role="tabpanel"
            aria-labelledby={`a2ui-tab-${tab.child}`}
            hidden={selected !== tab.child}
          >
            {@render renderNode(tab.child, nextAncestors)}
          </div>
        {/each}
      </div>
    {:else if node.component === "Button"}
      <button
        class="a2ui-action"
        class:danger={isRecord(node.action) && JSON.stringify(node.action).includes('"actionId":"stop"')}
        type="button"
        disabled={!interactive || !binding || submitting}
        onclick={() => dispatch(node)}
      >{childText(node.child) || text(node.label) || "Action"}</button>
    {:else if node.component === "Divider"}
      <hr />
    {:else if node.component === "TextField"}
      <label class="a2ui-field">
        <span>{text(node.label)}</span>
        <input
          value={text(node.value)}
          disabled={!interactive}
          oninput={(event) => updateField(node, event.currentTarget.value)}
        />
      </label>
    {:else if node.component === "Checkbox"}
      <label class="a2ui-checkbox">
        <input
          type="checkbox"
          checked={Boolean(resolveValue(node.value))}
          disabled={!interactive}
          onchange={(event) => updateField(node, event.currentTarget.checked)}
        />
        <span>{text(node.label) || childText(node.child)}</span>
      </label>
    {:else}
      <div class="a2ui-unsupported" role="note">Unsupported A2UI component: {node.component}</div>
    {/if}
  {/if}
{/snippet}

<div
  class="a2ui-renderer"
  data-interactive={interactive && binding?.lifecycle === "live"}
  data-surface-id={surface?.surfaceId}
>
  {#if surface?.components.root}
    {@render renderNode("root", [])}
  {:else}
    <p class="a2ui-empty">This A2UI document has no renderable root surface.</p>
  {/if}
  {#if document.diagnostics.length > 0}
    <details class="a2ui-diagnostics">
      <summary>Renderer diagnostics</summary>
      <ul>{#each document.diagnostics as diagnostic}<li>{diagnostic}</li>{/each}</ul>
    </details>
  {/if}
  <p class="a2ui-feedback" aria-live="polite">{feedback ?? ""}</p>
</div>

<style>
  .a2ui-renderer,
  .a2ui-column {
    display: grid;
    gap: var(--spacing-md, 16px);
    min-width: 0;
  }

  .a2ui-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-sm, 10px);
  }

  .a2ui-text :global(.ai-response) {
    color: var(--color-ink, #18181b);
  }

  .a2ui-text pre {
    font: inherit;
    margin: 0;
    white-space: pre-wrap;
  }

  .a2ui-text[data-variant="h1"] :global(.ai-response) {
    font-size: clamp(20px, 3vw, 28px);
    font-weight: 700;
  }

  .a2ui-card {
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #e4e4e7);
    border-radius: var(--rounded-lg, 12px);
    min-width: 0;
    padding: clamp(14px, 2vw, 22px);
  }

  .a2ui-tablist {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding-bottom: 1px;
  }

  .a2ui-tablist button,
  .a2ui-action {
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border, #e4e4e7);
    border-radius: var(--rounded-md, 8px);
    color: var(--color-ink-muted, #52525b);
    cursor: pointer;
    font: inherit;
    min-height: 36px;
    padding: 7px 12px;
    white-space: nowrap;
  }

  .a2ui-tablist button[aria-selected="true"] {
    background: var(--color-primary-weak, #eef2ff);
    border-color: var(--color-primary-soft, #c7d2fe);
    color: var(--color-primary, #4f46e5);
  }

  .a2ui-tablist button:focus-visible,
  .a2ui-action:focus-visible,
  input:focus-visible {
    box-shadow: var(--shadow-focus, 0 0 0 3px #c7d2fe);
    outline: none;
  }

  .a2ui-tabpanel {
    margin-top: var(--spacing-md, 16px);
  }

  .a2ui-tabpanel[hidden] {
    display: none;
  }

  .a2ui-action {
    justify-self: start;
  }

  .a2ui-action.danger {
    border-color: var(--color-danger, #dc2626);
    color: var(--color-danger, #dc2626);
  }

  .a2ui-action:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .a2ui-field {
    display: grid;
    gap: 6px;
  }

  .a2ui-field input {
    border: 1px solid var(--color-border, #e4e4e7);
    border-radius: var(--rounded-md, 8px);
    min-height: 40px;
    padding: 7px 10px;
  }

  .a2ui-checkbox {
    align-items: center;
    display: flex;
    gap: 8px;
  }

  .a2ui-unsupported,
  .a2ui-empty,
  .a2ui-diagnostics,
  .a2ui-feedback {
    color: var(--color-ink-subtle, #71717a);
    font-size: 12px;
  }

  .a2ui-feedback {
    margin: 0;
    min-height: 1.25em;
  }

  @media (max-width: 640px) {
    .a2ui-card {
      padding: 12px;
    }

    .a2ui-action {
      width: 100%;
    }
  }

  @media (pointer: coarse) {
    .a2ui-tablist button,
    .a2ui-action {
      min-height: 44px;
    }
  }
</style>
