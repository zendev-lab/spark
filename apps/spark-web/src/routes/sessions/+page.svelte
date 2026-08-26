<script lang="ts">
  import { EmptyState, PageHeader, PageLayout, Panel, StatusPill } from "@zendev-lab/spark-ui";
  import {
    ordinaryDaemonSessions,
    sessionWorkspaceId,
    type SparkWebSession,
  } from "$lib/daemon-surface";

  let { data } = $props();
  let copy = $derived(data.messages.web.sessions);
  const sessions = $derived(ordinaryDaemonSessions(data.sessions as SparkWebSession[]));
  function workspaceLabel(workspaceId: string | null): string {
    if (!workspaceId) return copy.daemon;
    return data.workspaces.find((workspace) => workspace.id === workspaceId)?.displayName ?? workspaceId;
  }

</script>

<PageLayout>
  <PageHeader title={copy.title} lede={copy.lede} />
  {#if sessions.length === 0}
    <Panel><EmptyState icon="message" title={copy.empty} /></Panel>
  {:else}
    <Panel padded={false} ariaLabel={copy.title}>
      <ul>
        {#each sessions as session (session.sessionId)}
          <li>
            <a class="session-link" href="/sessions/{session.sessionId}">{session.name ?? session.sessionId}</a>
            <span class="session-context">
              {#if sessionWorkspaceId(session)}
                <a href="/workspaces/{sessionWorkspaceId(session)}">{workspaceLabel(sessionWorkspaceId(session))}</a>
              {:else}
                {copy.daemon}
              {/if}
              <StatusPill label={session.activity ?? "idle"} status={session.activity ?? "idle"} />
            </span>
          </li>
        {/each}
      </ul>
    </Panel>
  {/if}
</PageLayout>

<style>
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid var(--color-border);
    gap: var(--spacing-md);
    padding: var(--spacing-md) var(--spacing-xl);
  }
  li:first-child {
    border-top: 0;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  .session-link {
    font-weight: var(--weight-body-medium);
  }
  .session-link:hover,
  .session-context a:hover {
    color: var(--color-primary);
  }
  .session-context,
  .session-context a {
    align-items: center;
    color: var(--color-ink-muted);
    display: flex;
    gap: var(--spacing-xs);
  }
  @media (max-width: 640px) {
    li {
      align-items: start;
      flex-direction: column;
    }
  }
</style>
