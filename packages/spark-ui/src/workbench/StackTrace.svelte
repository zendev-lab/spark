<script lang="ts">
  import type { StackFrameView } from "./types";

  type Props = {
    title: string;
    message?: string;
    frames: readonly StackFrameView[];
    onSelectFrame?: (frame: StackFrameView) => void;
  };
  const componentId = $props.id();
  const titleId = `${componentId}-stack-trace-title`;
  let { title, message, frames, onSelectFrame }: Props = $props();
</script>

<section class="stack-trace" aria-labelledby={titleId}>
  <header><strong id={titleId}>{title}</strong>{#if message}<p>{message}</p>{/if}</header>
  <ol>
    {#each frames as frame (frame.id)}
      <li>
        {#if onSelectFrame}
          <button type="button" onclick={() => onSelectFrame?.(frame)}>
            <strong>{frame.functionName ?? "anonymous"}</strong>
            <code>{frame.file ?? "unknown"}{frame.line ? `:${frame.line}` : ""}{frame.column ? `:${frame.column}` : ""}</code>
            {#if frame.source}<span>{frame.source}</span>{/if}
          </button>
        {:else}
          <div>
            <strong>{frame.functionName ?? "anonymous"}</strong>
            <code>{frame.file ?? "unknown"}{frame.line ? `:${frame.line}` : ""}{frame.column ? `:${frame.column}` : ""}</code>
            {#if frame.source}<span>{frame.source}</span>{/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .stack-trace { border: 1px solid var(--color-danger-soft); border-radius: var(--rounded-lg); overflow: hidden; }
  header { background: var(--color-danger-weak); color: var(--color-danger-strong); display: grid; gap: 3px; padding: 9px 10px; }
  header strong { font-size: 12px; } header p { font-size: 11px; margin: 0; }
  ol { counter-reset: frame; display: grid; list-style: none; margin: 0; padding: 5px 0; }
  li { counter-increment: frame; }
  button, li div { background: transparent; border: 0; color: var(--color-ink); display: grid; font: inherit; gap: 2px; padding: 7px 10px 7px 30px; position: relative; text-align: start; width: 100%; }
  button { cursor: pointer; } button:hover { background: var(--color-surface-soft); } button:focus-visible { box-shadow: inset var(--shadow-focus); outline: none; }
  button::before, li div::before { color: var(--color-ink-subtle); content: counter(frame); font-family: var(--font-mono); font-size: 9px; inset-inline-start: 10px; position: absolute; top: 9px; }
  li strong { font-size: 11px; } code, li span { color: var(--color-ink-muted); font-family: var(--font-mono); font-size: 10px; overflow-wrap: anywhere; }
</style>
