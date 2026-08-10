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
  import {
    Artifact,
    CodeBlock,
    Commit,
    Confirmation,
    DiffView,
    FileTree,
    Plan,
    SchemaView,
    StackTrace,
    Task,
    Terminal,
    TestResults,
    WebPreview,
    WebPreviewBody,
    type DiffViewModel,
    type FileTreeEntryView,
    type PlanView,
    type StackFrameView,
    type TestResultView,
    type WorkbenchStatus,
  } from "../src/workbench";
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
  const artifactPreviewDocument =
    "<!doctype html><html lang='en'><head><title>Artifact preview</title><style>body{font:16px system-ui;padding:2rem;color:#1f2937}small{color:#64748b}</style></head><body><small>Spark artifact</small><h1>UI boundary report</h1><p>Canonical server-rendered preview.</p></body></html>";
  const planSteps: PlanView["steps"] = [
    { id: "types", title: "Define neutral view types", status: "completed" },
    { id: "catalog", title: "Cover catalog states", status: "running" },
    { id: "hub", title: "Map Hub projections", status: "pending" },
  ];
  const diffLines: DiffViewModel["lines"] = [
    { kind: "header", text: "@@ -1,3 +1,3 @@" },
    { kind: "deletion", oldLine: 1, text: "const state = inferState(text);" },
    { kind: "addition", newLine: 1, text: "const state = projection.status;" },
    { kind: "context", oldLine: 2, newLine: 2, text: "return state;" },
  ];
  const fileEntries: readonly FileTreeEntryView[] = [
    { id: "src", name: "src", kind: "directory", depth: 0, expanded: true },
    { id: "ui", name: "workbench", kind: "directory", depth: 1, expanded: true },
    { id: "tool", name: "Tool.svelte", kind: "file", depth: 2, selected: true },
    { id: "types", name: "types.ts", kind: "file", depth: 2 },
  ];
  const overflowingFileEntries: readonly FileTreeEntryView[] = [
    { id: "src", name: "src", kind: "directory", depth: 0, expanded: true },
    {
      id: "long-file",
      name: "authoritative-owner-projection-with-a-deliberately-long-file-name.ts",
      kind: "file",
      depth: 6,
      selected: true,
    },
  ];
  const stackFrames: readonly StackFrameView[] = [
    { id: "one", functionName: "projectConversation", file: "adapter.ts", line: 42 },
    { id: "two", functionName: "renderWorkbench", file: "view.ts", line: 18, column: 7 },
  ];

  function lifecycleStatus(state: CatalogScenario["state"]): WorkbenchStatus {
    if (state === "loading") return "pending";
    if (state === "streaming") return "running";
    if (state === "error") return "failed";
    return "completed";
  }

  function planFor(state: CatalogScenario["state"]): PlanView {
    const status = state === "empty" ? "pending" : lifecycleStatus(state);
    const steps = state === "empty"
      ? []
      : state === "success"
        ? planSteps.map((step) => ({ ...step, status: "completed" as const }))
        : state === "error"
          ? planSteps.map((step, index) => ({
              ...step,
              status: index === 1 ? ("failed" as const) : step.status,
            }))
          : planSteps;
    return {
      id: `catalog-plan-${state}`,
      title: "Ship the UI boundary",
      status,
      description: "Each step is projected by its owner.",
      steps,
    };
  }

  function diffFor(state: CatalogScenario["state"]): DiffViewModel {
    const lines = state === "empty"
      ? []
      : state === "overflow"
        ? [
            ...diffLines,
            {
              kind: "addition" as const,
              newLine: 3,
              text: "const displaySafeProjection = authoritativeOwnerFactsWithoutClientSideRuntimeInference;",
            },
          ]
        : diffLines;
    return {
      id: `catalog-diff-${state}`,
      title: "src/owner.ts",
      additions: lines.filter((line) => line.kind === "addition").length,
      deletions: lines.filter((line) => line.kind === "deletion").length,
      lines,
    };
  }

  function testResultsFor(state: CatalogScenario["state"]): readonly TestResultView[] {
    if (state === "empty") return [];
    if (state === "loading") {
      return [{ id: "browser", name: "Keyboard interaction", status: "running" }];
    }
    if (state === "error") {
      return [
        {
          id: "browser",
          name: "Keyboard interaction",
          status: "failed",
          durationMs: 42,
          message: "Expected focus to move to the next visible tree item.",
        },
      ];
    }
    if (state === "overflow") {
      return [
        {
          id: "overflow",
          name: "A deliberately long package-owned interaction test name that must wrap safely",
          status: "passed",
          durationMs: 128,
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `result-${index}`,
          name: `Focused workbench check ${index + 1}`,
          status: "passed" as const,
          durationMs: 20 + index,
        })),
      ];
    }
    return [
      { id: "ssr", name: "SSR contract", status: "passed", durationMs: 24 },
      { id: "browser", name: "Keyboard interaction", status: "passed", durationMs: 36 },
      { id: "overflow", name: "Overflow fixture", status: "skipped" },
    ];
  }

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

