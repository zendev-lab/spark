<script lang="ts">
  import WorkbenchPanel from "./WorkbenchPanel.svelte";
  import type { Snippet } from "svelte";
  import type { TaskView } from "./types";

  type Props = {
    view: TaskView;
    statusLabel: (status: string) => string;
    taskLabel: string;
    defaultOpen?: boolean;
    actions?: Snippet<[TaskView]>;
  };

  let { view, statusLabel, taskLabel, defaultOpen = false, actions }: Props = $props();
</script>

{#snippet body()}
  {#if view.description}<p>{view.description}</p>{/if}
  {#if view.summary}<pre>{view.summary}</pre>{/if}
  <code>{taskLabel} · {view.id}</code>
{/snippet}

{#snippet actionContent()}{#if actions}{@render actions(view)}{/if}{/snippet}

<WorkbenchPanel
  id={view.id}
  title={view.title}
  status={view.status}
  statusLabel={statusLabel(view.status)}
  summary={view.summary?.split(/\r?\n/u)[0]?.slice(0, 120)}
  {defaultOpen}
  children={body}
  actions={actions ? actionContent : undefined}
/>

<style>
  p, pre { color: var(--color-ink-muted); font-size: 12px; line-height: 1.5; margin: 0; white-space: pre-wrap; }
  pre, code { font-family: var(--font-mono); }
  code { color: var(--color-ink-muted); font-size: 10px; }
</style>
