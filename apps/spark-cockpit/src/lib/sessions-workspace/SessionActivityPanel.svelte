<script lang="ts">
  import SessionQueue from "$lib/components/conversation/SessionQueue.svelte";
  import SessionStatusBar from "$lib/components/conversation/SessionStatusBar.svelte";
  import Icon from "$lib/Icon.svelte";
  import type { SessionConversationHost } from "./conversation-host";

  let { host }: { host: SessionConversationHost } = $props();

  let hasActivity = $derived(
    Boolean(host.liveSessionView?.cwd) ||
      host.queueItems.length > 0 ||
      Boolean(host.dequeueFeedback),
  );
</script>

{#if hasActivity}
  <section class="session-activity-panel" aria-label={host.copy.activityAndQueue}>
    <div class="activity-heading">
      <span><Icon name="activity" size={14} />{host.copy.activityAndQueue}</span>
      {#if host.queueItems.length > 0}
        <span class="queue-count">{host.queueItems.length}</span>
      {/if}
    </div>

    {#if host.liveSessionView?.cwd}
      <SessionStatusBar
        labels={host.statusBarLabels}
        cwd={host.compactWorkingDirectory(host.liveSessionView.cwd)}
        gitBranch={host.liveSessionView.gitBranch}
        inputTokens={host.runtimeStatusUsage.inputTokens}
        outputTokens={host.runtimeStatusUsage.outputTokens}
        cacheReadTokens={host.runtimeStatusUsage.cacheReadTokens}
        cacheWriteTokens={host.runtimeStatusUsage.cacheWriteTokens}
        costUsd={host.runtimeStatusUsage.costUsd}
        latestCacheHitPercent={host.runtimeStatusUsage.latestCacheHitPercent}
        contextTokens={host.runtimeStatusUsage.contextTokens}
        contextWindow={host.runtimeStatusUsage.contextWindow}
      />
    {/if}

    <SessionQueue
      items={host.queueItems}
      labels={host.queueLabels}
      hasRunningTurn={host.conversationBusy}
    >
      {#snippet actions(item)}
        <button
          class="queue-remove-button"
          type="submit"
          form={host.queueRemoveFormId(item.id)}
          disabled={host.dequeueState === "submitting"}
          aria-label={`${host.copy.removeQueued}: ${item.text}`}
          title={host.copy.removeQueued}
        >
          <Icon name="close" size={13} stroke={2.2} />
          <span>
            {host.dequeuingTurnId === item.id && host.dequeueState === "submitting"
              ? host.copy.removingQueued
              : host.copy.removeQueued}
          </span>
        </button>
      {/snippet}
    </SessionQueue>

    {#if host.dequeueFeedback}
      <p
        class="activity-feedback {host.dequeueState}"
        role={host.dequeueState === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {host.dequeueFeedback}
      </p>
    {/if}
  </section>
{/if}

<style>
  .session-activity-panel {
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  .activity-heading {
    align-items: center;
    color: var(--color-ink-muted);
    display: flex;
    font-size: 11px;
    font-weight: 700;
    justify-content: space-between;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .activity-heading > span:first-child {
    align-items: center;
    display: inline-flex;
    gap: 6px;
  }

  .queue-count {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    display: inline-flex;
    font-size: 10px;
    height: 20px;
    justify-content: center;
    min-width: 20px;
    padding: 0 6px;
  }

  .queue-remove-button {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-sm);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    gap: 4px;
    min-height: 26px;
    padding: 3px 7px;
    white-space: nowrap;
  }

  .queue-remove-button:hover:not(:disabled) {
    background: var(--color-surface);
    border-color: var(--color-danger-soft, var(--color-border));
    color: var(--color-danger);
  }

  .queue-remove-button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .queue-remove-button:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .activity-feedback {
    color: var(--color-success);
    font-size: 11px;
    line-height: 1.45;
    margin: 0;
  }

  .activity-feedback.error {
    color: var(--color-danger);
  }
</style>
