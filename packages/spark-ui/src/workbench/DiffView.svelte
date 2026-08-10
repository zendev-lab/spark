<script lang="ts">
  import type { DiffViewModel } from "./types";

  type Props = { view: DiffViewModel; additionsLabel: string; deletionsLabel: string };
  let { view, additionsLabel, deletionsLabel }: Props = $props();
</script>

<figure class="diff-view">
  <figcaption>
    <strong>{view.title}</strong>
    <span class="counts"><span class="add">+{view.additions ?? 0} {additionsLabel}</span><span class="delete">−{view.deletions ?? 0} {deletionsLabel}</span></span>
  </figcaption>
  <div class="diff-lines" role="textbox" aria-readonly="true" aria-multiline="true" aria-label={view.title} tabindex="0">
    {#each view.lines as line, index (`${line.kind}:${index}`)}
      <div class="line {line.kind}">
        <span aria-label="Old line">{line.oldLine ?? ""}</span>
        <span aria-label="New line">{line.newLine ?? ""}</span>
        <code><i aria-hidden="true">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</i>{line.text || " "}</code>
      </div>
    {/each}
  </div>
</figure>

<style>
  .diff-view { border: 1px solid var(--color-border); border-radius: var(--rounded-lg); margin: 0; overflow: hidden; }
  figcaption { align-items: center; background: var(--color-surface-soft); display: flex; font-size: 11px; gap: 12px; justify-content: space-between; min-height: 36px; padding-inline: 10px; }
  .counts { display: flex; font-family: var(--font-mono); gap: 8px; }
  .add { color: var(--color-success-strong); } .delete { color: var(--color-danger-strong); }
  .diff-lines { font-family: var(--font-mono); font-size: 11px; max-height: 480px; overflow: auto; }
  .diff-lines:focus-visible { box-shadow: inset var(--shadow-focus); outline: none; }
  .line { display: grid; grid-template-columns: 42px 42px minmax(max-content, 1fr); min-width: max-content; }
  .line > span { background: var(--color-surface-soft); border-inline-end: 1px solid var(--color-border-soft); color: var(--color-ink-subtle); padding-inline: 8px; text-align: end; user-select: none; }
  .line code { color: var(--color-ink-muted); display: grid; grid-template-columns: 20px minmax(0, 1fr); white-space: pre; }
  .line i { font-style: normal; text-align: center; user-select: none; }
  .line.addition { background: var(--color-success-weak); } .line.deletion { background: var(--color-danger-weak); }
  .line.addition i { color: var(--color-success-strong); } .line.deletion i { color: var(--color-danger-strong); }
  .line.header { background: var(--color-info-soft); font-weight: 650; }
</style>
