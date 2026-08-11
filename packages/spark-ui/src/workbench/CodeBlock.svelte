<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { CodeBlockView } from "./types";

  type Props = {
    view: CodeBlockView;
    copyLabel: string;
    onCopy?: (code: string) => void | Promise<void>;
  };

  let { view, copyLabel, onCopy }: Props = $props();
  let lines = $derived(view.code.split("\n"));
  let highlighted = $derived(new Set(view.highlightLines ?? []));
</script>

<figure class="code-block">
  <figcaption>
    <span>{view.filename ?? view.language ?? "text"}</span>
    {#if onCopy}
      <button type="button" aria-label={copyLabel} title={copyLabel} onclick={() => onCopy?.(view.code)}>
        <Icon name="copy" size={13} />
      </button>
    {/if}
  </figcaption>
  <div class="code-scroll" role="textbox" aria-readonly="true" aria-multiline="true" tabindex="0" aria-label={view.filename ?? view.language ?? "Code"}><pre><code>{#each lines as line, index}<span class:highlighted={highlighted.has(index + 1)}><i aria-hidden="true">{index + 1}</i>{line || " "}</span>{/each}</code></pre></div>
</figure>

<style>
  .code-block { background: var(--color-code-surface); border: 1px solid var(--color-border-strong); border-radius: var(--rounded-lg); color: var(--color-code-ink); margin: 0; overflow: hidden; }
  figcaption { align-items: center; background: var(--color-code-surface-soft); color: var(--color-code-muted); display: flex; font-family: var(--font-mono); font-size: 10px; justify-content: space-between; min-height: 34px; padding-inline: 10px; }
  button { align-items: center; background: transparent; border: 0; border-radius: var(--rounded-sm); color: inherit; cursor: pointer; display: inline-flex; height: 26px; justify-content: center; width: 26px; }
  button:hover { background: rgb(255 255 255 / 8%); color: var(--color-code-ink); }
  button:focus-visible, .code-scroll:focus-visible { box-shadow: inset var(--shadow-focus); outline: none; }
  .code-scroll { max-height: 480px; overflow: auto; }
  pre { font-family: var(--font-mono); font-size: 11px; line-height: 1.6; margin: 0; padding-block: 8px; }
  code { display: grid; min-width: max-content; }
  code span { display: grid; grid-template-columns: 42px minmax(0, 1fr); padding-inline-end: 12px; white-space: pre; }
  code span.highlighted { background: rgb(96 165 250 / 16%); }
  i { color: var(--color-code-muted); font-style: normal; padding-inline: 10px; text-align: end; user-select: none; }
</style>
