<script lang="ts">
  import { Icon } from "@zendev-lab/spark-ui";
  import ReproTokenUsage from "./ReproTokenUsage.svelte";
  import ReproWorkbench from "./ReproWorkbench.svelte";
  import {
    primarySessionLoop,
    sessionHasProjectedWork,
    sessionWorkObjective,
    sessionWorkStatus,
  } from "$lib/session-work-view";
  import type { IconName } from "@zendev-lab/spark-ui";
  import type { SessionConversationHost } from "./conversation-host";

  let { host }: { host: SessionConversationHost } = $props();

  let session = $derived(host.liveSessionView);
  let work = $derived(session?.work);
  let repro = $derived(work?.repro);
  let goal = $derived(work?.goal);
  let loop = $derived(primarySessionLoop(session));
  let semanticStatus = $derived(sessionWorkStatus(session));
  let objective = $derived(sessionWorkObjective(session));
  let checkpoint = $derived(repro?.checkpoint);
  let statusIcon = $derived.by((): IconName => {
    if (semanticStatus === "blocked" || semanticStatus === "retry_wait") return "warning";
    if (semanticStatus === "complete") return "check";
    if (semanticStatus === "stopped") return "close";
    if (semanticStatus === "running") return "play";
    return "activity";
  });
</script>

