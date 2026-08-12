<script lang="ts">
  import { contextUsagePercent } from "./chat-view";
  import type { ConversationContextUsageView } from "./chat-types";

  type Props = {
    view: ConversationContextUsageView;
    label: string;
    usedLabel: string;
  };

  let { view, label, usedLabel }: Props = $props();
  let percent = $derived(contextUsagePercent(view));
</script>

<div
  class="context-usage"
  role="meter"
  aria-label={label}
  aria-valuemin="0"
  aria-valuemax={view.limit}
  aria-valuenow={Math.min(view.used, view.limit)}
  title={`${usedLabel}: ${view.used} / ${view.limit}`}
>
  <span class="context-track" aria-hidden="true">
    <span class="context-fill" style={`--context-percent: ${percent}%`}></span>
  </span>
  <span>{Math.round(percent)}%</span>
</div>

<style>
  .context-usage {
    align-items: center;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 10px;
    gap: 6px;
    min-height: 28px;
  }

  .context-track {
    background: var(--color-surface-muted);
    border-radius: var(--rounded-full);
    display: block;
    height: 4px;
    overflow: hidden;
    width: 46px;
  }

  .context-fill {
    background: var(--color-primary);
    display: block;
    height: 100%;
    width: var(--context-percent);
  }
</style>
