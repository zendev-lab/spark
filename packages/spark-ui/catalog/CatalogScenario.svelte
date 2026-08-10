<script lang="ts">
  import {
    AttachmentList,
    Composer,
    ContextUsage,
    InlineCitation,
    MessageActions,
    MessageBranchSelector,
    MessageEditor,
    MessageShell,
    ModelSelector,
    SourcesList,
    SpeechInput,
    SuggestionList,
    ToolCallPart,
    type ConversationAttachmentView,
    type ConversationModelGroup,
    type ConversationPartLabels,
    type ConversationSourceView,
    type ConversationSuggestionView,
  } from "../src/conversation";
  import type { CatalogScenario } from "./fixtures";

  type Props = {
    fixtureId: string;
    scenario: CatalogScenario;
  };

  let { fixtureId, scenario }: Props = $props();

  const partLabels: ConversationPartLabels = {
    reasoning: "Reasoning",
    reasoningStreaming: "Reasoning",
    chain: "Process",
    chainStreaming: "Working",
    chainEmpty: "No process details",
    chainFailed: "Process failed",
    tool: "Tool",
    task: "Task",
    approval: "Approval",
    unknown: "Unknown part",
    collapse: "Collapse",
    expand: "Expand",
    budgetExhausted: "Budget exhausted",
    budgetExhaustedHint: "Increase the budget to continue.",
    runtimeControl: "Runtime control",
    runtimeTick: "Runtime tick",
    runtimeRequest: "Request",
    runtimeResult: "Result",
  };

  const statusLabel = (status: string) => status.replaceAll("-", " ");
  const noop = () => undefined;

  const selectedAttachments: readonly ConversationAttachmentView[] = [
    {
      id: "architecture",
      name: "architecture-notes.md",
      kind: "file",
      mediaType: "text/markdown",
      sizeBytes: 18_432,
    },
    {
      id: "diagram",
      name: "component-map.png",
      kind: "image",
      mediaType: "image/png",
      sizeBytes: 86_016,
    },
  ];
  const overflowingAttachments: readonly ConversationAttachmentView[] = [
    {
      id: "owner-contract",
      name: "authoritative-owner-contract-with-a-deliberately-long-unbroken-file-name.md",
      kind: "file",
      mediaType: "text/markdown",
      sizeBytes: 128_000,
    },
  ];
  const structuredSources: readonly ConversationSourceView[] = [
    {
      id: "owner-contract",
      title: "Conversation owner contract",
      href: "https://example.com/conversation-owner",
      description: "Canonical lifecycle facts shared by browser and terminal surfaces.",
      domain: "example.com",
    },
    {
      id: "presentation-boundary",
      title: "Presentation boundary",
      href: "https://example.com/presentation",
      domain: "example.com",
    },
  ];
  const overflowingSources: readonly ConversationSourceView[] = [
    {
      id: "long-source",
      title: "A display-safe source title that must wrap inside constrained conversation layouts",
      href: "https://example.com/presentation-overflow",
      description:
        "Owner-provided source metadata remains structured even when its title and description exceed the usual compact transcript width.",
      domain: "a-very-long-display-safe-source-domain.example.com",
    },
  ];
  const suggestions: readonly ConversationSuggestionView[] = [
    { id: "summarize", label: "Summarize the changes", value: "Summarize the changes" },
    {
      id: "tests",
      label: "Run focused tests",
      description: "Use the current owner projection.",
      value: "Run focused tests",
    },
  ];
  const modelGroups: readonly ConversationModelGroup[] = [
    {
      id: "spark",
      label: "Spark models",
      options: [
        { value: "frontier", label: "Frontier", description: "Complex implementation work" },
        { value: "balanced", label: "Balanced", description: "Everyday product work" },
      ],
    },
  ];

  let messageStatus = $derived(
    scenario.state === "error"
      ? "failed"
      : scenario.state === "streaming"
        ? "streaming"
        : null,
  );
  let messageText = $derived(
    scenario.state === "overflow"
      ? "The-daemon-owns-execution-and-Spark-UI-owns-presentation-without-deriving-runtime-state-from-long-unbroken-transcript-content."
      : scenario.state === "error"
        ? "The owner reported a failed turn; presentation keeps that state explicit."
        : scenario.state === "streaming"
          ? "The daemon owns execution; this display-safe response is still streaming…"
          : "The daemon owns execution; Spark UI owns presentation.",
  );
  let composerValue = $derived(
    scenario.state === "empty" ? "" : "Summarize the authoritative session snapshot.",
  );
  let toolState = $derived(
    scenario.state === "loading"
      ? "pending"
      : scenario.state === "streaming"
        ? "running"
        : scenario.state === "error"
          ? "failed"
          : "completed",
  );
  let toolSummary = $derived(
    scenario.state === "loading"
      ? undefined
      : scenario.state === "overflow"
        ? "Read packages/spark-ui/catalog/fixtures.ts and returned a display-safe result with enough deliberately verbose detail to verify truncation, wrapping, disclosure layout, and constrained workbench widths."
        : scenario.state === "error"
          ? "The owner rejected the read after validating the requested path."
          : scenario.state === "streaming"
            ? "Reading the package-owned component fixtures…"
            : "Read 4 files and returned a display-safe summary.",
  );
  let attachmentItems: readonly ConversationAttachmentView[] = $derived(
    scenario.state === "empty"
      ? []
      : scenario.state === "overflow"
        ? overflowingAttachments
        : selectedAttachments,
  );
  let sourceItems: readonly ConversationSourceView[] = $derived(
    scenario.state === "empty"
      ? []
      : scenario.state === "overflow"
        ? overflowingSources
        : structuredSources,
  );
  let speechState = $derived(
    scenario.state === "recording"
      ? "recording"
      : scenario.state === "loading"
        ? "processing"
        : "idle",
  );