<section class="work-view" aria-labelledby="session-work-heading">
  {#if sessionHasProjectedWork(session) || (session?.loops?.length ?? 0) > 0}
    <header class="work-hero">
      <div>
        <p class="work-kicker">
          {repro ? host.copy.reproMode : goal ? host.copy.goalMode : host.copy.loopMode}
        </p>
        <h2 id="session-work-heading">{objective ?? host.copy.currentWork}</h2>
      </div>
      {#if semanticStatus}
        <span
          class="semantic-status {semanticStatus}"
          role="status"
          aria-label={`${host.copy.semanticStatus}: ${host.statusLabel(semanticStatus)}`}
        >
          <Icon name={statusIcon} size={14} stroke={2.1} />
          {host.statusLabel(semanticStatus)}
        </span>
      {/if}
    </header>

    <div class="work-grid">
      {#if repro}
        {#if repro.workbench}
          <div class="workbench-surface">
            <ReproWorkbench
              sessionId={session!.sessionId}
              binding={repro.workbench}
              labels={{
                aria: host.copy.reproWorkbenchAria,
                loading: host.copy.reproWorkbenchLoading,
                syncing: host.copy.reproWorkbenchSyncing,
                pendingTitle: host.copy.reproWorkbenchPendingTitle,
                pendingBody: host.copy.reproWorkbenchPendingBody,
                unavailable: host.copy.reproWorkbenchUnavailable,
                retry: host.copy.retryTurn,
              }}
            />
          </div>
        {/if}
        <article class="work-card current-step">
          <p class="field-label">{host.copy.currentStep}</p>
          {#if checkpoint}
            <h3>{checkpoint.kind}</h3>
            <p class="step-meta">
              {checkpoint.status} · {host.copy.stepProgress
                .replace("{done}", String(repro.progress.accepted))
                .replace("{total}", String(repro.progress.total))}
            </p>
            {#if checkpoint.summary}
              <div class="field-block">
                <p class="field-label">Summary</p>
                <p>{checkpoint.summary}</p>
              </div>
            {/if}
            {#if checkpoint.evidenceRefs.length > 0}
              <div class="field-block">
                <p class="field-label">{host.copy.evidenceReferences}</p>
                <div class="evidence-refs">
                  {#each checkpoint.evidenceRefs as reference}
                    <code>{reference}</code>
                  {/each}
                </div>
              </div>
            {/if}
            {#if checkpoint.attention}
              <div class="blocker" role="status">
                <Icon name="warning" size={15} />
                <div>
                  <p class="field-label">{host.copy.blocker}</p>
                  <p>{checkpoint.attention.question}</p>
                </div>
              </div>
            {/if}
          {:else}
            <h3>{host.copy.noCurrentStep}</h3>
            <p class="step-meta">{repro.status}</p>
          {/if}
        </article>

        <aside class="work-card work-context">
          <dl>
            <div>
              <dt>Checkpoints</dt>
              <dd>{repro.progress.accepted}/{repro.progress.total}</dd>
            </div>
            <div>
              <dt>Implementation</dt>
              <dd><code>{repro.lanes.implementation.sessionId}</code></dd>
            </div>
            <div>
              <dt>Exactness</dt>
              <dd><code>{repro.lanes.exactness.sessionId}</code></dd>
            </div>
            <div>
              <dt>Formalize</dt>
              <dd><code>{repro.lanes.formalize.sessionId}</code></dd>
            </div>
            {#if repro.formalizedRevision}
              <div>
                <dt>Formalized revision</dt>
                <dd><code>{repro.formalizedRevision}</code></dd>
              </div>
            {/if}
            {#if repro.blockingReason}
              <div>
                <dt>{host.copy.blocker}</dt>
                <dd>{repro.blockingReason}</dd>
              </div>
            {/if}
          </dl>
        </aside>

        {#if repro.tokenUsage}
          <ReproTokenUsage
            usage={repro.tokenUsage}
            usageByPersistence={repro.tokenUsageByPersistence}
            locale={host.locale}
            labels={{
              title: host.copy.reproTokenUsage,
              reported: host.copy.reportedTokens,
              estimated: host.copy.estimatedTokens,
              missingResponses: host.copy.missingResponses,
              coverageGaps: host.copy.coverageGaps,
              activeExecutions: host.copy.activeExecutions,
              lowerBound: host.copy.lowerBound,
              breakdown: host.copy.tokenBreakdown,
              executionKinds: host.copy.executionKinds,
              models: host.copy.models,
              persistence: host.copy.executionPersistence,
              anonymousSessions: host.copy.anonymousSessions,
              persistentSessions: host.copy.persistentSessions,
              responses: host.copy.responses,
              noBreakdown: host.copy.noTokenBreakdown,
              unknownUsage: host.copy.unknownTokenUsage,
            }}
          />
        {/if}
      {:else if goal}
        <article class="work-card current-step">
          <p class="field-label">{host.copy.objective}</p>
          <h3>{goal.objective}</h3>
          {#if goal.reason}
            <div class="field-block">
              <p class="field-label">{host.copy.reason}</p>
              <p>{goal.reason}</p>
            </div>
          {/if}
        </article>
      {:else}
        <article class="work-card current-step">
          <p class="field-label">{host.copy.loopMode}</p>
          <h3>{loop ? host.statusLabel(loop.status) : host.copy.currentWork}</h3>
          {#if loop?.reason}<p>{loop.reason}</p>{/if}
        </article>
      {/if}
    </div>
  {:else}
    <div class="work-empty">
      <span><Icon name="activity" size={20} /></span>
      <h2 id="session-work-heading">{host.copy.noActiveWork}</h2>
      <p>{host.copy.noActiveWorkBody}</p>
    </div>
  {/if}
</section>

<style>
  .work-view {
    align-self: center;
    display: grid;
    gap: var(--spacing-md);
    margin: auto;
    max-width: 960px;
    overflow-y: auto;
    padding: var(--spacing-md) var(--spacing-lg) var(--spacing-xl);
    width: 100%;
  }

  .work-hero {
    align-items: start;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  .work-kicker,
  .field-label {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    margin: 0;
    text-transform: uppercase;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: var(--color-ink);
    font-size: 22px;
    line-height: 1.3;
    margin-top: 4px;
  }

  h3 {
    color: var(--color-ink);
    font-size: 16px;
    line-height: 1.45;
  }

  .semantic-status {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    gap: 6px;
    min-height: var(--control-height-compact);
    padding: 0 10px;
    white-space: nowrap;
  }

  .semantic-status.running,
  .semantic-status.scheduled,
  .semantic-status.active {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .semantic-status.blocked,
  .semantic-status.retry_wait {
    background: var(--color-warning-weak);
    border-color: var(--color-warning-soft);
    color: var(--color-warning-strong);
  }

  .semantic-status.complete {
    background: var(--color-success-weak);
    border-color: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .work-grid {
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: minmax(0, 1.6fr) minmax(220px, 0.8fr);
  }

  .work-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-card);
    min-width: 0;
    padding: var(--spacing-md);
  }

  .workbench-surface {
    grid-column: 1 / -1;
    min-width: 0;
  }

  .current-step {
    display: grid;
    gap: 10px;
  }

  .step-meta,
  .field-block,
  .work-context dd {
    color: var(--color-ink-muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .field-block {
    display: grid;
    gap: 5px;
    margin-top: 4px;
  }

  .blocker {
    align-items: start;
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: var(--rounded-md);
    color: var(--color-warning-strong);
    display: flex;
    gap: 8px;
    padding: 10px;
  }

  .blocker p:last-child {
    font-size: 13px;
    line-height: 1.5;
    margin-top: 3px;
  }

  .work-context dl {
    display: grid;
    gap: 12px;
    margin: 0;
  }

  .work-context div {
    display: grid;
    gap: 3px;
  }

  .work-context dt {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .work-context dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .verification-receipt {
    display: grid;
    gap: 10px;
    grid-column: 1 / -1;
  }

  .receipt-heading {
    align-items: center;
    color: var(--color-success-strong);
    display: flex;
    gap: 8px;
  }

  .receipt-kind {
    color: var(--color-ink-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .evidence-refs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .evidence-refs code {
    background: var(--color-surface-soft);
    border-radius: var(--rounded-sm);
    color: var(--color-ink-muted);
    font-size: 11px;
    padding: 4px 6px;
  }

  .work-empty {
    align-items: center;
    color: var(--color-ink-subtle);
    display: grid;
    gap: 8px;
    justify-items: center;
    min-height: 240px;
    text-align: center;
  }

  .work-empty span {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: var(--rounded-lg);
    display: inline-flex;
    height: 44px;
    justify-content: center;
    width: 44px;
  }

  @media (max-width: 760px) {
    .work-view {
      padding: var(--spacing-sm);
    }

    .work-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .verification-receipt {
      grid-column: auto;
    }
  }
</style>
