<script lang="ts">
  import SessionInspector from "$lib/SessionInspector.svelte";
  import { Icon } from "@zendev-lab/spark-ui";
  import { visibleSessionStatus } from "$lib/conversation-status";
  import type { SessionInspectorLabels, SessionWorkbenchView } from "$lib/session-workbench";
  import type { SessionRecord, SessionsMessages } from "./types";

  type Props = {
    selected: SessionRecord;
    compact?: boolean;
    messages: SessionsMessages;
    statusLabel: (status: string) => string;
    sessionScopeLabel: string;
    selectedWorkspaceHref: string | null;
    selectedIsChannelSession: boolean;
    selectedChannelBindings: Array<{ adapter?: string; externalKey?: string }>;
    selectedChannelsSettingsHref: string | null;
    workbenchView: SessionWorkbenchView | null;
    inspectorLabels: SessionInspectorLabels;
    instanceId: string;
  };

  let {
    selected,
    compact = false,
    messages,
    statusLabel,
    sessionScopeLabel,
    selectedWorkspaceHref,
    selectedIsChannelSession,
    selectedChannelBindings,
    selectedChannelsSettingsHref,
    workbenchView,
    inspectorLabels,
    instanceId,
  }: Props = $props();

  let displayedSessionStatus = $derived(
    visibleSessionStatus(selected.placement === "archived" ? "archived" : (selected.activity ?? "idle")),
  );
  let taskExecution = $derived(selected.owner.kind === "task_run" ? selected.owner : null);
  let explicitRoleRef = $derived(
    selected.roleBinding.kind === "explicit" ? selected.roleBinding.roleRef : null,
  );
</script>

<div
  class:compact-details={compact}
  class="details-content"
  data-session-inspector-surface
  tabindex="-1"
>
  <dl class="details-grid">
    {#if displayedSessionStatus}
      <div>
        <dt>{messages.statusLabel}</dt>
        <dd>
          <span class="status-pill {displayedSessionStatus}">{statusLabel(displayedSessionStatus)}</span>
        </dd>
      </div>
    {/if}
    <div>
      <dt>{messages.workspaceLabel}</dt>
      <dd>
        {#if selectedWorkspaceHref}
          <a href={selectedWorkspaceHref}>{sessionScopeLabel}</a>
        {:else}
          {sessionScopeLabel}
        {/if}
      </dd>
    </div>
    {#if explicitRoleRef}
      <div>
        <dt>{messages.roleLabel}</dt>
        <dd>{explicitRoleRef}</dd>
      </div>
    {/if}
    {#if taskExecution}
      <div class="task-execution-card" data-task-execution-binding>
        <dt>{messages.taskExecutionTitle}</dt>
        <dd>
          <dl class="task-execution-grid">
            <div>
              <dt>{messages.projectLabel}</dt>
              <dd><code>{taskExecution.projectRef}</code></dd>
            </div>
            <div>
              <dt>{messages.taskLabel}</dt>
              <dd><code>{taskExecution.taskRef}</code></dd>
            </div>
            {#if taskExecution.subgoalRef}
              <div>
                <dt>{messages.subgoalLabel}</dt>
                <dd><code>{taskExecution.subgoalRef}</code></dd>
              </div>
            {/if}
            <div>
              <dt>{messages.sessionGoalLabel}</dt>
              <dd><code>{taskExecution.sessionGoalId}</code></dd>
            </div>
            <div>
              <dt>{messages.taskRunLabel}</dt>
              <dd><code>{taskExecution.runRef}</code></dd>
            </div>
            <div>
              <dt>{messages.attemptLabel}</dt>
              <dd>{taskExecution.attempt}</dd>
            </div>
            <div class="task-execution-evidence">
              <dt>{messages.taskEvidenceLabel}</dt>
              <dd>{messages.evidenceInWorkbench}</dd>
            </div>
          </dl>
        </dd>
      </div>
    {/if}
    {#if selectedIsChannelSession}
      <div>
        <dt>{messages.channelSessionBadge}</dt>
        <dd>
          <span class="channel-badge">{messages.channelSessionKicker}</span>
        </dd>
      </div>
      {#if selectedChannelBindings.length > 0}
        <div>
          <dt>{messages.channelBindingLabel}</dt>
          <dd class="channel-bindings">
            {#each selectedChannelBindings as binding (binding.externalKey ?? binding.adapter)}
              <code>{binding.externalKey ?? binding.adapter}</code>
            {/each}
          </dd>
        </div>
      {/if}
      {#if selectedChannelsSettingsHref}
        <div class="channel-settings-row">
          <a class="channel-settings-link" href={selectedChannelsSettingsHref}>
            <Icon name="settings" size={14} />
            {messages.openChannelSettings}
          </a>
          <p class="muted">{messages.channelRoutingBody}</p>
        </div>
      {/if}
    {/if}
  </dl>

  {#if workbenchView}
    <SessionInspector view={workbenchView} labels={inspectorLabels} {instanceId} {statusLabel} />
  {/if}
</div>

<style>
  .details-content {
    display: grid;
    gap: 20px;
  }

  .details-grid {
    display: grid;
    gap: 14px;
    margin: 0;
  }

  .details-grid div {
    display: grid;
    gap: 5px;
  }

  .details-grid dt {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .details-grid dd {
    color: var(--color-ink-muted);
    font-size: 13px;
    margin: 0;
    min-width: 0;
  }

  .task-execution-card {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--rounded-md, 8px);
    padding: 12px;
  }

  .task-execution-grid {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .task-execution-grid > div {
    gap: 3px;
  }

  .task-execution-grid code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .task-execution-evidence {
    border-top: 1px solid var(--color-border-subtle);
    padding-top: 9px;
  }

  .details-grid a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .channel-badge {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    border-radius: 999px;
    color: var(--color-primary);
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
    padding: 5px 8px;
    text-transform: none;
    white-space: nowrap;
  }

  .channel-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md, 8px);
    color: var(--color-ink);
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    gap: 5px;
    padding: 6px 10px;
    text-decoration: none;
    white-space: nowrap;
  }

  .channel-settings-link:hover {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .channel-bindings {
    display: grid;
    gap: 4px;
  }

  .channel-bindings code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
  }

  .channel-settings-row {
    display: grid;
    gap: 6px;
    grid-column: 1 / -1;
  }

  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
  }

  .status-pill {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
    padding: 4px 7px;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .status-pill.running,
  .status-pill.ready,
  .status-pill.queued,
  .status-pill.acked {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.completed,
  .status-pill.success,
  .status-pill.delivered {
    background: var(--color-success-weak, #ecfdf5);
    color: var(--color-success-strong, #047857);
  }

  .status-pill.failed,
  .status-pill.error,
  .status-pill.rejected {
    background: var(--color-danger-weak, #fef2f2);
    color: var(--color-danger-strong, #b91c1c);
  }

  .status-pill.archived,
  .status-pill.cancelled {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong, var(--color-warning));
  }
</style>
