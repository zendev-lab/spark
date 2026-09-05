<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    Button,
    Field,
    Icon,
    Input,
    Notice,
    RecoveryPanel,
    Select,
    StatusPill,
    type SelectGroup,
  } from "@zendev-lab/spark-ui";
  import { Composer } from "@zendev-lab/spark-ui/conversation";
  import {
    ordinaryDaemonSessions,
    sessionWorkspaceId,
    workspaceAdministratorSessionId,
    type SparkWebSession,
  } from "$lib/daemon-surface";
  import { sparkWebTurnMessageMetadata } from "$lib/memory-feedback";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let copy = $derived(data.messages.web.home);
  let prompt = $state("");
  let selectedWorkspaceId = $state("");
  let starting = $state(false);
  let startError = $state("");
  let createdSessionId = $state<string | null>(null);
  let startAttempt: { workspaceId: string; message: string; idempotencyKey: string } | null = null;
  let localPath = $state("");
  let displayName = $state("");
  let registering = $state(false);
  let registerError = $state("");

  const sessions = $derived(
    ordinaryDaemonSessions(data.sessions as SparkWebSession[]).slice(0, 8),
  );
  const workspaceById = $derived(
    new Map(data.workspaces.map((workspace) => [workspace.id, workspace])),
  );
  const waitingSessionIds = $derived(new Set(data.waits.map((wait) => wait.sessionId)));
  const workspaceGroups = $derived<SelectGroup[]>([
    {
      id: "workspaces",
      options: data.workspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.displayName,
        description: workspace.localPath,
      })),
    },
  ]);
  const selectedWorkspace = $derived(workspaceById.get(selectedWorkspaceId) ?? null);

  $effect(() => {
    if (!localPath) localPath = data.launchCwd;
  });

  $effect(() => {
    if (selectedWorkspaceId && workspaceById.has(selectedWorkspaceId)) return;
    selectedWorkspaceId = data.cwdWorkspaceId ?? data.workspaces[0]?.id ?? "";
  });

  function workspaceLabel(session: SparkWebSession): string {
    const workspaceId = sessionWorkspaceId(session);
    if (!workspaceId) return copy.generalContext;
    return workspaceById.get(workspaceId)?.displayName ?? workspaceId;
  }

  function statusLabel(session: SparkWebSession): string {
    if (waitingSessionIds.has(session.sessionId)) return copy.needsYou;
    const status = session.activity ?? "idle";
    return data.messages.shared.status[status] ?? status;
  }

  function conversationName(value: string): string {
    const firstLine = value.split(/\r?\n/u, 1)[0]?.trim() ?? "";
    return firstLine.length > 56 ? `${firstLine.slice(0, 55).trimEnd()}…` : firstLine;
  }

  async function startConversation(event: SubmitEvent) {
    event.preventDefault();
    const message = prompt.trim();
    const workspaceId = selectedWorkspaceId;
    if (!message || !workspaceId || starting) return;

    const supervisorSessionId = workspaceAdministratorSessionId(
      data.sessions as SparkWebSession[],
      workspaceId,
    );
    if (!supervisorSessionId) {
      startError = copy.missingAdministrator;
      return;
    }

    starting = true;
    startError = "";
    if (startAttempt?.workspaceId !== workspaceId || startAttempt.message !== message) {
      createdSessionId = null;
      startAttempt = { workspaceId, message, idempotencyKey: crypto.randomUUID() };
    }
    try {
      if (!createdSessionId) {
        const created = await webRpc("session.create", {
          scope: { kind: "workspace", workspaceId },
          supervisorSessionId,
          placement: "child",
          roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
          name: conversationName(message),
        });
        createdSessionId = created.sessionId;
      }
      const sessionId = createdSessionId;
      try {
        await webRpc("turn.submit", {
          sessionId,
          idempotencyKey: startAttempt.idempotencyKey,
          prompt: message,
          messageMetadata: sparkWebTurnMessageMetadata(),
        });
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        startError = `${copy.firstMessageFailed}: ${detail}`;
        return;
      }
      try {
        await goto(`/sessions/${encodeURIComponent(sessionId)}`);
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        startError = `${copy.navigationFailed}: ${detail}`;
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      startError = `${copy.createFailed}: ${detail}`;
    } finally {
      starting = false;
    }
  }

  async function registerWorkspace(event: SubmitEvent) {
    event.preventDefault();
    const path = localPath.trim();
    if (!path) {
      registerError = copy.localPathRequired;
      return;
    }
    registering = true;
    registerError = "";
    try {
      const name = displayName.trim();
      const created = await webRpc("workspace.register", {
        localPath: path,
        ...(name ? { displayName: name } : {}),
      });
      await goto(`/workspaces/${created.id}`);
    } catch (caught) {
      registerError = caught instanceof Error ? caught.message : String(caught);
    } finally {
      registering = false;
    }
  }
</script>

{#snippet composerHeader()}
  <div class="composer-scope">
    <span><Icon name="workspace" size={14} />{copy.workspace}</span>
    {#if data.workspaces.length > 1}
      <Select
        id="conversation-workspace"
        value={selectedWorkspaceId}
        groups={workspaceGroups}
        label={copy.chooseWorkspace}
        compact
        fit
        onValueChange={(value) => (selectedWorkspaceId = value)}
      />
    {:else}
      <strong>{selectedWorkspace?.displayName ?? copy.noWorkspace}</strong>
    {/if}
  </div>
{/snippet}

{#snippet recoveryActions()}
  <Button href="/settings">{copy.openSettings}</Button>
{/snippet}

{#snippet recoveryDiagnostics()}
  <ul class="diagnostic-list">
    {#each data.artifactUnavailableWorkspaceIds as workspaceId}
      <li><code>{workspaceById.get(workspaceId)?.displayName ?? workspaceId}</code></li>
    {/each}
  </ul>
{/snippet}

<svelte:head><title>{copy.title} · Spark</title></svelte:head>

<section class="conversation-home">
  <div class="conversation-intro">
    <span class="spark-mark" aria-hidden="true"><Icon name="spark" size={24} stroke={1.9} /></span>
    <h1>{copy.title}</h1>
    <p>{copy.lede}</p>
  </div>

  <form class="conversation-start" onsubmit={(event) => void startConversation(event)}>
    <Composer
      id="spark-web-first-message"
      bind:value={prompt}
      rows={4}
      placeholder={data.workspaces.length > 0 ? copy.prompt : copy.noWorkspacePrompt}
      submitLabel={copy.send}
      submittingLabel={copy.sending}
      ariaLabel={copy.promptLabel}
      multilineHint={copy.sendHint}
      disabled={data.workspaces.length === 0 || starting}
      submitDisabled={!prompt.trim() || !selectedWorkspaceId}
      submitting={starting}
      header={composerHeader}
    />
  </form>

  {#if startError}
    <div class="start-feedback">
      <Notice tone="danger" message={startError} />
      {#if createdSessionId}
        <Button variant="secondary" href={`/sessions/${encodeURIComponent(createdSessionId)}`}>
          {copy.openCreatedSession}
        </Button>
      {/if}
    </div>
  {/if}

  {#if data.waits.length > 0}
    <a class="conversation-attention" href={`/sessions/${encodeURIComponent(data.waits[0].sessionId)}`}>
      <Icon name="inbox" size={17} />
      <span><strong>{copy.needsYou}</strong>{copy.waitingSummary.replace("{count}", String(data.waits.length))}</span>
      <Icon name="arrow-right" size={15} />
    </a>
  {/if}

  <section class="recent-conversations" aria-labelledby="recent-conversations-title">
    <header>
      <div>
        <h2 id="recent-conversations-title">{copy.recentTitle}</h2>
        <p>{copy.recentBody}</p>
      </div>
      <a href="/sessions">{copy.allSessions}<Icon name="arrow-right" size={14} /></a>
    </header>

    {#if sessions.length === 0}
      <div class="conversation-empty">
        <Icon name="message" size={20} />
        <p>{copy.noSessions}</p>
      </div>
    {:else}
      <ul>
        {#each sessions as session (session.sessionId)}
          <li>
            <a href={`/sessions/${encodeURIComponent(session.sessionId)}`}>
              <span class="session-icon"><Icon name="message" size={16} /></span>
              <span class="session-copy">
                <strong>{session.name ?? copy.sessionUntitled}</strong>
                <small>{workspaceLabel(session)}</small>
              </span>
              <StatusPill
                label={statusLabel(session)}
                status={waitingSessionIds.has(session.sessionId) ? "pending" : (session.activity ?? "idle")}
              />
              <Icon name="chevron" size={15} />
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if data.artifactUnavailableWorkspaceIds.length > 0}
    <RecoveryPanel
      title={copy.partialTitle}
      summary={copy.partialBody}
      facts={[{ label: copy.impact, value: copy.impactValue }]}
      actions={recoveryActions}
      diagnostics={recoveryDiagnostics}
      diagnosticsLabel={copy.diagnostics}
    />
  {/if}

  <details class="workspace-setup" open={data.workspaces.length === 0}>
    <summary>
      <span><Icon name="folder" size={17} />{copy.workspaceSetupTitle}</span>
      <small>{copy.workspaceSetupBody}</small>
    </summary>
    <form class="register" onsubmit={(event) => void registerWorkspace(event)}>
      <p>{copy.registerHint}</p>
      <Field id="workspace-local-path" label={copy.localPath} required reserveMeta={false}>
        <Input id="workspace-local-path" type="text" autocomplete="off" bind:value={localPath} required />
      </Field>
      <Field id="workspace-display-name" label={copy.displayName} reserveMeta={false}>
        <Input id="workspace-display-name" type="text" autocomplete="off" bind:value={displayName} placeholder={copy.optional} />
      </Field>
      {#if registerError}<Notice tone="danger" message={registerError} />{/if}
      <Button type="submit" loading={registering}>{registering ? copy.registering : copy.register}</Button>
    </form>
  </details>
</section>

<style>
  .conversation-home {
    display: grid;
    gap: var(--spacing-xl);
    margin: 0 auto;
    max-width: 920px;
    min-height: 100%;
    padding: clamp(32px, 7vh, 80px) 0 var(--spacing-section);
  }

  .conversation-intro {
    display: grid;
    justify-items: center;
    text-align: center;
  }

  .spark-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-lg);
    color: var(--color-primary);
    display: inline-flex;
    height: 48px;
    justify-content: center;
    margin-bottom: var(--spacing-lg);
    width: 48px;
  }

  .conversation-intro h1 {
    font-size: clamp(1.75rem, 3vw, 2.35rem);
    letter-spacing: -0.025em;
    line-height: 1.16;
    margin: 0;
    text-wrap: balance;
  }

  .conversation-intro p {
    color: var(--color-ink-muted);
    line-height: var(--leading-body);
    margin: var(--spacing-sm) 0 0;
    max-width: 62ch;
    text-wrap: balance;
  }

  .conversation-start {
    margin: 0 auto;
    max-width: 780px;
    width: 100%;
  }

  .composer-scope,
  .composer-scope > span {
    align-items: center;
    display: flex;
    gap: 6px;
  }

  .composer-scope {
    color: var(--color-ink-subtle);
    justify-content: space-between;
    min-height: 30px;
  }

  .composer-scope strong {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    font-weight: var(--weight-body-medium);
  }

  .start-feedback {
    align-items: start;
    display: grid;
    gap: var(--spacing-sm);
    margin: calc(-1 * var(--spacing-sm)) auto 0;
    max-width: 780px;
    width: 100%;
  }

  .start-feedback :global(.ui-button) {
    justify-self: start;
  }

  .conversation-attention {
    align-items: center;
    background: color-mix(in srgb, var(--color-warning) 7%, var(--color-surface));
    border: 1px solid color-mix(in srgb, var(--color-warning) 28%, var(--color-border));
    border-radius: var(--rounded-lg);
    color: var(--color-ink);
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr) auto;
    margin: 0 auto;
    max-width: 780px;
    min-height: var(--control-height-touch);
    padding: var(--spacing-sm) var(--spacing-md);
    text-decoration: none;
    width: 100%;
  }

  .conversation-attention > :global(svg:first-child) {
    color: var(--color-warning);
  }

  .conversation-attention span {
    display: grid;
    gap: 2px;
  }

  .conversation-attention strong {
    font-size: var(--text-caption);
  }

  .conversation-attention span:not(strong) {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
  }

  .recent-conversations {
    border-top: 1px solid var(--color-border);
    margin-top: var(--spacing-sm);
    padding-top: var(--spacing-xl);
  }

  .recent-conversations > header {
    align-items: end;
    display: flex;
    gap: var(--spacing-lg);
    justify-content: space-between;
    margin-bottom: var(--spacing-md);
  }

  .recent-conversations h2,
  .recent-conversations p {
    margin: 0;
  }

  .recent-conversations h2 {
    font-size: var(--text-section-title);
    letter-spacing: -0.01em;
  }

  .recent-conversations p {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    margin-top: 4px;
  }

  .recent-conversations > header > a {
    align-items: center;
    color: var(--color-primary);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: var(--text-caption);
    font-weight: var(--weight-body-medium);
    gap: 5px;
    min-height: var(--control-height-default);
    text-decoration: none;
  }

  .recent-conversations ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .recent-conversations li {
    border-top: 1px solid var(--color-border-soft);
  }

  .recent-conversations li:first-child {
    border-top: 0;
  }

  .recent-conversations li > a {
    align-items: center;
    color: inherit;
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    min-height: 58px;
    padding: var(--spacing-xs) var(--spacing-sm);
    text-decoration: none;
  }

  .recent-conversations li > a:hover {
    background: var(--color-surface-soft);
  }

  .session-icon {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    height: 34px;
    justify-content: center;
    width: 34px;
  }

  .session-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .session-copy strong,
  .session-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-copy strong {
    font-size: var(--text-body);
  }

  .session-copy small {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .conversation-empty {
    align-items: center;
    color: var(--color-ink-muted);
    display: flex;
    gap: var(--spacing-sm);
    min-height: 72px;
    padding: 0 var(--spacing-sm);
  }

  .conversation-empty p {
    font-size: var(--text-body);
  }

  .diagnostic-list {
    margin: 0;
    padding-left: var(--spacing-lg);
  }

  .workspace-setup {
    border-top: 1px solid var(--color-border);
    margin-top: var(--spacing-sm);
    padding-top: var(--spacing-lg);
  }

  .workspace-setup > summary {
    align-items: center;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
    list-style: none;
    min-height: var(--control-height-touch);
  }

  .workspace-setup > summary::-webkit-details-marker {
    display: none;
  }

  .workspace-setup > summary span {
    align-items: center;
    color: var(--color-ink);
    display: inline-flex;
    font-weight: var(--weight-body-medium);
    gap: var(--spacing-xs);
  }

  .workspace-setup > summary small {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .register {
    display: grid;
    gap: var(--spacing-sm);
    max-width: 680px;
    padding-top: var(--spacing-md);
  }

  .register p {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    margin: 0;
  }

  .register > :global(.ui-button) {
    justify-self: start;
  }

  @media (max-width: 720px) {
    .conversation-home {
      gap: var(--spacing-lg);
      padding: var(--spacing-xl) 0 var(--spacing-section);
    }

    .spark-mark {
      height: 42px;
      margin-bottom: var(--spacing-md);
      width: 42px;
    }

    .conversation-intro h1 {
      font-size: 1.65rem;
    }

    .recent-conversations > header {
      align-items: start;
    }

    .recent-conversations li > a {
      grid-template-columns: auto minmax(0, 1fr) auto;
      min-height: 64px;
    }

    .recent-conversations li > a > :global(svg:last-child) {
      display: none;
    }

    .workspace-setup > summary {
      align-items: start;
      flex-direction: column;
      justify-content: center;
    }
  }
</style>