</script>

{#snippet assistantMessage()}
  <p class="assistant-content">{messageText}</p>
{/snippet}

{#snippet messageActions()}
  <MessageActions text={messageText} copyLabel="Copy" copiedLabel="Copied" />
{/snippet}

{#snippet composerFeedback()}
  <p class="catalog-error" role="alert">The owner rejected this submission. Try again.</p>
{/snippet}

{#if fixtureId === "message-shell"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <MessageShell
      id={`catalog-message-${scenario.id}`}
      actor="spark"
      actorLabel="Spark"
      timestamp="2026-08-10T08:00:00.000Z"
      relativeTime="now"
      status={messageStatus}
      statusLabel={messageStatus ? statusLabel(messageStatus) : undefined}
      children={assistantMessage}
      actions={messageActions}
    />
  </div>
{:else if fixtureId === "composer"}
  <form
    data-catalog-rendered={`${fixtureId}:${scenario.id}`}
    onsubmit={(event) => event.preventDefault()}
  >
    <Composer
      id={`catalog-composer-${scenario.id}`}
      value={composerValue}
      placeholder="Ask Spark"
      disabled={scenario.state === "disabled"}
      submitDisabled={scenario.state === "loading"}
      submitting={scenario.state === "loading"}
      submitLabel="Send"
      submittingLabel="Sending"
      ariaLabel="Message"
      multilineHint="Command or Control Enter to send"
      feedback={scenario.state === "error" ? composerFeedback : undefined}
    />
  </form>
{:else if fixtureId === "attachments"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <AttachmentList
      items={attachmentItems}
      label="Selected attachments"
      removeLabel="Remove attachment"
      onRemove={noop}
    />
  </div>
{:else if fixtureId === "message-controls"}
  <div class="control-stack" data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <MessageBranchSelector
      view={scenario.state === "disabled" ? { current: 1, total: 1 } : { current: 2, total: 3 }}
      label="Response branches"
      previousLabel="Previous response"
      nextLabel="Next response"
      onPrevious={scenario.state === "disabled" ? undefined : noop}
      onNext={scenario.state === "disabled" ? undefined : noop}
    />
    <MessageActions
      text={scenario.state === "disabled" ? "" : "A display-safe response"}
      copyLabel="Copy"
      copiedLabel="Copied"
      retryLabel="Retry"
      editLabel="Edit"
      downloadLabel="Download"
      shareLabel="Share"
      positiveFeedbackLabel="Helpful"
      negativeFeedbackLabel="Not helpful"
      onRetry={scenario.state === "disabled" ? undefined : noop}
      onEdit={scenario.state === "disabled" ? undefined : noop}
      onDownload={scenario.state === "disabled" ? undefined : noop}
      onShare={scenario.state === "disabled" ? undefined : noop}
      onPositiveFeedback={scenario.state === "disabled" ? undefined : noop}
      onNegativeFeedback={scenario.state === "disabled" ? undefined : noop}
    />
    <MessageEditor
      id={`catalog-message-editor-${scenario.id}`}
      value="Revise this message without mutating transcript state."
      label="Edit message"
      saveLabel="Submit revision"
      cancelLabel="Cancel"
      disabled={scenario.state === "disabled"}
      onSave={noop}
      onCancel={noop}
    />
  </div>
{:else if fixtureId === "sources"}
  <div class="control-stack" data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    {#if sourceItems[0]}
      <p class="citation-demo">
        Shared facts remain explicit <InlineCitation
          source={sourceItems[0]}
          index={1}
          label="Source"
        />.
      </p>
    {/if}
    <SourcesList sources={sourceItems} label="Sources" sourceLabel="Source" open />
  </div>
{:else if fixtureId === "prompt-controls"}
  <div class="control-stack" data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <SuggestionList
      suggestions={scenario.state === "empty" ? [] : suggestions}
      label="Suggestions"
      disabled={scenario.state === "disabled"}
      onSelect={noop}
    />
    <div class="prompt-control-row">
      <ContextUsage
        view={{ used: 38_400, limit: 128_000 }}
        label="Context usage"
        usedLabel="Used"
      />
      <SpeechInput
        state={speechState}
        startLabel="Start recording"
        stopLabel="Stop recording"
        cancelLabel="Cancel recording"
        processingLabel="Processing audio"
        disabled={scenario.state === "disabled"}
        onStart={noop}
        onStop={noop}
        onCancel={noop}
      />
    </div>
  </div>
{:else if fixtureId === "model-selector"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <ModelSelector
      id={`catalog-model-selector-${scenario.id}`}
      value={scenario.state === "empty" ? "" : "balanced"}
      groups={modelGroups}
      disabled={scenario.state === "disabled"}
      label="Model"
      title="Choose a model"
      description="The product owns catalog truth and the commit action."
      placeholder="Choose a model"
      searchPlaceholder="Search models"
      emptyLabel="No models found"
      closeLabel="Close model selector"
      clearSearchLabel="Clear search"
      settingsLabel="Configure models"
      onCommit={noop}
    />
  </div>
{:else if fixtureId === "tool-call"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <ToolCallPart
      callId={`catalog-tool-${scenario.id}`}
      name="workspace.read"
      state={toolState}
      summary={toolSummary}
      labels={partLabels}
      {statusLabel}
    />
  </div>
{/if}

<style>
  .catalog-error {
    color: var(--color-danger-strong, #b91c1c);
    font-size: 12px;
    margin: 0;
  }

  .control-stack {
    display: grid;
    gap: 12px;
  }

  .citation-demo {
    color: var(--color-ink-muted);
    font-size: 13px;
    line-height: 1.6;
    margin: 0;
  }

  .prompt-control-row {
    align-items: center;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }
</style>
