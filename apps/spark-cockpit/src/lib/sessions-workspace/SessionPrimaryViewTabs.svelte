<script lang="ts">
  import { Icon } from "@zendev-lab/spark-ui";
  import type { SessionPrimaryView } from "$lib/session-work-view";

  let {
    selected,
    workLabel,
    transcriptLabel,
    ariaLabel,
    onSelect,
  }: {
    selected: SessionPrimaryView;
    workLabel: string;
    transcriptLabel: string;
    ariaLabel: string;
    onSelect: (view: SessionPrimaryView) => void;
  } = $props();

  const views: SessionPrimaryView[] = ["work", "transcript"];

  function handleKeydown(event: KeyboardEvent) {
    const currentIndex = views.indexOf(selected);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % views.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + views.length) % views.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = views.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    onSelect(views[nextIndex]!);
    const target = event.currentTarget as HTMLElement;
    target.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  }
</script>

<div class="primary-view-tabs" role="tablist" aria-label={ariaLabel}>
  <button
    id="session-work-tab"
    type="button"
    role="tab"
    aria-selected={selected === "work"}
    aria-controls="session-work-panel"
    tabindex={selected === "work" ? 0 : -1}
    onclick={() => onSelect("work")}
    onkeydown={handleKeydown}
  >
    <Icon name="activity" size={14} />
    {workLabel}
  </button>
  <button
    id="session-transcript-tab"
    type="button"
    role="tab"
    aria-selected={selected === "transcript"}
    aria-controls="session-transcript-panel"
    tabindex={selected === "transcript" ? 0 : -1}
    onclick={() => onSelect("transcript")}
    onkeydown={handleKeydown}
  >
    <Icon name="message" size={14} />
    {transcriptLabel}
  </button>
</div>

<style>
  .primary-view-tabs {
    align-items: center;
    align-self: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    display: inline-flex;
    flex: 0 0 auto;
    gap: 2px;
    padding: 3px;
  }

  button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-sm);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    gap: 6px;
    min-height: var(--control-height-compact);
    padding: 0 10px;
    transition:
      background var(--motion-fast) ease,
      color var(--motion-fast) ease;
  }

  button[aria-selected="true"] {
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
    color: var(--color-ink);
  }

  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  @media (pointer: coarse), (max-width: 640px) {
    button {
      min-height: var(--control-height-touch);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