{#snippet confirmationActions()}
  <button type="button" class="catalog-button" disabled={scenario.state === "disabled"}>Approve</button>
  <button
    type="button"
    class="catalog-button secondary"
    disabled={scenario.state === "disabled"}>Reject</button
  >
{/snippet}

{#snippet artifactPreviewBody()}
  <WebPreviewBody title="Artifact preview" documentHtml={artifactPreviewDocument} />
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
{:else if fixtureId === "confirmation"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <Confirmation
      view={{
        id: `catalog-confirmation-${scenario.id}`,
        title: "Allow workspace write?",
        status: scenario.state === "success"
          ? "approved"
          : scenario.state === "error"
            ? "rejected"
            : scenario.state === "disabled"
              ? "requested"
              : "pending",
        description: "The owner supplies the request and handles either action.",
        detail: "workspace.write",
      }}
      {statusLabel}
      actions={confirmationActions}
    />
  </div>
{:else if fixtureId === "plan"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <Plan view={planFor(scenario.state)} {statusLabel} stepLabel="Plan steps" onSelectStep={noop} />
  </div>
{:else if fixtureId === "task"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <Task
      view={{
        id: `task:catalog:${scenario.id}`,
        title: "Run focused checks",
        status: lifecycleStatus(scenario.state),
        summary: scenario.state === "error"
          ? "The owner reported a failing browser check."
          : scenario.state === "loading"
            ? "Waiting for the owner to start the check."
            : "Browser and SSR lanes are running.",
      }}
      {statusLabel}
      taskLabel="Task"
      defaultOpen
    />
  </div>
{:else if fixtureId === "artifact"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <Artifact
      view={{
        id: `artifact:catalog:${scenario.id}`,
        title: "UI boundary report",
        kind: "document",
        status: scenario.state === "empty" ? "pending" : lifecycleStatus(scenario.state),
        summary: scenario.state === "empty"
          ? undefined
          : scenario.state === "error"
            ? "The owner rejected this projection."
            : "A deterministic projection of owner facts.",
        previewHref: scenario.state === "success" ? "/preview/catalog" : undefined,
      }}
      previewLabel="Open preview"
      {statusLabel}
    />
  </div>
{:else if fixtureId === "code-block"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <CodeBlock
      view={{
        filename: "owner.ts",
        language: "typescript",
        code: scenario.state === "overflow"
          ? "export const displaySafeProjection = authoritativeOwnerFactsWithoutClientSideRuntimeInference;"
          : "export const status = projection.status;\nreturn status;",
        highlightLines: [1],
      }}
      copyLabel="Copy code"
      onCopy={noop}
    />
  </div>
{:else if fixtureId === "diff-view"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <DiffView view={diffFor(scenario.state)} additionsLabel="additions" deletionsLabel="deletions" />
  </div>
{:else if fixtureId === "file-tree"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <FileTree
      entries={scenario.state === "empty"
        ? []
        : scenario.state === "overflow"
          ? overflowingFileEntries
          : scenario.state === "disabled"
            ? fileEntries.map((entry) => ({ ...entry, disabled: true }))
            : fileEntries}
      label="Files"
      onSelect={noop}
      onToggle={noop}
    />
  </div>
{:else if fixtureId === "terminal"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <Terminal
      view={{
        id: `terminal:catalog:${scenario.id}`,
        title: "Focused checks",
        command: "pnpm run test:browser",
        output: scenario.state === "loading"
          ? ""
          : scenario.state === "streaming"
            ? "17 of 32 tests passed…"
            : scenario.state === "error"
              ? "1 test failed\nfocus remained on the previous tree item"
              : scenario.state === "overflow"
                ? Array.from({ length: 12 }, (_, index) => `workbench check ${index + 1} passed`).join("\n")
                : "32 tests passed\nowner projection unchanged",
        status: lifecycleStatus(scenario.state),
      }}
      {statusLabel}
    />
  </div>
{:else if fixtureId === "test-results"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <TestResults
      results={testResultsFor(scenario.state)}
      label="Test results"
      {statusLabel}
      durationLabel={(milliseconds) => `${milliseconds} ms`}
    />
  </div>
{:else if fixtureId === "stack-trace"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <StackTrace
      title="ProjectionError"
      message={scenario.state === "empty" ? undefined : "Malformed display-safe fact"}
      frames={scenario.state === "empty"
        ? []
        : scenario.state === "overflow"
          ? [
              ...stackFrames,
              {
                id: "long-frame",
                functionName: "projectAuthoritativeOwnerFactsWithoutClientSideRuntimeInference",
                file: "packages/spark-ui/src/workbench/a-deliberately-long-display-safe-file-name.ts",
                line: 128,
              },
            ]
          : stackFrames}
      onSelectFrame={noop}
    />
  </div>
{:else if fixtureId === "schema-view"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <SchemaView
      title="tool-result.schema.json"
      schema={scenario.state === "empty"
        ? {}
        : scenario.state === "overflow"
          ? {
              type: "object",
              required: ["authoritativeOwnerProjection", "displaySafeStatus"],
              properties: {
                authoritativeOwnerProjection: {
                  type: "object",
                  description: "A deliberately long structured schema description for overflow coverage.",
                },
                displaySafeStatus: { type: "string" },
              },
            }
          : { type: "object", required: ["status"], properties: { status: { type: "string" } } }}
      copyLabel="Copy schema"
      onCopy={noop}
    />
  </div>
{:else if fixtureId === "commit"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <Commit
      view={{
        hash: "0103aa24",
        title: scenario.state === "overflow"
          ? "Add a protocol-neutral workbench projection without duplicating daemon-owned lifecycle state"
          : "Add controlled conversation kit",
        author: "Spark",
        timestamp: "now",
        description: scenario.state === "overflow"
          ? "This intentionally long description verifies wrapping in constrained workbench layouts."
          : undefined,
        href: "https://example.com/commit/0103aa24",
      }}
      openLabel="Open commit"
    />
  </div>
{:else if fixtureId === "web-preview"}
  <div data-catalog-rendered={`${fixtureId}:${scenario.id}`}>
    <WebPreview
      view={{
        id: `preview:catalog:${scenario.id}`,
        title: scenario.state === "overflow"
          ? "A long owner-provided artifact preview title that must remain inside the workbench card"
          : "Hub preview",
        description: scenario.state === "empty"
          ? undefined
          : "Explicit screenshot and link; no embedded runtime.",
        href: scenario.state === "empty" ? undefined : "/preview/catalog",
      }}
      openLabel="Open preview"
      imageAlt="Hub preview screenshot"
      children={scenario.state === "success" ? artifactPreviewBody : undefined}
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

  .catalog-button {
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    border-radius: var(--rounded-md);
    color: var(--color-on-primary);
    font: inherit;
    font-size: 11px;
    min-height: 30px;
    padding-inline: 10px;
  }

  .catalog-button.secondary {
    background: var(--color-surface);
    border-color: var(--color-border);
    color: var(--color-ink-muted);
  }

  .catalog-button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
