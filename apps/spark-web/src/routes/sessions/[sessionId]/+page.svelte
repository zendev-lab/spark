<script lang="ts">
  import { onMount } from "svelte";
  import { SafeMarkdown } from "@zendev-lab/spark-ui/markdown";
  import {
    ApprovalPart,
    ArtifactPart,
    Composer,
    ConversationViewport,
    ErrorPart,
    ImagePart,
    MessageShell,
    ModelSelector,
    NoticePart,
    ReasoningPart,
    SessionQueue,
    SessionStatusBar,
    SlashCommandMenu,
    TaskRunPart,
    ThinkingChainPart,
    ToolCallPart,
    visibleConversationParts,
    type ConversationMessageView,
    type ConversationPartLabels,
    type SlashCommandSuggestion,
  } from "@zendev-lab/spark-ui/conversation";
  import {
    resolveSessionActivityState,
    sparkSlashCommandDescriptors,
    sparkThinkingLevelOptions,
    type SparkSessionView,
    type SparkThinkingLevel,
  } from "@zendev-lab/spark-protocol";
  import { conversationMessageFromView } from "$lib/conversation";
  import { attachWebSessionEvents } from "$lib/live-events";
  import SessionAskPanel from "$lib/SessionAskPanel.svelte";
  import { parseWebAskQuestions, type PendingWebAsk } from "$lib/pending-ask";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let snapshot = $state<SparkSessionView>(data.snapshot);
  let prompt = $state("");
  let submitting = $state(false);
  let askWaits = $state<PendingWebAsk[]>([]);
  let submittingAskId = $state<string | null>(null);
  let modelValue = $state(
    data.snapshot.model
      ? `${data.snapshot.model.providerName}/${data.snapshot.model.modelId}`
      : "",
  );
  let slashSuggestions = $derived.by((): SlashCommandSuggestion[] => {
    const trimmed = prompt.trim();
    if (!trimmed.startsWith("/")) return [];
    const query = trimmed.slice(1).toLowerCase();
    return sparkSlashCommandDescriptors
      .filter((item) => item.name.startsWith(query) || query.length === 0)
      .map((item) => ({
        id: item.name,
        command: `/${item.name}`,
        title: `/${item.name}`,
        description: item.actionBar.title,
      }));
  });
  let messages = $derived(snapshot.messages.map(conversationMessageFromView));
  let activity = $derived(resolveSessionActivityState({ session: snapshot, projectedTurns: [] }));
  const partLabels: ConversationPartLabels = {
    reasoning: "Reasoning",
    reasoningStreaming: "Reasoning",
    chain: "Working",
    chainStreaming: "Working",
    chainEmpty: "No steps",
    chainFailed: "Failed",
    tool: "Tool",
    task: "Task",
    approval: "Approval",
    unknown: "Unknown",
    collapse: "Collapse",
    expand: "Open",
    budgetExhausted: "Budget exhausted",
    budgetExhaustedHint: "This turn stopped because the agent loop hit its roundtrip budget.",
    runtimeControl: "Runtime",
    runtimeTick: "Tick",
    runtimeRequest: "Request",
    runtimeResult: "Result",
  };
  const statusLabels = {
    bar: "Session status",
    workingDirectory: "Working directory",
    branch: "Branch",
    inputTokens: "In",
    outputTokens: "Out",
    cacheReadTokens: "Cache read",
    cacheWriteTokens: "Cache write",
    cacheHit: "Cache hit",
    cost: "Cost",
    context: "Context",
  };
  const statusLabel = (status: string) => status;

  async function refreshAsks() {
    const listed = await webRpc("human.interaction.list", { sessionId: snapshot.sessionId });
    askWaits = listed.waits
      .filter((wait) => wait.status === "pending")
      .map((wait) => ({
        humanRequestId: wait.humanRequestId,
        interactionRequestId: wait.interactionRequestId,
        sessionId: wait.sessionId,
        title: wait.title,
        prompt: wait.prompt,
        questions: parseWebAskQuestions(wait.questions),
      }));
  }

  onMount(() => {
    void refreshAsks();
    return attachWebSessionEvents(snapshot.sessionId, (view) => {
      snapshot = view;
      void refreshAsks();
    });
  });

  async function submitPrompt(event?: Event) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || submitting) return;
    submitting = true;
    try {
      if (text.startsWith("/")) await applySlash(text);
      else await webRpc("turn.submit", { sessionId: snapshot.sessionId, prompt: text });
      prompt = "";
      snapshot = await webRpc("session.snapshot", { sessionId: snapshot.sessionId });
    } finally {
      submitting = false;
    }
  }

  async function applySlash(text: string) {
    const [name, ...rest] = text.slice(1).split(/\s+/u);
    const argument = rest.join(" ");
    if (name === "model" && argument.includes("/")) {
      const [providerName, modelId] = argument.split("/");
      if (providerName && modelId) {
        await webRpc("session.model.set", {
          sessionId: snapshot.sessionId,
          model: { providerName, modelId },
        });
      }
      return;
    }
    if (name === "thinking" && argument) {
      await webRpc("session.thinking.set", {
        sessionId: snapshot.sessionId,
        thinkingLevel: argument as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
      });
    }
  }

  async function cancelTurn() {
    if (!activity.runningTurnId) return;
    await webRpc("turn.cancel", { invocationId: activity.runningTurnId });
  }

  async function retryTurn() {
    const result = await webRpc("session.retry-target", { sessionId: snapshot.sessionId });
    if (result.target?.invocationId) {
      await webRpc("invocation.retry", { invocationId: result.target.invocationId });
    }
  }

  async function setThinking(thinkingLevel: SparkThinkingLevel) {
    await webRpc("session.thinking.set", { sessionId: snapshot.sessionId, thinkingLevel });
    snapshot = await webRpc("session.snapshot", { sessionId: snapshot.sessionId });
  }

  async function respondAsk(
    wait: PendingWebAsk,
    input: { status: "answered" | "cancelled"; answers: Record<string, unknown> },
  ) {
    if (submittingAskId) return;
    submittingAskId = wait.interactionRequestId;
    try {
      await webRpc("human.interaction.respond", {
        interactionRequestId: wait.interactionRequestId,
        humanRequestId: wait.humanRequestId,
        sessionId: snapshot.sessionId,
        status: input.status,
        answers: input.answers,
      });
      await refreshAsks();
    } finally {
      submittingAskId = null;
    }
  }

  function mediaHref(item: ConversationMessageView, contentIndex: number): string {
    return `/api/v1/sessions/${encodeURIComponent(snapshot.sessionId)}/media/${encodeURIComponent(item.sourceMessageId ?? item.id)}/${contentIndex}`;
  }

  const modelGroups = $derived(
    data.catalog.providers.map((provider) => ({
      id: provider.providerName,
      label: provider.label,
      options: provider.models.map((entry) => ({
        value: `${entry.model.providerName}/${entry.model.modelId}`,
        label: entry.model.modelLabel ?? entry.model.modelId,
        disabled: !entry.available,
      })),
    })),
  );
