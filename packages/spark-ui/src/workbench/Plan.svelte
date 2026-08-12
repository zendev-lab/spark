<script lang="ts">
  import Icon from "../Icon.svelte";
  import WorkbenchPanel from "./WorkbenchPanel.svelte";
  import type { PlanStepView, PlanView } from "./types";

  type Props = {
    view: PlanView;
    statusLabel: (status: string) => string;
    stepLabel: string;
    defaultOpen?: boolean;
    onSelectStep?: (step: PlanStepView) => void;
  };

  let { view, statusLabel, stepLabel, defaultOpen = true, onSelectStep }: Props = $props();
</script>

{#snippet body()}
  {#if view.description}<p>{view.description}</p>{/if}
  <ol aria-label={stepLabel}>
    {#each view.steps as step, index (step.id)}
      <li class={step.status}>
        <span class="marker" aria-hidden="true">
          {#if step.status === "completed"}<Icon name="check" size={12} />{:else}{index + 1}{/if}
        </span>
        {#if onSelectStep}
          <button type="button" onclick={() => onSelectStep?.(step)}>
            <strong>{step.title}</strong>
            {#if step.description}<span>{step.description}</span>{/if}
          </button>
        {:else}
          <div>
            <strong>{step.title}</strong>
            {#if step.description}<span>{step.description}</span>{/if}
          </div>
        {/if}
        <small>{statusLabel(step.status)}</small>
      </li>
    {/each}
  </ol>
{/snippet}

<WorkbenchPanel
  id={view.id}
  title={view.title}
  status={view.status}
  statusLabel={statusLabel(view.status)}
  {defaultOpen}
  children={body}
/>

<style>
  p { color: var(--color-ink-muted); font-size: 12px; line-height: 1.5; margin: 0; }
  ol { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
  li { align-items: start; display: grid; gap: 8px; grid-template-columns: 22px minmax(0, 1fr) auto; }
  .marker { align-items: center; background: var(--color-surface-raised); border: 1px solid var(--color-border); border-radius: var(--rounded-full); color: var(--color-ink-subtle); display: inline-flex; font-size: 9px; height: 22px; justify-content: center; width: 22px; }
  li.completed .marker { background: var(--color-success-soft); border-color: var(--color-success); color: var(--color-success-strong); }
  li.running .marker { background: var(--color-primary-soft); border-color: var(--color-primary); color: var(--color-primary); }
  li.blocked .marker, li.failed .marker { background: var(--color-danger-soft); border-color: var(--color-danger); color: var(--color-danger-strong); }
  li > div, button { background: transparent; border: 0; color: var(--color-ink); display: grid; font: inherit; gap: 2px; min-width: 0; padding: 0; text-align: start; }
  button { cursor: pointer; border-radius: var(--rounded-sm); }
  button:focus-visible { box-shadow: var(--shadow-focus); outline: none; }
  strong { font-size: 12px; }
  li span, small { color: var(--color-ink-muted); font-size: 10px; line-height: 1.4; }
</style>
