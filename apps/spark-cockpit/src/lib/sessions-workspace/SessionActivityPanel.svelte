<script lang="ts">
  import SessionQueue from "$lib/components/conversation/SessionQueue.svelte";
  import SessionStatusBar from "$lib/components/conversation/SessionStatusBar.svelte";
  import { Icon } from "@zendev-lab/spark-ui";
  import type { IconName } from "@zendev-lab/spark-ui";
  import type { SessionConversationHost } from "./conversation-host";

  let { host }: { host: SessionConversationHost } = $props();

  let hasActivity = $derived(
    Boolean(host.liveSessionView?.cwd) ||
      host.queueItems.length > 0 ||
      (host.liveSessionView?.drivers?.length ?? 0) > 0 ||
      Boolean(host.dequeueFeedback),
  );

  function driverIcon(status: string): IconName {
    if (status === "blocked" || status === "retry_wait") return "warning";
    if (status === "stopped") return "check";
    if (status === "running") return "play";
    return "activity";
  }
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

    {#if (host.liveSessionView?.drivers?.length ?? 0) > 0}
      <div class="driver-list" aria-label={host.copy.driversHeading}>
        {#each host.liveSessionView?.drivers ?? [] as driver (driver.driverId)}
          <article class="driver-row">
            <div class="driver-copy">
              <strong>{driver.kind}</strong>
              <code>{driver.driverId}</code>
              {#if driver.reason}<p>{driver.reason}</p>{/if}
            </div>
            <div class="driver-meta">
              <span
                class="driver-status {driver.status}"
                aria-label={`${driver.kind}: ${host.statusLabel(driver.status)}`}
              >
                <Icon name={driverIcon(driver.status)} size={12} />
                {host.statusLabel(driver.status)}
              </span>
              <span>{host.copy.driverAttempt} {driver.attempt}</span>
              {#if driver.dueAt}<span>{host.copy.due} {host.relative(driver.dueAt)}</span>{/if}
            </div>
          </article>
        {/each}
      </div>
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

  .driver-list {
    display: grid;
    gap: 6px;
  }

  .driver-row {
    align-items: start;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    display: grid;
    gap: 8px;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 8px;
  }

  .driver-copy,
  .driver-meta {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .driver-copy strong {
    color: var(--color-ink);
    font-size: 12px;
    text-transform: capitalize;
  }

  .driver-copy code,
  .driver-copy p,
  .driver-meta > span:not(.driver-status) {
    color: var(--color-ink-subtle);
    font-size: 10px;
    line-height: 1.4;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .driver-status {
    align-items: center;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 10px;
    font-weight: 650;
    gap: 4px;
    justify-self: end;
  }

  .driver-status.blocked,
  .driver-status.retry_wait {
    color: var(--color-warning-strong);
  }

  .driver-status.running {
    color: var(--color-primary);
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
    min-height: var(--control-height-compact);
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

  @media (pointer: coarse) {
    .queue-remove-button {
      min-height: var(--control-height-touch);
    }
  }
</style>
