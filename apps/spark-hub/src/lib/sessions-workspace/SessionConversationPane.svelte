<script lang="ts">
  import { enhance } from "$app/forms";
  import { browser } from "$app/environment";
  import { replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import {
    ConversationEmptyState,
    ConversationViewport,
    Message as ConversationMessage,
  } from "$lib/components/conversation";
  import SessionAskPanel from "$lib/SessionAskPanel.svelte";
  import {
    defaultSessionPrimaryView,
    requestedSessionPrimaryView,
    type SessionPrimaryView,
  } from "$lib/session-work-view";
  import type { Snippet } from "svelte";
  import type { SessionConversationHost } from "./conversation-host";
  import SessionStageHeader from "./SessionStageHeader.svelte";
  import SessionComposerPane from "./SessionComposerPane.svelte";
  import SessionPrimaryViewTabs from "./SessionPrimaryViewTabs.svelte";
  import SessionSideThreadDialog from "./SessionSideThreadDialog.svelte";
  import SessionWorkPanel from "./SessionWorkPanel.svelte";

  let {
    host,
    sessionDetails,
    activityPaneOpen,
    onToggleActivityPane,
  }: {
    host: SessionConversationHost;
    sessionDetails: Snippet<[boolean?]>;
    activityPaneOpen: boolean;
    onToggleActivityPane: () => void;
  } = $props();

  let sideThreadOpen = $state(false);
  let selectedPrimaryView = $state<SessionPrimaryView>("transcript");
  let primaryViewSessionId = $state("");
  let primaryViewExplicit = $state(false);

  $effect(() => {
    const sessionId = host.selected.sessionId;
    if (primaryViewSessionId !== sessionId) {
      const requested = browser
        ? requestedSessionPrimaryView(new URL(window.location.href))
        : undefined;
      primaryViewSessionId = sessionId;
      primaryViewExplicit = requested !== undefined;
      selectedPrimaryView = requested ?? defaultSessionPrimaryView(host.liveSessionView);
      return;
    }
    if (!primaryViewExplicit) {
      selectedPrimaryView = defaultSessionPrimaryView(host.liveSessionView);
    }
  });

  function selectPrimaryView(view: SessionPrimaryView) {
    selectedPrimaryView = view;
    primaryViewExplicit = true;
    if (!browser) return;
    const url = new URL(page.url);
    url.searchParams.set("view", view);
    replaceState(url, page.state);
  }

</script>

<SessionStageHeader
  {host}
  {sessionDetails}
  {activityPaneOpen}
  {onToggleActivityPane}
  onOpenSideThread={() => (sideThreadOpen = true)}
/>

<SessionPrimaryViewTabs
  selected={selectedPrimaryView}
  workLabel={host.copy.workTab}
  transcriptLabel={host.copy.transcriptTab}
  ariaLabel={host.copy.workViewAria}
  onSelect={selectPrimaryView}
/>

<div
  id="session-work-panel"
  class="primary-view-panel work-panel"
  role="tabpanel"
  aria-labelledby="session-work-tab"
  hidden={selectedPrimaryView !== "work"}
>
  <SessionWorkPanel {host} />
</div>

<div
  id="session-transcript-panel"
  class="primary-view-panel transcript-panel"
  role="tabpanel"
  aria-labelledby="session-transcript-tab"
  hidden={selectedPrimaryView !== "transcript"}
>
  {#key host.selected.sessionId}
      <ConversationViewport
        label={host.copy.timelineTitle}
        followKey={host.timelineFollowKey}
        announcement={host.latestAnnouncement}
        jumpToLatestLabel={host.copy.jumpToLatest}
        hasEarlier={host.hasEarlierTimeline}
        onLoadEarlier={host.showEarlierTimeline}
        navigationItems={host.timelineNavigationItems}
      >
      {#if host.timelineItems.length === 0}
        <ConversationEmptyState title={host.copy.timelineEmpty} />
      {:else}
        {#each host.renderedTimelineItems as item (item.id)}
          <ConversationMessage
            {item}
            sessionId={host.selected.sessionId}
            active={item.id === host.activeProcessItemId}
            userLabel={host.copy.you}
            assistantLabel={host.copy.spark}
            sessionLabel={host.copy.agent}
            copyLabel={host.copy.copyMessage}
            copiedLabel={host.copy.copiedMessage}
            partLabels={host.conversationPartLabels}
            relativeTime={host.relative}
            statusLabel={host.statusLabel}
            retryAction={item.id === host.retryableTimelineItemId && host.latestRetryPrompt
              ? {
                  label: host.copy.retryTurn,
                  submittingLabel: host.copy.retryingTurn,
                  unavailableLabel: host.copy.retryUnavailable,
                  submitting: host.retryState === "submitting",
                  disabled: !host.canAssign || !host.modelReady,
                  onRetry: () => {
                    if (host.latestRetryPrompt) host.retryConversationTurn(host.latestRetryPrompt);
                  },
                }
              : undefined}
          />
        {/each}
      {/if}
      </ConversationViewport>
  {/key}
</div>

    <form
      id="session-model-form"
      bind:this={() => host.sessionModelForm, (v) => (host.sessionModelForm = v)}
      method="POST"
      action="?/selectModel"
      use:enhance={host.enhanceSelectModel}
    ></form>
    <input form="session-model-form" type="hidden" name="sessionId" value={host.selected.sessionId} />
    <form
      id="session-thinking-form"
      bind:this={() => host.sessionThinkingForm, (v) => (host.sessionThinkingForm = v)}
      method="POST"
      action="?/selectThinking"
      use:enhance={host.enhanceSelectThinking}
    ></form>
    <input
      form="session-thinking-form"
      type="hidden"
      name="sessionId"
      value={host.selected.sessionId}
    />
    <form
      bind:this={() => host.sessionDirectiveForm, (v) => (host.sessionDirectiveForm = v)}
      method="POST"
      action="?/sendMessage"
      hidden
      use:enhance={host.enhanceRetryMessage}
    >
      <input type="hidden" name="sessionId" value={host.selected.sessionId} />
      <input type="hidden" name="submissionId" value={host.directiveSubmissionId} />
      <input type="hidden" name="message" value={host.directivePrompt} />
    </form>

    {#each host.queueItems as item (item.id)}
      <form
        id={host.queueRemoveFormId(item.id)}
        method="POST"
        action="?/cancelTurn"
        hidden
        use:enhance={host.enhanceRemoveQueuedTurn}
      >
        <input type="hidden" name="sessionId" value={host.selected.sessionId} />
        <input type="hidden" name="turnId" value={item.id} />
        <input type="hidden" name="cancelIntent" value="dequeue" />
      </form>
    {/each}

    <form
      bind:this={() => host.retryMessageForm, (v) => (host.retryMessageForm = v)}
      method="POST"
      action="?/sendMessage"
      hidden
      use:enhance={host.enhanceRetryMessage}
    >
      <input type="hidden" name="sessionId" value={host.selected.sessionId} />
      <input type="hidden" name="submissionId" value={host.retrySubmissionId} />
      <input type="hidden" name="message" value={host.retryPrompt} />
    </form>

    {#if host.sessionPendingAsk && host.askDetailMessages}
      <div class="session-ask-dock">
        <SessionAskPanel ask={host.sessionPendingAsk} messages={host.askDetailMessages} />
      </div>
    {/if}

<SessionComposerPane {host} />

{#if sideThreadOpen}
  <SessionSideThreadDialog
    sessionId={host.selected.sessionId}
    messages={host.messages}
    statusLabel={host.statusLabel}
    onClose={() => (sideThreadOpen = false)}
  />
{/if}

<style>
  .primary-view-panel {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .primary-view-panel[hidden] {
    display: none;
  }

  .transcript-panel {
    display: flex;
  }

  .session-ask-dock {
    align-self: center;
    flex: 0 0 auto;
    max-height: min(42dvh, 460px);
    max-width: 800px;
    overflow-y: auto;
    width: 100%;
  }

</style>
