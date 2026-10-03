<script lang="ts">
  import { enhance } from "$app/forms";
  import {
    AttentionQueue,
    Button,
    Dialog,
    EmptyState,
    Icon,
    PageHeader,
    RecoveryPanel,
    type AttentionQueueItem,
  } from "@zendev-lab/spark-ui";
  import { DialogClose, DialogDescription, DialogTitle } from "@zendev-lab/spark-ui/headless";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { workspacePath, workspaceSessionPath, workspaceSessionsPath } from "$lib/workspace-routes";

  let { data, form } = $props();

  let t = $derived(data.messages.home);
  let common = $derived(data.messages.common);
  let workspaces = $derived(data.workspaces);
  let daemons = $derived(data.daemons ?? []);
  let sourceAttentionItems = $derived(data.attentionItems ?? []);
  let selectedId = $state<string | null>(null);
  let selectedItem = $derived(sourceAttentionItems.find((item) => item.id === selectedId) ?? null);
  let queueItems = $derived(sourceAttentionItems.map(toQueueItem));
  let onlineCount = $derived(
    daemons.filter((daemon) => daemon.status === "online").length,
  );
  let offlineWorkspaces = $derived(
    workspaces.filter((workspace) => workspace.runtimeStatus !== "online"),
  );
  let pendingTotal = $derived(
    workspaces.reduce((sum, workspace) => sum + workspace.pendingInboxCount, 0),
  );

  let removeOpen = $state(false);
  let removeTarget = $state<(typeof workspaces)[number] | null>(null);
  let removePending = $state(false);
  let removeConfirmBody = $derived(
    t.workspaceHome.removeConfirmBody.replace("{name}", removeTarget?.name ?? ""),
  );

  $effect(() => {
    if (selectedId && sourceAttentionItems.some((item) => item.id === selectedId)) return;
    selectedId = sourceAttentionItems[0]?.id ?? null;
  });

  function formatRelative(value: string | null | undefined) {
    return formatRelativeTime(value ?? null, data.locale, common);
  }

  function statusLabel(status: string | null | undefined) {
    return getStatusLabel(status ?? "unavailable", common);
  }

  function workspaceHref(workspace: (typeof workspaces)[number]) {
    return workspaceSessionsPath(workspace);
  }

  function connectionLabel(workspace: (typeof workspaces)[number]) {
    return workspace.bindingName || t.workspaceHome.noConnection;
  }

  function itemHref(item: (typeof sourceAttentionItems)[number]) {
    const workspace = { slug: item.workspaceSlug };
    if (item.inboxItemId) return `${workspacePath(workspace)}/inbox/${item.inboxItemId}`;
    if (item.sessionId) return workspaceSessionPath(workspace, item.sessionId);
    return workspaceSessionsPath(workspace);
  }

  function itemAction(item: (typeof sourceAttentionItems)[number]) {
    if (item.kind === "inbox") return t.attention.reviewRequest;
    if (item.sessionId) return t.attention.openSession;
    return t.attention.inspectRun;
  }

  function selectedWorkspace() {
    if (!selectedItem) return null;
    return workspaces.find((workspace) => workspace.id === selectedItem?.workspaceId) ?? null;
  }

  function toQueueItem(item: (typeof sourceAttentionItems)[number]): AttentionQueueItem {
    return {
      id: item.id,
      group: item.group,
      title: item.title,
      context: item.workspaceName,
      detail: item.summary || (item.invocationId ? `${t.attention.invocation} ${item.invocationId}` : undefined),
      meta: formatRelative(item.updatedAt),
      statusLabel: statusLabel(item.status),
      tone:
        item.group === "needs-you"
          ? "warning"
          : item.group === "running"
            ? "running"
            : item.group === "failed"
              ? "danger"
              : "success",
      icon: item.group === "needs-you" ? "inbox" : item.group === "failed" ? "warning" : "activity",
      href: itemHref(item),
      actionLabel: itemAction(item),
    };
  }

  function openRemoveDialog(workspace: (typeof workspaces)[number]) {
    removeTarget = workspace;
    removeOpen = true;
  }

  function closeRemoveDialog() {
    if (removePending) return;
    removeOpen = false;
    removeTarget = null;
  }