</script>

<section class="workbench">
  <ConversationViewport label="Transcript" followKey={snapshot.updatedAt} jumpToLatestLabel="Jump to latest">
    {#each messages as item (item.id)}
      <MessageShell
        id={item.id}
        actor={item.actor}
        actorLabel={item.actor}
        timestamp={item.timestamp}
        relativeTime={item.timestamp}
        status={item.status}
      >
        {#each visibleConversationParts(item.parts) as part, partIndex (`${item.id}:${part.type}:${partIndex}`)}
          {#if part.type === "text"}
            {#if item.actor === "spark"}
              <SafeMarkdown source={part.text} streaming={part.streaming} />
            {:else}
              <p>{part.text}</p>
            {/if}
          {:else if part.type === "image"}
            <ImagePart
              sessionId={snapshot.sessionId}
              messageId={item.sourceMessageId ?? item.id}
              contentIndex={part.contentIndex}
              mediaType={part.mediaType}
              name={part.name}
              mediaHref={mediaHref(item, part.contentIndex)}
            />
          {:else if part.type === "reasoning" || part.type === "commentary"}
            <ReasoningPart summary={part.summary} state={part.state} labels={partLabels} />
          {:else if part.type === "chain"}
            <ThinkingChainPart
              state={part.state}
              steps={part.steps}
              labels={partLabels}
              {statusLabel}
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
              previewHref={part.previewHref}
              previewLabel={partLabels.expand}
              {statusLabel}
            />
          {:else if part.type === "error"}
            <ErrorPart title={part.title} message={part.message} code={part.code} />
          {:else if part.type === "notice"}
            <NoticePart title={partLabels.budgetExhausted} message={partLabels.budgetExhaustedHint} />
          {:else if part.type === "quote"}
            <blockquote>{part.text}</blockquote>
          {:else if part.type === "runtime"}
            <p>{partLabels.runtimeControl}: {part.request}</p>
          {:else if part.type === "unknown"}
            <p>{partLabels.unknown}: {part.label}</p>
          {/if}
        {/each}
      </MessageShell>
    {/each}
  </ConversationViewport>

  <SessionQueue
    items={activity.pendingTurns.map((turn) => ({ id: turn.invocationId, text: turn.prompt }))}
    labels={{ region: "Queue", queued: "Queued", next: "Running" }}
    hasRunningTurn={activity.phase === "running"}
  />

  {#if askWaits.length > 0}
    <section class="asks" aria-label="Pending asks">
      {#each askWaits as wait (wait.interactionRequestId)}
        <SessionAskPanel
          ask={wait}
          submitting={submittingAskId === wait.interactionRequestId}
          onRespond={(input) => void respondAsk(wait, input)}
        />
      {/each}
    </section>
  {/if}

  <form onsubmit={(event) => void submitPrompt(event)}>
    <Composer
      id="spark-web-composer"
      bind:value={prompt}
      placeholder="Message Spark. Use / for commands."
      submitLabel="Send"
      submittingLabel="Sending"
      ariaLabel="Prompt"
      multilineHint="⌘/Ctrl+Enter sends"
      submitting={submitting}
    >
      {#snippet header()}
        <div class="controls">
          <ModelSelector
            id="spark-web-model"
            groups={modelGroups}
            bind:value={modelValue}
            label="Model"
            title="Model"
            description="Choose a daemon model"
            placeholder="Select model"
            searchPlaceholder="Search models"
            emptyLabel="No models"
            closeLabel="Close"
            clearSearchLabel="Clear"
            selectedLabel="Selected"
            onCommit={(value) => {
              const [providerName, modelId] = value.split("/");
              if (providerName && modelId) {
                void webRpc("session.model.set", {
                  sessionId: snapshot.sessionId,
                  model: { providerName, modelId },
                });
              }
            }}
          />
          <button type="button" onclick={() => void cancelTurn()} disabled={!activity.runningTurnId}>
            Stop
          </button>
          <button type="button" onclick={() => void retryTurn()}>Retry</button>
          <label>
            Thinking
            <select
              value={snapshot.thinkingLevel ?? "high"}
              onchange={(event) => {
                const value = (event.currentTarget as HTMLSelectElement).value as SparkThinkingLevel;
                if ((sparkThinkingLevelOptions as readonly string[]).includes(value)) {
                  void setThinking(value);
                }
              }}
            >
              {#each sparkThinkingLevelOptions as level (level)}
                <option value={level}>{level}</option>
              {/each}
            </select>
          </label>
        </div>
      {/snippet}
      {#snippet tools()}
        {#if slashSuggestions.length > 0}
          <SlashCommandMenu
            id="spark-web-slash"
            suggestions={slashSuggestions}
            activeIndex={0}
            onSelect={(suggestion) => {
              prompt = `${suggestion.command} `;
            }}
          />
        {/if}
      {/snippet}
    </Composer>
  </form>

  <SessionStatusBar
    labels={statusLabels}
    cwd={snapshot.cwd ?? ""}
    gitBranch={snapshot.gitBranch}
    inputTokens={snapshot.usage?.inputTokens}
    outputTokens={snapshot.usage?.outputTokens}
  />
</section>

<style>
  .workbench {
    height: calc(100vh - 53px);
    display: grid;
    grid-template-rows: 1fr auto auto auto auto;
    gap: 8px;
    padding: 12px;
  }
  .asks {
    display: grid;
    gap: 8px;
    max-height: 42vh;
    overflow: auto;
  }
  .controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }
</style>
