<script lang="ts">
  import { SafeMarkdown } from "@zendev-lab/spark-ui/markdown";
  import {
    ApprovalPart,
    ArtifactPart,
    ErrorPart,
    MessageActions,
    MessageShell,
    NoticePart,
    ReasoningPart,
    TaskRunPart,
    ThinkingChainPart,
    ToolCallPart,
    visibleConversationParts,
    visibleConversationPartText,
    type ConversationMessageView,
    type ConversationPartLabels,
  } from "@zendev-lab/spark-ui/conversation";
  import ImagePart from "./ImagePart.svelte";
  import RuntimeControlPart from "./RuntimeControlPart.svelte";
  import SessionRetryAction from "./SessionRetryAction.svelte";

  type Props = {
    item: ConversationMessageView;
    sessionId: string;
    userLabel: string;
    assistantLabel: string;
    sessionLabel: string;
    copyLabel: string;
    copiedLabel: string;
    active?: boolean;
    partLabels: ConversationPartLabels;
    relativeTime: (value: string) => string;
    statusLabel: (status: string) => string;
    retryAction?: {
      label: string;
      submittingLabel: string;
      unavailableLabel: string;
      submitting: boolean;
      disabled: boolean;
      onRetry: () => void;
    };
  };

  let {
    item,
    sessionId,
    userLabel,
    assistantLabel,
    sessionLabel,
    copyLabel,
    copiedLabel,
    active = false,
    partLabels,
    relativeTime,
    statusLabel,
    retryAction,
  }: Props = $props();

  let actorLabel = $derived(
    item.actor === "spark"
      ? assistantLabel
      : item.actor === "session"
        ? `${sessionLabel} · ${item.senderLabel ?? "?"}`
        : (item.senderLabel ?? userLabel),
  );
  let visibleParts = $derived(visibleConversationParts(item.parts));
  let runtimeOnly = $derived(
    visibleParts.length > 0 && visibleParts.every((part) => part.type === "runtime"),
  );
  let copyableText = $derived(visibleConversationPartText(item.parts));
  let hasCopyableText = $derived(copyableText.length > 0);

  function artifactPreviewHref(summary: string | undefined): string | undefined {
    return summary
      ?.trim()
      .match(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/preview\/[A-Za-z0-9_-]+$/u)?.[0];
  }
</script>

{#snippet messageContent()}
  {#if item.title && item.title !== item.body}<h2>{item.title}</h2>{/if}
  {#each visibleParts as part, partIndex (`${item.id}:${part.type}:${partIndex}`)}
    {#if part.type === "quote"}
      <blockquote class="user-quote">
        {#if part.senderLabel}
          <span class="user-quote-sender">{part.senderLabel}</span>
        {/if}
        <p class="user-quote-text">{part.text}</p>
      </blockquote>
    {:else if part.type === "text"}
      {#if item.actor === "spark" || item.actor === "session"}
        <div class="assistant-content">
          <SafeMarkdown source={part.text} streaming={part.streaming} />
        </div>
      {:else}
        <p class="user-content">{part.text}</p>
      {/if}
    {:else if part.type === "image"}
      <ImagePart
        {sessionId}
        messageId={item.sourceMessageId ?? item.id}
        contentIndex={part.contentIndex}
        mediaType={part.mediaType}
        name={part.name}
      />
    {:else if part.type === "reasoning"}
      <ReasoningPart
        summary={part.summary}
        state={part.state}
        redacted={part.redacted}
        labels={partLabels}
      />
    {:else if part.type === "commentary"}
      <ReasoningPart summary={part.summary} state={part.state} labels={partLabels} />
    {:else if part.type === "chain"}
      <ThinkingChainPart
        state={part.state}
        steps={part.steps}
        labels={partLabels}
        {statusLabel}
        {active}
      />
    {:else if part.type === "tool"}
      <ToolCallPart
        callId={part.callId}
        name={part.name}
        state={part.state}
        summary={part.summary}
        labels={partLabels}
        {statusLabel}
      />
    {:else if part.type === "task"}
      <TaskRunPart
        taskRef={part.taskRef}
        title={part.title}
        state={part.state}
        summary={part.summary}
        labels={partLabels}
        {statusLabel}
      />
    {:else if part.type === "approval"}
      <ApprovalPart
        requestId={part.requestId}
        title={part.title}
        state={part.state}
        kind={part.kind}
        summary={part.summary}
        labels={partLabels}
        {statusLabel}
      />
    {:else if part.type === "artifact"}
      <ArtifactPart
        artifactRef={part.artifactRef}
        title={part.title}
        kind={part.kind}
        state={part.state}
        summary={part.summary}
        previewHref={artifactPreviewHref(part.summary)}
        previewLabel={partLabels.expand}
        {statusLabel}
      />
    {:else if part.type === "error"}
      <ErrorPart title={part.title} message={part.message} code={part.code} />
    {:else if part.type === "notice"}
      <NoticePart title={partLabels.budgetExhausted} message={partLabels.budgetExhaustedHint} />
    {:else if part.type === "runtime"}
      <RuntimeControlPart
        bindingLabel={part.bindingLabel}
        state={part.state}
        request={part.request}
        result={part.result}
        labels={partLabels}
        {statusLabel}
      />
    {:else}
      <p class="unknown-part">{partLabels.unknown}: {part.label}</p>
    {/if}
  {/each}
  {#if item.meta}<small>{item.meta}</small>{/if}
{/snippet}

{#snippet messageActions()}
  <MessageActions text={copyableText} {copyLabel} {copiedLabel} />
{/snippet}

{#snippet messageFooter()}
  {#if retryAction}<SessionRetryAction {...retryAction} />{/if}
{/snippet}

{#if visibleParts.length > 0}
  <MessageShell
    id={item.id}
    actor={item.actor}
    {actorLabel}
    timestamp={item.timestamp}
    relativeTime={relativeTime(item.timestamp)}
    status={item.status}
    statusLabel={item.status ? statusLabel(item.status) : undefined}
    {runtimeOnly}
    children={messageContent}
    actions={hasCopyableText ? messageActions : undefined}
    footer={retryAction ? messageFooter : undefined}
  />
{/if}