</script>

{#snippet headerActions()}
  {#if daemons.length === 0}
    <Button href="/workspaces/new">
      <Icon name="plus" size={16} />
      {t.hero.setUpRunner}
    </Button>
  {:else}
    <Button variant="secondary" href="/settings/access">{t.workspaceHome.webAccess}</Button>
    <Button href="/workspaces/new">
      <Icon name="plus" size={16} />
      {t.hero.setUpRunner}
    </Button>
  {/if}
{/snippet}

{#snippet selectedActions()}
  {#if selectedItem}
    <Button href={itemHref(selectedItem)}>{itemAction(selectedItem)}</Button>
    {#if selectedItem.sessionId && selectedItem.kind === "inbox"}
      <Button
        variant="secondary"
        href={workspaceSessionPath({ slug: selectedItem.workspaceSlug }, selectedItem.sessionId)}
      >
        {t.attention.openSession}
      </Button>
    {/if}
  {/if}
{/snippet}

{#snippet selectedRecoveryActions()}
  {@const workspace = selectedWorkspace()}
  {#if workspace}
    <Button href={`${workspacePath(workspace)}/settings/registration`}>
      {t.workspaceHome.restoreConnection}
    </Button>
  {/if}
{/snippet}

{#snippet recoveryDiagnostics()}
  {#if selectedItem}
    <code>{selectedItem.workspaceSlug} · {selectedItem.runtimeStatus ?? "unavailable"}</code>
  {/if}
{/snippet}

{#snippet homeRecoveryActions()}
  {#if offlineWorkspaces[0]}
    <Button href={`${workspacePath(offlineWorkspaces[0])}/settings/registration`}>
      {t.workspaceHome.restoreConnection}
    </Button>
  {/if}
{/snippet}

{#snippet homeRecoveryDiagnostics()}
  <ul class="diagnostic-list">
    {#each offlineWorkspaces as workspace (workspace.id)}
      <li><code>{workspace.slug} · {workspace.runtimeStatus ?? "unavailable"}</code></li>
    {/each}
  </ul>
{/snippet}

<svelte:head>
  <title>Spark · {t.attention.title}</title>
</svelte:head>

<section class="attention-home" data-testid="attention-workbench">
  <PageHeader
    title={t.attention.title}
    lede={t.attention.lede}
    actions={offlineWorkspaces.length > 0 ? undefined : headerActions}
  />

  {#if form?.intent === "removeWorkspace" && form.message}
    <p class="flash" role="status">{form.message}</p>
  {/if}

  <div class="pulse-strip" aria-label={t.metrics.aria}>
    <span><strong>{pendingTotal}</strong>{t.attention.groups.needsYou}</span>
    <span><strong>{sourceAttentionItems.filter((item) => item.group === "running").length}</strong>{t.attention.groups.running}</span>
    <span><strong>{sourceAttentionItems.filter((item) => item.group === "failed").length}</strong>{t.attention.groups.failed}</span>
    <span><strong>{onlineCount}/{daemons.length}</strong>{t.metrics.runnerConnections}</span>
  </div>

  <div class="focus-pulse" class:has-attention={sourceAttentionItems.length > 0}>
    <section class="queue-pane">
      <AttentionQueue
        items={queueItems}
        labels={{
          ariaLabel: t.attention.queueAria,
          emptyTitle: offlineWorkspaces.length > 0
            ? t.attention.cachedQueueTitle
            : t.attention.allClearTitle,
          emptyBody: offlineWorkspaces.length > 0
            ? t.attention.cachedQueueBody
            : t.attention.allClearBody,
          groups: {
            "needs-you": t.attention.groups.needsYou,
            running: t.attention.groups.running,
            failed: t.attention.groups.failed,
            recent: t.attention.groups.recent,
          },
        }}
        {selectedId}
        detailRegionId="attention-detail-pane"
        onSelect={(id) => (selectedId = id)}
        emptyTone={offlineWorkspaces.length > 0 ? "warning" : "success"}
      />
    </section>

    <section class="detail-pane" id="attention-detail-pane" aria-label={t.attention.selectedRegion}>
      {#if selectedItem}
        <header class="detail-header">
          <div>
            <span class="status-dot {selectedItem.group}" aria-hidden="true"></span>
            <p>{selectedItem.workspaceName}</p>
            <h2 aria-live="polite">{selectedItem.title}</h2>
          </div>
          <span class="detail-status">{statusLabel(selectedItem.status)}</span>
        </header>

        {#if selectedItem.summary}<p class="detail-summary">{selectedItem.summary}</p>{/if}

        <dl class="detail-facts">
          <div><dt>{t.attention.workspace}</dt><dd>{selectedItem.workspaceName}</dd></div>
          <div><dt>{t.attention.session}</dt><dd>{selectedItem.sessionId ?? t.attention.noSession}</dd></div>
          <div><dt>{t.attention.invocation}</dt><dd>{selectedItem.invocationId ?? t.attention.noInvocation}</dd></div>
          <div><dt>{t.attention.updated}</dt><dd>{formatRelative(selectedItem.updatedAt)}</dd></div>
        </dl>

        {#if selectedItem.runtimeStatus !== "online"}
          <RecoveryPanel
            title={t.attention.offlineTitle}
            summary={t.attention.offlineBody}
            facts={[
              { label: t.attention.impact, value: t.attention.impactValue },
              { label: t.attention.freshness, value: formatRelative(selectedItem.updatedAt) },
            ]}
            actions={selectedRecoveryActions}
            diagnostics={recoveryDiagnostics}
            diagnosticsLabel={t.attention.diagnostics}
            embedded
          />
        {:else}
          <div class="detail-actions">{@render selectedActions()}</div>
        {/if}
      {:else if offlineWorkspaces.length > 0}
        <RecoveryPanel
          title={t.attention.offlineTitle}
          summary={t.attention.offlineBody}
          facts={[
            { label: t.attention.impact, value: t.attention.impactValue },
              { label: t.attention.connection, value: `${onlineCount}/${daemons.length}` },
          ]}
          actions={homeRecoveryActions}
          diagnostics={homeRecoveryDiagnostics}
          diagnosticsLabel={t.attention.diagnostics}
          embedded
        />
      {:else}
        <div class="detail-empty">
          <Icon name="waves" size={28} />
          <h2>{t.attention.selectTitle}</h2>
          <p>{t.attention.selectBody}</p>
        </div>
      {/if}
    </section>
  </div>

  <details class="workspace-directory-panel">
    <summary>
      <span>
        <strong>{t.attention.directoryTitle}</strong>
        <small>{t.attention.directoryBody}</small>
      </span>
      <span>{t.attention.showDirectory} · {workspaces.length}</span>
    </summary>

    {#if workspaces.length === 0}
      <EmptyState
        icon="activity"
        title={t.noWorkspaceHero.title}
        body={t.noWorkspaceHero.lede}
      >
        {#snippet actions()}<Button href="/workspaces/new">{t.hero.setUpRunner}</Button>{/snippet}
      </EmptyState>
    {:else}
      <ul class="workspace-list">
        {#each workspaces as workspace (workspace.id)}
          <li class="workspace-row">
            <a class="workspace-card" href={workspaceHref(workspace)}>
              <span class="group-icon"><Icon name="folder" size={18} /></span>
              <span class="card-copy">
                <strong>{workspace.name}</strong>
                <small>{connectionLabel(workspace)} · {statusLabel(workspace.runtimeStatus ?? workspace.bindingStatus)} · {formatRelative(workspace.updatedAt)}</small>
              </span>
              <span class="workspace-counts">
                {workspace.pendingInboxCount} {t.workspaceHome.pendingLabel} · {workspace.artifactCount} {t.workspaceHome.artifactsLabel}
              </span>
              <Icon name="chevron" size={18} />
            </a>
            <div class="row-actions">
              <Button variant="ghost" size="compact" href={`${workspacePath(workspace)}/settings/registration`}>
                {t.workspaceHome.connectionSettings}
              </Button>
              <Button
                variant="ghost"
                size="compact"
                ariaLabel={`${t.workspaceHome.removeWorkspace} ${workspace.name}`}
                onclick={() => openRemoveDialog(workspace)}
              >
                <Icon name="archive" size={14} />
                {t.workspaceHome.removeWorkspace}
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </details>
</section>

<Dialog
  bind:open={removeOpen}
  width="min(440px, calc(100vw - 32px))"
  maxHeight="min(420px, calc(100dvh - 32px))"
  describedBy="remove-workspace-description"
  onOpenChangeComplete={(open) => {
    if (!open) closeRemoveDialog();
  }}
>
  <div class="remove-dialog">
    <header class="remove-dialog-header">
      <div>
        <DialogTitle class="remove-dialog-title">{t.workspaceHome.removeConfirmTitle}</DialogTitle>
        <DialogDescription id="remove-workspace-description" class="remove-dialog-body">{removeConfirmBody}</DialogDescription>
      </div>
      <DialogClose class="remove-dialog-close" aria-label={t.workspaceHome.removeCancel}><Icon name="close" size={17} /></DialogClose>
    </header>
    <footer class="remove-dialog-footer">
      <Button variant="secondary" onclick={closeRemoveDialog} disabled={removePending}>{t.workspaceHome.removeCancel}</Button>
      {#if removeTarget}
        <form
          method="POST"
          action="?/removeWorkspace"
          use:enhance={() => {
            removePending = true;
            return async ({ update }) => {
              await update();
              removePending = false;
              removeOpen = false;
              removeTarget = null;
            };
          }}
        >
          <input type="hidden" name="workspaceId" value={removeTarget.id} />
          <Button variant="danger" type="submit" disabled={removePending}>{t.workspaceHome.removeConfirmAction}</Button>
        </form>
      {/if}
    </footer>
  </div>
</Dialog>

<style>
  .attention-home {
    display: grid;
    gap: var(--spacing-lg);
    margin: 0 auto;
    max-width: var(--layout-wide-max);
  }

  .flash {
    background: var(--color-success-weak);
    border: 1px solid color-mix(in srgb, var(--color-success) 28%, var(--color-border));
    border-radius: var(--rounded-md);
    color: var(--color-success-strong);
    font-size: var(--text-caption);
    margin: 0;
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .pulse-strip {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xl);
    padding: var(--spacing-sm) 0;
  }

  .pulse-strip span {
    align-items: baseline;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: var(--text-caption);
    gap: 6px;
  }

  .pulse-strip strong {
    color: var(--color-ink);
    font-size: var(--text-card-title);
    font-variant-numeric: tabular-nums;
  }

  .focus-pulse {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-card-raised);
    display: grid;
    grid-template-columns: minmax(320px, 0.78fr) minmax(420px, 1.22fr);
    min-height: 420px;
    overflow: hidden;
  }

  .focus-pulse.has-attention {
    min-height: min(660px, calc(100dvh - 250px));
  }

  .queue-pane {
    border-right: 1px solid var(--color-border);
    min-width: 0;
    overflow: auto;
    padding: var(--spacing-md) 0;
  }

  .detail-pane {
    align-content: start;
    display: grid;
    gap: var(--spacing-xl);
    min-width: 0;
    padding: var(--spacing-xxl);
  }

  .detail-header {
    align-items: start;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  .detail-header > div {
    display: grid;
    gap: 3px;
    min-width: 0;
    padding-left: var(--spacing-md);
    position: relative;
  }

  .status-dot {
    background: var(--color-ink-disabled);
    border-radius: var(--rounded-full);
    height: 8px;
    left: 0;
    position: absolute;
    top: 8px;
    width: 8px;
  }

  .status-dot.needs-you { background: var(--color-warning); }
  .status-dot.running { background: var(--color-info); }
  .status-dot.failed { background: var(--color-danger); }
  .status-dot.recent { background: var(--color-success); }

  .detail-header p,
  .detail-header h2,
  .detail-summary {
    margin: 0;
  }

  .detail-header p {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .detail-header h2 {
    font-size: clamp(1.35rem, 2vw, 1.75rem);
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .detail-status {
    background: var(--color-surface-muted);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    flex: 0 0 auto;
    font-size: var(--text-caption);
    font-weight: 650;
    padding: 6px 9px;
  }

  .detail-summary {
    color: var(--color-ink-muted);
    line-height: var(--leading-body);
    max-width: 68ch;
  }

  .detail-facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 0;
  }

  .detail-facts > div {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: 3px;
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-sm) 0;
  }

  .detail-facts dt {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .detail-facts dd {
    font-size: var(--text-caption);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .detail-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
  }

  .detail-empty {
    align-self: center;
    color: var(--color-ink-subtle);
    display: grid;
    justify-items: start;
    margin: auto;
    max-width: 46ch;
  }

  .detail-empty h2 {
    color: var(--color-ink);
    font-size: var(--text-section-title);
    margin: var(--spacing-md) 0 var(--spacing-xs);
  }

  .detail-empty p {
    margin: 0;
  }

  .diagnostic-list {
    margin: 0;
    padding-left: var(--spacing-lg);
  }

  .workspace-directory-panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    overflow: hidden;
  }

  .workspace-directory-panel > summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--spacing-xl);
    justify-content: space-between;
    list-style: none;
    min-height: var(--control-height-touch);
    padding: var(--spacing-md) var(--spacing-lg);
  }

  .workspace-directory-panel > summary::-webkit-details-marker { display: none; }
  .workspace-directory-panel > summary > span:first-child { display: grid; gap: 2px; }
  .workspace-directory-panel > summary small,
  .workspace-directory-panel > summary > span:last-child { color: var(--color-ink-subtle); font-size: var(--text-caption); }

  .workspace-list {
    border-top: 1px solid var(--color-border);
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .workspace-row {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    gap: var(--spacing-xs);
    padding: var(--spacing-md) var(--spacing-lg);
  }

  .workspace-row:first-child { border-top: 0; }

  .workspace-card {
    align-items: center;
    color: inherit;
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    text-decoration: none;
  }

  .group-icon {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    display: flex;
    height: 40px;
    justify-content: center;
    width: 40px;
  }

  .card-copy { display: grid; gap: 2px; min-width: 0; }
  .card-copy small,
  .workspace-counts { color: var(--color-ink-subtle); font-size: var(--text-caption); }
  .row-actions { display: flex; gap: var(--spacing-xs); margin-left: 56px; }

  .remove-dialog { display: grid; gap: var(--spacing-lg); padding: var(--spacing-xl); }
  .remove-dialog-header { align-items: start; display: flex; gap: var(--spacing-md); justify-content: space-between; }
  :global(.remove-dialog-title) { font-size: var(--text-section-title); font-weight: var(--weight-section-title); margin: 0; }
  :global(.remove-dialog-body) { color: var(--color-ink-subtle); margin: var(--spacing-xs) 0 0; }
  :global(.remove-dialog-close) { align-items: center; background: transparent; border: 0; border-radius: var(--rounded-md); color: var(--color-ink-muted); cursor: pointer; display: inline-flex; height: 32px; justify-content: center; width: 32px; }
  .remove-dialog-footer { display: flex; gap: var(--spacing-xs); justify-content: flex-end; }

  @media (max-width: 980px) {
    .focus-pulse { grid-template-columns: minmax(280px, 0.9fr) minmax(340px, 1.1fr); }
    .detail-pane { padding: var(--spacing-xl); }
  }

  @media (max-width: 760px) {
    .focus-pulse { display: block; min-height: 0; }
    .queue-pane { border-right: 0; max-height: 58dvh; }
    .detail-pane { border-top: 1px solid var(--color-border); min-height: 42dvh; padding: var(--spacing-lg); }
    .detail-facts { grid-template-columns: 1fr; }
    .workspace-card { grid-template-columns: auto minmax(0, 1fr) auto; }
    .workspace-counts { display: none; }
    .row-actions { margin-left: 0; }
  }
</style>
