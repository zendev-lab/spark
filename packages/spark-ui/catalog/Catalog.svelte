<script lang="ts">
  import "../src/tokens.css";

  import {
    Composer,
    MessageActions,
    MessageShell,
    ToolCallPart,
    type ConversationPartLabels,
  } from "../src/conversation";
  import { catalogFixtures } from "./fixtures";

  type Props = {
    theme?: "light" | "dark";
    direction?: "ltr" | "rtl";
    compact?: boolean;
    wide?: boolean;
  };

  let {
    theme = "light",
    direction = "ltr",
    compact = false,
    wide = false,
  }: Props = $props();

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
</script>

{#snippet assistantMessage()}
  <p class="assistant-content">The daemon owns execution; Spark UI owns presentation.</p>
{/snippet}

{#snippet messageActions()}
  <MessageActions text="The daemon owns execution." copyLabel="Copy" copiedLabel="Copied" />
{/snippet}

<main
  class="catalog"
  class:compact
  class:wide
  data-spark-theme={theme}
  data-testid="catalog-gallery"
  dir={direction}
>
  <header class="catalog-header">
    <div>
      <p class="eyebrow">Spark internal UI kit</p>
      <h1>Component catalog</h1>
    </div>
    <p class="catalog-summary">
      Protocol-neutral presentation fixtures for conversation and agent workbench surfaces.
    </p>
  </header>

  <nav aria-label="Catalog components">
    {#each catalogFixtures as fixture (fixture.id)}
      <a href={`#${fixture.id}`}>{fixture.title}</a>
    {/each}
  </nav>

  <section class="catalog-grid" aria-label="Component previews">
    {#each catalogFixtures as fixture (fixture.id)}
      <article
        class="catalog-card"
        id={fixture.id}
        data-catalog-fixture={fixture.id}
        data-testid={`catalog-${fixture.id}`}
      >
        <header class="fixture-header">
          <div>
            <p class="fixture-group">{fixture.group}</p>
            <h2>{fixture.title}</h2>
          </div>
          <div class="state-list" aria-label={`${fixture.title} fixture states`}>
            {#each fixture.states as state}
              <span>{state}</span>
            {/each}
          </div>
        </header>
        <p class="fixture-description">{fixture.description}</p>

        <div class="preview" data-preview={fixture.id}>
          {#if fixture.id === "message-shell"}
            <MessageShell
              id="catalog-message"
              actor="spark"
              actorLabel="Spark"
              timestamp="2026-08-10T08:00:00.000Z"
              relativeTime="now"
              status="streaming"
              statusLabel="streaming"
              children={assistantMessage}
              actions={messageActions}
            />
          {:else if fixture.id === "composer"}
            <form onsubmit={(event) => event.preventDefault()}>
              <Composer
                id="catalog-composer"
                placeholder="Ask Spark"
                submitLabel="Send"
                submittingLabel="Sending"
                ariaLabel="Message"
                multilineHint="Command or Control Enter to send"
              />
            </form>
          {:else if fixture.id === "tool-call"}
            <ToolCallPart
              callId="catalog-tool"
              name="workspace.read"
              state="completed"
              summary="Read 4 files and returned a display-safe summary."
              labels={partLabels}
              {statusLabel}
            />
          {/if}
        </div>
      </article>
    {/each}
  </section>
</main>

<style>
  :global(body) {
    min-width: 320px;
  }

  .catalog {
    background: var(--color-canvas);
    color: var(--color-ink);
    min-height: 100vh;
    padding: clamp(18px, 4vw, 48px);
  }

  .catalog-header {
    align-items: end;
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 0.7fr);
    margin: 0 auto;
    max-width: 1120px;
  }

  .eyebrow,
  .fixture-group {
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0 0 6px;
    text-transform: uppercase;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  h1 {
    font-size: clamp(26px, 4vw, 40px);
    letter-spacing: -0.03em;
    margin-bottom: 0;
  }

  h2 {
    font-size: 16px;
    margin-bottom: 0;
  }

  .catalog-summary,
  .fixture-description {
    color: var(--color-ink-muted);
    line-height: 1.6;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 28px auto 20px;
    max-width: 1120px;
  }

  nav a {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    font-size: 12px;
    padding: 7px 11px;
    text-decoration: none;
  }

  nav a:hover {
    border-color: var(--color-border-strong);
    color: var(--color-ink);
  }

  .catalog-grid {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin: 0 auto;
    max-width: 1120px;
  }

  .catalog-card {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    box-shadow: var(--shadow-card);
    min-width: 0;
    padding: 18px;
  }

  .fixture-header {
    align-items: start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
  }

  .state-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: end;
  }

  .state-list span {
    background: var(--color-surface-soft);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    font-size: 10px;
    padding: 3px 6px;
  }

  .fixture-description {
    font-size: 12px;
    margin: 10px 0 16px;
  }

  .preview {
    background: var(--color-canvas);
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--rounded-lg);
    min-width: 0;
    overflow: hidden;
    padding: 16px;
  }

  .preview :global(form) {
    margin: 0;
  }

  @media (max-width: 760px) {
    .catalog-header,
    .catalog-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .catalog-header {
      gap: 10px;
    }

    .fixture-header {
      display: grid;
    }

    .state-list {
      justify-content: start;
    }
  }

  .catalog.compact {
    max-width: 420px;
  }

  .catalog.compact .catalog-header,
  .catalog.compact .catalog-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .catalog.compact .catalog-header {
    gap: 10px;
  }

  .catalog.compact .fixture-header {
    display: grid;
  }

  .catalog.compact .state-list {
    justify-content: start;
  }

  .catalog.wide {
    width: 1024px;
  }

  .catalog.wide .catalog-header {
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 0.7fr);
  }

  .catalog.wide .catalog-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .catalog.wide .fixture-header {
    display: flex;
  }

  .catalog.wide .state-list {
    justify-content: end;
  }
</style>
