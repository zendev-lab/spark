<script lang="ts">
  import Icon from "../Icon.svelte";
  import type { FileTreeEntryView } from "./types";

  type Props = {
    entries: readonly FileTreeEntryView[];
    label: string;
    onSelect?: (entry: FileTreeEntryView) => void;
    onToggle?: (entry: FileTreeEntryView) => void;
  };
  let { entries, label, onSelect, onToggle }: Props = $props();
  let treeElement = $state<HTMLDivElement | null>(null);
  let focusedId = $state<string | undefined>();
  let activeFocusId = $derived(
    entries.some((entry) => entry.id === focusedId && !entry.disabled)
      ? focusedId
      : entries.find((entry) => entry.selected && !entry.disabled)?.id ??
          entries.find((entry) => !entry.disabled)?.id,
  );

  function activate(entry: FileTreeEntryView) {
    if (entry.disabled) return;
    if (entry.kind === "directory") onToggle?.(entry);
    else onSelect?.(entry);
  }

  function focusAt(index: number) {
    const entry = entries[index];
    if (!entry || entry.disabled) return;
    focusedId = entry.id;
    queueMicrotask(() => {
      treeElement
        ?.querySelector<HTMLButtonElement>(`[data-tree-index="${index}"]`)
        ?.focus();
    });
  }

  function moveFocus(index: number, direction: -1 | 1) {
    let nextIndex = index + direction;
    while (nextIndex >= 0 && nextIndex < entries.length) {
      if (!entries[nextIndex]?.disabled) {
        focusAt(nextIndex);
        return;
      }
      nextIndex += direction;
    }
  }

  function focusBoundary(boundary: "first" | "last") {
    const index = boundary === "first"
      ? entries.findIndex((entry) => !entry.disabled)
      : entries.findLastIndex((entry) => !entry.disabled);
    if (index >= 0) focusAt(index);
  }

  function handleKeydown(event: KeyboardEvent, entry: FileTreeEntryView, index: number) {
    if (entry.disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index, 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index, -1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusBoundary("first");
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusBoundary("last");
      return;
    }
    if (event.key === "ArrowRight" && entry.kind === "directory") {
      event.preventDefault();
      if (!entry.expanded) {
        onToggle?.(entry);
        return;
      }
      const childIndex = entries.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && candidate.depth === entry.depth + 1 && !candidate.disabled,
      );
      if (childIndex >= 0) focusAt(childIndex);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (entry.kind === "directory" && entry.expanded) {
        event.preventDefault();
        onToggle?.(entry);
        return;
      }
      const parentIndex = entries.findLastIndex(
        (candidate, candidateIndex) =>
          candidateIndex < index && candidate.depth < entry.depth && !candidate.disabled,
      );
      if (parentIndex >= 0) {
        event.preventDefault();
        focusAt(parentIndex);
      }
    }
  }
</script>

<div class="file-tree" role="tree" aria-label={label} bind:this={treeElement}>
  {#each entries as entry, index (entry.id)}
    <button
      type="button"
      role="treeitem"
      data-tree-index={index}
      aria-level={entry.depth + 1}
      aria-expanded={entry.kind === "directory" ? (entry.expanded ?? false) : undefined}
      aria-selected={entry.selected ?? false}
      aria-disabled={entry.disabled || undefined}
      disabled={entry.disabled}
      tabindex={entry.id === activeFocusId ? 0 : -1}
      style={`--tree-depth: ${entry.depth}`}
      onfocus={() => (focusedId = entry.id)}
      onkeydown={(event) => handleKeydown(event, entry, index)}
      onclick={() => activate(entry)}
    >
      {#if entry.kind === "directory"}<Icon name="chevron" size={12} />{/if}
      <Icon name={entry.kind === "directory" ? "folder" : "file"} size={14} />
      <span>{entry.name}</span>
    </button>
  {/each}
</div>

<style>
  .file-tree { border: 1px solid var(--color-border); border-radius: var(--rounded-lg); display: grid; overflow: hidden; padding-block: 5px; }
  button { align-items: center; background: transparent; border: 0; color: var(--color-ink-muted); cursor: pointer; display: grid; font: inherit; font-size: 12px; gap: 6px; grid-template-columns: 14px 16px minmax(0, 1fr); min-height: 30px; padding-inline: calc(8px + var(--tree-depth) * 16px) 8px; text-align: start; }
  button:hover:not(:disabled) { background: var(--color-surface-soft); color: var(--color-ink); }
  button[aria-selected="true"] { background: var(--color-primary-weak); color: var(--color-primary); }
  button:focus-visible { box-shadow: inset var(--shadow-focus); outline: none; }
  button:disabled { cursor: not-allowed; opacity: .5; }
  button[aria-expanded="true"] :global(svg:first-child) { transform: rotate(90deg); }
</style>
