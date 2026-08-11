<script lang="ts">
  import { workbenchStatusTone } from "./view";
  import type { TerminalViewModel } from "./types";

  type Props = { view: TerminalViewModel; statusLabel: (status: string) => string };
  let { view, statusLabel }: Props = $props();
  let tone = $derived(workbenchStatusTone(view.status));
</script>

<figure class="terminal {tone}">
  <figcaption>
    <span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
    <strong>{view.title ?? "Terminal"}</strong>
    {#if view.status}<span>{statusLabel(view.status)}</span>{/if}
  </figcaption>
  <div class="terminal-scroll" role="textbox" aria-readonly="true" aria-multiline="true" tabindex="0" aria-label={view.title ?? "Terminal output"}><pre>{#if view.command}<code><i aria-hidden="true">$</i> {view.command}</code>
{/if}{view.output}</pre></div>
</figure>

<style>
  .terminal { background: var(--color-code-surface); border: 1px solid var(--color-border-strong); border-radius: var(--rounded-lg); color: var(--color-code-ink); margin: 0; overflow: hidden; }
  .terminal.danger { border-color: var(--color-danger); }
  figcaption { align-items: center; background: var(--color-code-surface-soft); color: var(--color-code-muted); display: grid; font-size: 10px; gap: 8px; grid-template-columns: auto minmax(0, 1fr) auto; min-height: 34px; padding-inline: 10px; }
  .lights { display: flex; gap: 4px; } .lights i { background: var(--color-code-muted); border-radius: 50%; height: 7px; opacity: .6; width: 7px; }
  .terminal-scroll { max-height: 420px; overflow: auto; }
  pre { font-family: var(--font-mono); font-size: 11px; line-height: 1.6; margin: 0; padding: 10px; white-space: pre-wrap; }
  .terminal-scroll:focus-visible { box-shadow: inset var(--shadow-focus); outline: none; }
  code i { color: var(--color-success); font-style: normal; }
</style>
