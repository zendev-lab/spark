<script lang="ts">
  import {
    Composer,
    MessageActions,
    MessageShell,
    ToolCallPart,
    type ConversationPartLabels,
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
</style>
