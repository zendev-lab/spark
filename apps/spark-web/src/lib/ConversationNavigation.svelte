<script lang="ts">
  import { ChannelSessionIcon, Icon } from "@zendev-lab/spark-ui";
  import { sidebarBotProfile, sidebarNavigation, visibleSidebarSessions, type SidebarData } from "./sidebar";
  import { channelSessionPresentation, formatChannelSessionTitle } from "@zendev-lab/spark-ui/channel-session";
  import type { getDictionary } from "./i18n";

  let { data, pathname, messages, closeNavigation, retry }: {
    data: SidebarData;
    pathname: string;
    messages: ReturnType<typeof getDictionary>;
    closeNavigation: () => void;
    retry: () => void;
  } = $props();
  const copy = $derived(messages.web.shell);
  const selectedSessionId = $derived(pathname.startsWith("/sessions/") ? decodeURIComponent(pathname.slice("/sessions/".length)) : undefined);
  const navigation = $derived(sidebarNavigation(data, selectedSessionId));
  let collapsed = $state<(string | null)[]>([]);
  let expanded = $state<(string | null)[]>([]);
</script>

<nav class="conversation-navigation" aria-label={copy.primaryNavigation}>
  <div class="navigation-scroll">
    {#if navigation.channels.length > 0}
      <ul class="pinned-channels" aria-label={copy.channelConversations}>
        {#each navigation.channels as session (session.sessionId)}
          {@const presentation = channelSessionPresentation(session, { fallback: messages.web.home.sessionUntitled, labels: copy.channelLabels })}
          {@const bot = sidebarBotProfile(session, data, presentation.channel?.adapter)}
          {@const title = formatChannelSessionTitle(session.name, { fallback: presentation.channel?.label ?? messages.web.home.sessionUntitled, labels: copy.channelLabels })}
          <li>
            <a class="session-link channel-link" draggable="false" href="/sessions/{encodeURIComponent(session.sessionId)}" aria-current={session.sessionId === selectedSessionId ? "page" : undefined} title={title} onclick={closeNavigation}>
              {#if presentation.channel}<ChannelSessionIcon adapter={presentation.channel.adapter} scope={presentation.channel.scope} label={presentation.channel.label} avatarUrl={bot?.avatarUrl} />{:else}<Icon name="message" size={18} />{/if}
              <span class="channel-text"><span class="session-title">{bot?.displayName ?? title}</span>{#if bot?.displayName}<span class="channel-detail">{title}</span>{/if}</span>
              {@render activityDot(session.activity)}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
    {#if data.unavailable}
      <div class="navigation-empty" role="status">
        <p>{copy.navigationUnavailable}</p>
        <button class="text-action" type="button" onclick={retry}>{copy.retryNavigation}</button>
      </div>
    {:else if navigation.groups.length === 0 && navigation.channels.length === 0}
      <p class="navigation-empty">{messages.web.home.noSessions}</p>
    {:else}
      {#each navigation.groups as group (group.id)}
        {@const isCollapsed = collapsed.includes(group.id)}
        {@const isExpanded = expanded.includes(group.id)}
        {@const groupName = group.id === null ? messages.web.home.generalContext : group.name}
        {@const visible = visibleSidebarSessions(group.sessions, isExpanded, selectedSessionId)}
        <section class="workspace-group" aria-label={groupName}>
          <div class="group-heading">
            <button class="group-toggle" type="button" aria-label={groupName} aria-expanded={!isCollapsed} onclick={() => collapsed = isCollapsed ? collapsed.filter((id) => id !== group.id) : [...collapsed, group.id]}>
              <Icon name={isCollapsed ? "chevron" : "chevron-down"} size={14} />
            </button>
            {#if group.id !== null}
              <a href="/workspaces/{encodeURIComponent(group.id)}" class="workspace-link" aria-current={pathname === `/workspaces/${encodeURIComponent(group.id)}` ? "page" : undefined} onclick={closeNavigation} title={groupName}>
                <Icon name="folder" size={17} /><span>{groupName}</span>
              </a>
              <a class="new-in-workspace" href="/?workspace={encodeURIComponent(group.id)}" aria-label={`${copy.newInWorkspace}: ${groupName}`} title={copy.newInWorkspace} onclick={closeNavigation}><Icon name="plus" size={16} /></a>
            {:else}
              <span class="workspace-link"><Icon name="message" size={17} /><span>{groupName}</span></span>
            {/if}
          </div>
          {#if !isCollapsed}
            <ul>
              {#each visible as session (session.sessionId)}
                {@const sessionTitle = session.name || messages.web.home.sessionUntitled}
                <li>
                  <a class="session-link" draggable="false" href="/sessions/{encodeURIComponent(session.sessionId)}" aria-current={session.sessionId === selectedSessionId ? "page" : undefined} title={sessionTitle} onclick={closeNavigation}>
                    <span class="session-title">{sessionTitle}</span>
                    {@render activityDot(session.activity)}
                  </a>
                </li>
              {/each}
            </ul>
            {#if group.sessions.length > visible.length || isExpanded}
              <button class="text-action show-more" type="button" aria-expanded={isExpanded} onclick={() => expanded = isExpanded ? expanded.filter((id) => id !== group.id) : [...expanded, group.id]}>{isExpanded ? copy.showLessSessions : copy.showMoreSessions}</button>
            {/if}
          {/if}
        </section>
      {/each}
    {/if}
  </div>
  <div class="navigation-footer">
    <a class="nav-link" href="/?setup=workspace#workspace-setup" onclick={closeNavigation}>
      <Icon name="plus" size={18} /><span>{messages.web.home.workspaceSetupTitle}</span>
    </a>
    <a class="nav-link" href="/settings" aria-current={pathname.startsWith("/settings") ? "page" : undefined} onclick={closeNavigation}>
      <Icon name="settings" size={18} /><span>{copy.settings}</span>
    </a>
  </div>
</nav>

{#snippet activityDot(activity: SidebarData["sessions"][number]["activity"])}
  {#if activity === "running" || activity === "queued"}
    <span class="activity" class:running={activity === "running"} role="img" aria-label={messages.shared.status[activity] ?? activity}></span>
  {/if}
{/snippet}

<style>
  .conversation-navigation {
    box-sizing: border-box;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
    height: 100%;
    min-height: 0;
    min-width: 0;
    padding: var(--spacing-sm) 0;
  }
  .navigation-footer {
    border-top: 1px solid var(--color-border-soft);
    padding: var(--spacing-sm) var(--spacing-sm) 0;
  }
  .navigation-scroll {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0 var(--spacing-sm) var(--spacing-md);
    scrollbar-color: var(--color-border) transparent;
    scrollbar-width: thin;
  }
  a { cursor: pointer; color: inherit; text-decoration: none; }
  a, button { -webkit-tap-highlight-color: transparent; }
  .nav-link, .session-link, .workspace-link { align-items: center; display: flex; gap: var(--spacing-sm); min-width: 0; }
  .nav-link, .session-link { border-radius: var(--rounded-md); min-height: var(--control-height-default); padding: 0 var(--spacing-sm); }
  .nav-link { color: var(--color-ink-muted); font-size: var(--text-body); font-weight: var(--weight-body-medium); }
  .pinned-channels { margin-bottom: var(--spacing-lg); }
  .channel-link { padding-inline-start: var(--spacing-sm); gap: var(--spacing-sm); }
  .channel-text { display: grid; min-width: 0; flex: 1; padding-block: var(--spacing-xxs); gap: 2px; }
  .channel-detail { color: var(--color-ink-subtle); font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .new-in-workspace { display: flex; align-items: center; justify-content: center; flex: 0 0 32px; height: 32px; border-radius: var(--rounded-xs); color: var(--color-ink-subtle); }
  .workspace-group + .workspace-group { margin-top: var(--spacing-lg); }
  .group-heading { align-items: center; display: flex; gap: 2px; margin-bottom: var(--spacing-xxs); }
  .group-toggle { align-items: center; background: transparent; border: 0; border-radius: var(--rounded-xs); color: var(--color-ink-subtle); cursor: pointer; display: flex; flex: 0 0 24px; height: 32px; justify-content: center; padding: 0; }
  .workspace-link { border-radius: var(--rounded-xs); color: var(--color-ink-muted); flex: 1; font-size: var(--text-body); min-height: 32px; }
  .workspace-link span, .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-link :global(svg), .nav-link :global(svg) { flex-shrink: 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  .session-link { color: var(--color-ink-muted); font-size: var(--text-body); justify-content: space-between; padding-inline-start: 28px; }
  .session-title { min-width: 0; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
  .text-action { background: transparent; border: 0; border-radius: var(--rounded-xs); color: var(--color-ink-subtle); cursor: pointer; font: inherit; font-size: var(--text-caption); min-height: 32px; padding: 0 var(--spacing-xs); text-align: start; }
  .show-more { margin-inline-start: 24px; }
  .navigation-empty { color: var(--color-ink-subtle); font-size: var(--text-caption); line-height: 1.6; margin: var(--spacing-sm); }
  .navigation-empty p { margin: 0; }
  .activity { border: 2px solid var(--color-border); border-radius: 50%; box-sizing: border-box; flex: 0 0 12px; height: 12px; }
  .activity.running { border-color: var(--color-primary-soft); border-top-color: var(--color-primary); animation: activity-spin 1s linear infinite; }
  @keyframes activity-spin { to { transform: rotate(360deg); } }
  @media (hover: hover) and (pointer: fine) {
    a:hover, button:hover { background: var(--color-surface-soft); color: var(--color-ink); }
  }
  a[aria-current="page"] { background: var(--color-primary-weak); color: var(--color-primary); }
  @media (max-width: 900px) {
    .nav-link, .session-link, .workspace-link, .group-toggle, .text-action, .new-in-workspace { min-height: var(--control-height-touch); }
    .group-toggle { flex-basis: var(--control-height-touch); }
    .session-link { padding-inline-start: 36px; }
    .channel-link { padding-inline-start: var(--spacing-sm); }
    .new-in-workspace { flex-basis: var(--control-height-touch); }
  }
  @media (prefers-reduced-motion: reduce) {
    .activity.running {
      animation: none;
      background: var(--color-primary);
      border-color: var(--color-primary);
    }
  }
</style>
