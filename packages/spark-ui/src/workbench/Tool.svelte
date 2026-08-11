<script lang="ts">
  import WorkbenchPanel from "./WorkbenchPanel.svelte";
  import { formatWorkbenchValue } from "./view";
  import type { Snippet } from "svelte";
  import type { ToolView } from "./types";

  type Props = {
    view: ToolView;
    statusLabel: (status: string) => string;
    inputLabel: string;
    outputLabel: string;
    errorLabel: string;
    emptyLabel: string;
    defaultOpen?: boolean;
    nested?: boolean;
    header?: Snippet<[ToolView]>;
    actions?: Snippet<[ToolView]>;
  };

  let {
    view,
    statusLabel,
    inputLabel,
    outputLabel,
    errorLabel,
    emptyLabel,
    defaultOpen = false,
    nested = false,
    header,
    actions,
  }: Props = $props();

  let preview = $derived(view.summary?.trim() || "");
  let headline = $derived(preview.split(/\r?\n/u).find((line) => line.trim())?.slice(0, 120));
</script>

{#snippet body()}
  {#if header}<div class="tool-header">{@render header(view)}</div>{/if}
  {#if view.input !== undefined}
    <section><strong>{inputLabel}</strong><pre>{formatWorkbenchValue(view.input)}</pre></section>
  {/if}
  {#if view.output !== undefined || preview}
    <section><strong>{outputLabel}</strong><pre>{view.output === undefined ? preview : formatWorkbenchValue(view.output)}</pre></section>
  {/if}
  {#if view.error}
    <section class="error" role="alert">
      <strong>{errorLabel}: {view.error.title}</strong>
      <p>{view.error.message}</p>
      {#if view.error.code}<code>{view.error.code}</code>{/if}
    </section>
  {/if}
  {#if view.input === undefined && view.output === undefined && !preview && !view.error}
    <p class="empty">{emptyLabel}</p>
  {/if}
{/snippet}

{#snippet actionContent()}{#if actions}{@render actions(view)}{/if}{/snippet}

<WorkbenchPanel
  id={view.id}
  title={view.name}
  status={view.status}
  statusLabel={statusLabel(view.status)}
  summary={headline}
  {defaultOpen}
  {nested}
  children={body}
  actions={actions ? actionContent : undefined}
/>

<style>
  section, .tool-header { display: grid; gap: 5px; min-width: 0; }
  strong { color: var(--color-ink-subtle); font-size: 10px; text-transform: uppercase; }
  pre, p { color: var(--color-ink-muted); font-size: 12px; line-height: 1.5; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  pre { font-family: var(--font-mono); max-height: 320px; overflow: auto; }
  .error { background: var(--color-danger-weak); border-radius: var(--rounded-md); padding: 8px; }
  .error strong, .error p, .error code { color: var(--color-danger-strong); }
  .error code { font-family: var(--font-mono); font-size: 10px; }
</style>
