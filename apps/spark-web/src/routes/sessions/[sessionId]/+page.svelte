<script lang="ts">
  import { goto } from "$app/navigation";
  import { SafeMarkdown } from "@zendev-lab/spark-ui/markdown";
  import {
    ApprovalPart,
    ArtifactPart,
    Composer,
    ConversationViewport,
    ErrorPart,
    HumanInteractionPanel,
    ImagePart,
    MessageShell,
    ModelSelector,
    NoticePart,
    ReasoningPart,
    SessionQueue,
    SessionStatusBar,
    SlashActionBar,
    SlashCommandMenu,
    TaskRunPart,
    ThinkingChainPart,
    ToolCallPart,
    visibleConversationParts,
    type ConversationMessageView,
    type ConversationPartLabels,
    type SlashCommandSuggestion,
  } from "@zendev-lab/spark-ui/conversation";
  import { SessionTree, SessionWorkPanel } from "@zendev-lab/spark-ui/workbench";
  import {
    mergeEarlierSparkSessionSnapshotWindow,
    isTerminalSparkHumanInteractionDelivery,
    parseSparkModelValue,
    resolveSessionActivityState,
    sparkActionBarDefaultAction,
    sparkActionViewSchema,
    sparkSlashActionBarForInput,
    sparkSlashCommandDescriptors,
    sparkThinkingLevelOptions,
    type SparkSessionSnapshotPage,
    type SparkSessionProjection,
    type SparkActionView,
    type SparkThinkingLevel,
  } from "@zendev-lab/spark-protocol";
  import { conversationMessageFromView } from "$lib/conversation";
  import { attachWebSessionEvents } from "$lib/live-events";
  import {
    parsePendingHumanInteractions,
    type PendingHumanInteraction,
  } from "$lib/pending-human-interactions";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let windowOverride = $state<SparkSessionSnapshotPage | null>(null);
  let window = $derived(
    windowOverride?.snapshot.sessionId === data.window.snapshot.sessionId
      ? windowOverride
      : data.window,
  );
  let snapshot = $derived(window.snapshot);
  let loadingEarlier = $state(false);
  let treeSessionsOverride = $state<{
    ownerSessionId: string;
    sessions: SparkSessionProjection[];
  } | null>(null);
  let treeSessions = $derived(
    treeSessionsOverride?.ownerSessionId === data.window.snapshot.sessionId
      ? treeSessionsOverride.sessions
      : data.sessions,
  );
  let busySessionId = $state<string | undefined>();
  let treeError = $state<string | null>(null);
  let historyError = $state<string | null>(null);
  let prompt = $state("");
  let submitting = $state(false);
  let actionFeedback = $state<{ tone: "status" | "error"; message: string } | null>(null);
  let artifactPreview = $state<{
    ref: string;
    title: string;
    format: string;
    content: string;
  } | null>(null);
  let askError = $state<string | null>(null);
  let askWaits = $state<PendingHumanInteraction[]>([]);
  let askRefreshToken = 0;
  let modelValue = $state("");
  let ownerModelValue = $state<string | null>(null);
  $effect(() => {
    const selected = snapshot.model
      ? `${snapshot.model.providerName}/${snapshot.model.modelId}`
      : "";
    if (ownerModelValue !== selected) {
      ownerModelValue = selected;
      modelValue = selected;
    }
  });
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
  let slashActionBar = $derived(sparkSlashActionBarForInput(prompt));
  let messages = $derived(snapshot.messages.map(conversationMessageFromView));
  let activity = $derived(resolveSessionActivityState({ session: snapshot, projectedTurns: [] }));
  let currentSession = $derived(treeSessions.find((session) => session.sessionId === snapshot.sessionId));
  let currentWorkspaceId = $derived(currentSession?.scope.kind === "workspace" ? currentSession.scope.workspaceId : undefined);
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

  async function refreshAsks(sessionId = snapshot.sessionId) {
    const refreshToken = ++askRefreshToken;
    try {
      const listed = await webRpc("human.interaction.list", { sessionId });
      if (
        refreshToken !== askRefreshToken ||
        data.window.snapshot.sessionId !== sessionId
      ) {
        return;
      }
      askWaits = parsePendingHumanInteractions(listed);
      askError = null;
    } catch (error) {
      if (
        refreshToken !== askRefreshToken ||
        data.window.snapshot.sessionId !== sessionId
      ) {
        return;
      }
      askWaits = [];
      askError = error instanceof Error ? error.message : String(error);
    }
  }

  $effect(() => {
    const sessionId = data.window.snapshot.sessionId;
    windowOverride = null;
    treeSessionsOverride = null;
    busySessionId = undefined;
    treeError = null;
    loadingEarlier = false;
    historyError = null;
    prompt = "";
    submitting = false;
    actionFeedback = null;
    askWaits = [];
    askError = null;
    void refreshAsks(sessionId);
    return attachWebSessionEvents(sessionId, (latest) => {
      if (latest.snapshot.sessionId !== sessionId) return;
      adoptLiveSnapshot(latest);
      void refreshAsks(sessionId);
    });
  });

  async function submitPrompt(event?: Event) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || submitting) return;
    const ownerSessionId = snapshot.sessionId;
    submitting = true;
    try {
      actionFeedback = null;
      if (text.startsWith("/")) await applySlash(text, ownerSessionId);
      else await webRpc("turn.submit", { sessionId: ownerSessionId, prompt: text });
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      prompt = "";
    } catch (error) {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      actionFeedback = {
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (data.window.snapshot.sessionId === ownerSessionId) submitting = false;
    }
  }

  async function applySlash(text: string, ownerSessionId: string) {
    const [name, ...rest] = text.slice(1).split(/\s+/u);
    const argument = rest.join(" ");
    if (name === "model" && argument.includes("/")) {
      await setModelValue(argument, ownerSessionId);
      return;
    }
    if (name === "thinking" && argument) {
      await webRpc("session.thinking.set", {
        sessionId: ownerSessionId,
        thinkingLevel: argument as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
      });
      return;
    }
    if (name === "compact") {
      const result = await webRpc("session.compact", {
        sessionId: ownerSessionId,
        ...(argument ? { customInstructions: argument } : {}),
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      if (data.window.snapshot.sessionId === ownerSessionId) {
        actionFeedback = {
          tone: "status",
          message: `Compaction queued as ${result.invocationId}.`,
        };
      }
      return;
    }
    if (argument) {
      throw new Error(`/${name} does not accept free-form arguments in Spark Web.`);
    }
    const view = sparkSlashActionBarForInput(text);
    const action = view ? sparkActionBarDefaultAction(view) : undefined;
    if (!action) throw new Error(`Unsupported Spark Web command: /${name}`);
    await handleSlashAction(action, ownerSessionId);
  }

  async function handleSlashAction(
    action: SparkActionView,
    ownerSessionId = snapshot.sessionId,
  ) {
    const ownerSnapshot = snapshot;
    const ownerActivity = activity;
    const ownerTreeSessions = treeSessions;
    const feedback = (message: string) => {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      actionFeedback = { tone: "status", message };
      prompt = "";
    };
    switch (action.intent) {
      case "model.select":
        feedback("Use the model picker above the composer.");
        document.getElementById("spark-web-model")?.focus();
        return;
      case "thinking.select": {
        const level = action.payload.thinkingLevel;
        if (
          typeof level === "string" &&
          (sparkThinkingLevelOptions as readonly string[]).includes(level)
        ) {
          await setThinking(level as SparkThinkingLevel, ownerSessionId);
          feedback(`Thinking set to ${level}.`);
        } else {
          feedback("Use the Thinking selector above the composer.");
        }
        return;
      }
      case "settings.inspect":
      case "settings.providers":
      case "settings.enabled-models":
        prompt = "";
        await goto("/settings");
        return;
      case "status.inspect":
        feedback(`Session status: ${ownerSnapshot.status}.`);
        return;
      case "session.select":
        prompt = "";
        await goto("/sessions");
        return;
      case "session.create": {
        const current = ownerTreeSessions.find((session) => session.sessionId === ownerSessionId);
        prompt = "";
        await goto(current?.scope.kind === "workspace" ? `/workspaces/${current.scope.workspaceId}` : "/");
        return;
      }
      case "session.inspect":
        feedback(`${ownerSnapshot.messages.length} loaded messages · ${ownerSnapshot.tools.length} tools · ${ownerSnapshot.tasks.length} tasks.`);
        return;
      case "queue.inspect":
        feedback(`${ownerActivity.pendingTurns.length} queued turn(s).`);
        document.querySelector<HTMLElement>("[data-session-queue]")?.focus();
        return;
      case "turn.stop":
        await cancelTurn(ownerActivity.runningTurnId);
        feedback("Cancellation requested.");
        return;
      case "turn.retry":
        await retryTurn(ownerSessionId);
        feedback("Retry requested.");
        return;
      case "loop.status": {
        const result = await webRpc("loop.status", {
          ownerSessionId,
          includeTerminal: true,
        });
        feedback(`${result.loops.length} Loop record(s) for this Session.`);
        return;
      }
      case "repro.status": {
        const result = await webRpc("repro.status", { ownerSessionId });
        feedback(result.repro ? `Repro status: ${result.repro.status}.` : "No Repro is bound to this Session.");
        return;
      }
      case "goal.status":
        feedback(ownerSnapshot.work?.goal ? `Goal status: ${ownerSnapshot.work.goal.status}.` : "No Goal is bound to this Session.");
        return;
      case "workflow.open":
      case "workflow.inspect":
        feedback(`${ownerSnapshot.runs.length} Workflow/run projection(s) are visible in this Session.`);
        return;
      case "help.commands":
        feedback(`Commands: ${sparkSlashCommandDescriptors.map((item) => `/${item.name}`).join(", ")}, /compact.`);
        return;
      case "help.hotkeys":
        feedback("Composer: Cmd/Ctrl+Enter sends. Escape closes open dialogs. Tab moves through controls.");
        return;
      case "mode.select":
        throw new Error("Plan/execute/fleet mode switching requires the pending DSH rc.8 daemon-root adapter.");
      case "goal.start":
      case "goal.restart":
      case "goal.stop":
      case "loop.start":
      case "loop.restart":
      case "loop.stop":
      case "repro.start":
      case "repro.stop":
        throw new Error(`${action.label} requires its typed configuration panel; Spark Web will not invent missing owner inputs.`);
    }
  }

  function resolveSlashAction(action: SparkActionView) {
    switch (action.intent) {
      case "mode.select":
      case "goal.start":
      case "goal.restart":
      case "goal.stop":
      case "loop.start":
      case "loop.restart":
      case "loop.stop":
      case "repro.start":
      case "repro.stop":
        return { enabled: false, reason: "This action needs a typed configuration panel." };
      default:
        return { enabled: true };
    }
  }

  function invokeSlashAction(action: SparkActionView) {
    const ownerSessionId = snapshot.sessionId;
    void handleSlashAction(action, ownerSessionId).catch((error) => {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      actionFeedback = {
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    });
  }

  async function cancelTurn(invocationId = activity.runningTurnId) {
    if (!invocationId) return;
    await webRpc("turn.cancel", { invocationId });
  }

  async function retryTurn(sessionId = snapshot.sessionId) {
    const result = await webRpc("session.retry-target", { sessionId });
    if (result.target?.invocationId) {
      await webRpc("invocation.retry", { invocationId: result.target.invocationId });
    }
  }

  async function setThinking(
    thinkingLevel: SparkThinkingLevel,
    sessionId = snapshot.sessionId,
  ) {
    await webRpc("session.thinking.set", { sessionId, thinkingLevel });
  }

  async function setModelValue(value: string, sessionId = snapshot.sessionId) {
    await webRpc("session.model.set", {
      sessionId,
      model: parseSparkModelValue(value),
    });
  }

  function invokeSessionControl(
    ownerSessionId: string,
    operation: () => Promise<void>,
    onError?: () => void,
  ) {
    void operation().catch((error) => {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      onError?.();
      actionFeedback = {
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    });
  }

  function commitModelValue(value: string) {
    const ownerSessionId = snapshot.sessionId;
    invokeSessionControl(
      ownerSessionId,
      () => setModelValue(value, ownerSessionId),
      () => {
        modelValue = ownerModelValue ?? "";
      },
    );
  }

  function stopCurrentTurn() {
    const ownerSessionId = snapshot.sessionId;
    const invocationId = activity.runningTurnId;
    invokeSessionControl(ownerSessionId, () => cancelTurn(invocationId));
  }

  function retryCurrentTurn() {
    const ownerSessionId = snapshot.sessionId;
    invokeSessionControl(ownerSessionId, () => retryTurn(ownerSessionId));
  }

  function changeThinkingLevel(thinkingLevel: SparkThinkingLevel) {
    const ownerSessionId = snapshot.sessionId;
    invokeSessionControl(ownerSessionId, () => setThinking(thinkingLevel, ownerSessionId));
  }

  function adoptLiveSnapshot(latest: SparkSessionSnapshotPage) {
    windowOverride = latest;
  }

  async function loadEarlier() {
    const beforeMessageId = window.history.nextBeforeMessageId;
    if (!beforeMessageId || loadingEarlier) return;
    const ownerSessionId = snapshot.sessionId;
    loadingEarlier = true;
    historyError = null;
    try {
      const page = await webRpc("session.snapshot-page", {
        sessionId: ownerSessionId,
        messageLimit: 32,
        beforeMessageId,
      });
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      windowOverride = mergeEarlierSparkSessionSnapshotWindow(window, page);
    } catch (error) {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      historyError = error instanceof Error ? error.message : String(error);
    } finally {
      if (data.window.snapshot.sessionId === ownerSessionId) loadingEarlier = false;
    }
  }

  async function mutateSessionTree(
    session: SparkSessionProjection,
    action: "archive" | "restore" | "close",
  ) {
    if (busySessionId) return;
    const ownerSessionId = snapshot.sessionId;
    if (
      action === "close" &&
      typeof globalThis.confirm === "function" &&
      !globalThis.confirm(`Close ${session.name ?? session.sessionId}?`)
    ) {
      return;
    }
    busySessionId = session.sessionId;
    treeError = null;
    try {
      const updated =
        action === "archive"
          ? await webRpc("session.archive", { sessionId: session.sessionId, source: "manual" })
          : action === "restore"
            ? await webRpc("session.restore", { sessionId: session.sessionId })
            : await webRpc("session.close", {
                sessionId: session.sessionId,
                reason: "Closed from Spark Web",
              });
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      treeSessionsOverride = {
        ownerSessionId,
        sessions: treeSessions.map((item) =>
          item.sessionId === updated.sessionId ? updated : item,
        ),
      };
      if (session.sessionId === ownerSessionId && action !== "restore") {
        await goto("/sessions");
      }
    } catch (error) {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      treeError = error instanceof Error ? error.message : String(error);
    } finally {
      if (
        data.window.snapshot.sessionId === ownerSessionId &&
        busySessionId === session.sessionId
      ) {
        busySessionId = undefined;
      }
    }
  }

  async function answerAsk(
    interactionRequestId: string,
    response: { status: "answered" | "cancelled"; answers: Record<string, unknown> },
  ) {
    const ownerSessionId = snapshot.sessionId;
    const result = await webRpc("human.interaction.respond", {
      interactionRequestId,
      sessionId: ownerSessionId,
      status: response.status,
      answers: response.answers,
    });
    if (!isTerminalSparkHumanInteractionDelivery(result.outcome)) {
      throw new Error(result.message || "The interaction response was not accepted.");
    }
    if (data.window.snapshot.sessionId === ownerSessionId) {
      await refreshAsks(ownerSessionId);
    }
  }

  async function openArtifact(artifactRef: string) {
    if (!currentWorkspaceId) {
      actionFeedback = { tone: "error", message: "Artifact preview requires a workspace-scoped Session." };
      return;
    }
    const artifact = snapshot.artifacts.find((entry) => entry.ref === artifactRef);
    actionFeedback = null;
    try {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(currentWorkspaceId)}/artifacts/${encodeURIComponent(artifactRef)}`);
      if (!response.ok) throw new Error(`Artifact preview failed: ${response.status}`);
      artifactPreview = {
        ref: artifactRef,
        title: artifact?.title ?? artifactRef,
        format: artifact?.format ?? "text",
        content: await response.text(),
      };
    } catch (error) {
      actionFeedback = { tone: "error", message: error instanceof Error ? error.message : String(error) };
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

<div class="workbench-shell">
  <aside>
    <SessionTree
      sessions={treeSessions}
      selectedSessionId={snapshot.sessionId}
      includeArchived={true}
      {busySessionId}
      labels={{
        region: "Session tree",
        search: "Search sessions",
        empty: "No matching sessions",
        untitled: "Untitled session",
        archived: "Archived",
        orphan: "Missing parent",
        cycle: "Lineage cycle",
        archive: "Archive",
        restore: "Restore",
        close: "Close",
      }}
      hrefFor={(sessionId) => `/sessions/${sessionId}`}
      onArchive={(session) => mutateSessionTree(session as SparkSessionProjection, "archive")}
      onRestore={(session) => mutateSessionTree(session as SparkSessionProjection, "restore")}
      onClose={(session) => mutateSessionTree(session as SparkSessionProjection, "close")}
    />
    {#if treeError}<p class="tree-error" role="alert">{treeError}</p>{/if}
  </aside>
  <section class="workbench">
  {#if window.history.hasEarlierMessages}
    <div class="history-controls">
      <button type="button" onclick={() => void loadEarlier()} disabled={loadingEarlier}>
        {loadingEarlier ? "Loading earlier messages…" : `Load earlier (${window.history.earlierMessages})`}
      </button>
      {#if historyError}<span role="alert">{historyError}</span>{/if}
    </div>
  {/if}
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

  {#if askError}<p class="error" role="alert">{askError}</p>{/if}
  {#if askWaits.length > 0}
    <section class="asks">
      {#each askWaits as wait (wait.interactionRequestId)}
        <HumanInteractionPanel
          title={wait.title}
          prompt={wait.prompt}
          mode={wait.mode}
          questions={wait.questions}
          labels={{
            region: "Pending human interaction",
            customAnswer: "Custom answer",
            customPlaceholder: "Enter an answer",
            selectPlaceholder: "Select an option",
            required: "Answer every required question.",
            answer: "Answer",
            answering: "Sending…",
            cancel: "Cancel",
          }}
          onRespond={(response) => answerAsk(wait.interactionRequestId, response)}
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
            onCommit={commitModelValue}
          />
          <button type="button" onclick={stopCurrentTurn} disabled={!activity.runningTurnId}>
            Stop
          </button>
          <button type="button" onclick={retryCurrentTurn}>Retry</button>
          <label>
            Thinking
            <select
              value={snapshot.thinkingLevel ?? "high"}
              onchange={(event) => {
                const value = (event.currentTarget as HTMLSelectElement).value as SparkThinkingLevel;
                if ((sparkThinkingLevelOptions as readonly string[]).includes(value)) {
                  changeThinkingLevel(value);
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
        {#if slashActionBar}
          <SlashActionBar
            view={slashActionBar}
            disabled={submitting}
            resolveAction={(action) => resolveSlashAction(sparkActionViewSchema.parse(action))}
            onAction={(action) => invokeSlashAction(sparkActionViewSchema.parse(action))}
          />
        {:else if slashSuggestions.length > 0}
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
  {#if actionFeedback}
    <p class:action-error={actionFeedback.tone === "error"} class="action-feedback" role={actionFeedback.tone === "error" ? "alert" : "status"}>
      {actionFeedback.message}
    </p>
  {/if}

  <SessionStatusBar
    labels={statusLabels}
    cwd={snapshot.cwd ?? ""}
    gitBranch={snapshot.gitBranch}
    inputTokens={snapshot.usage?.inputTokens}
    outputTokens={snapshot.usage?.outputTokens}
  />
  </section>
  <SessionWorkPanel
    {snapshot}
    labels={{
      region: "Session workbench",
      work: "Work",
      activity: "Activity",
      details: "Details",
      emptyWork: "No Goal, Repro, Loop, or Task is bound to this Session.",
      emptyActivity: "No Tool or Workflow activity is projected.",
      emptyDetails: "No Artifacts are projected.",
      goal: "Goal",
      repro: "Repro",
      loop: "Loop",
      workflow: "Workflow",
      task: "Task",
      toolInput: "Input",
      toolOutput: "Output",
      toolError: "Error",
      toolEmpty: "No Tool details",
      artifactPreview: "Preview",
      openArtifact: "Open",
    }}
    onOpenArtifact={currentWorkspaceId ? openArtifact : undefined}
  />
</div>

{#if artifactPreview}
  <div class="preview-backdrop" role="presentation">
    <div class="artifact-preview" role="dialog" aria-modal="true" tabindex="-1" aria-label={`Artifact preview: ${artifactPreview.title}`}>
      <header>
        <div><strong>{artifactPreview.title}</strong><code>{artifactPreview.ref}</code></div>
        <button type="button" onclick={() => (artifactPreview = null)}>Close</button>
      </header>
      {#if artifactPreview.format === "markdown"}
        <SafeMarkdown source={artifactPreview.content} />
      {:else}
        <pre>{artifactPreview.content}</pre>
      {/if}
    </div>
  </div>
{/if}

<style>
  .workbench-shell {
    display: grid;
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(260px, 340px);
    height: calc(100vh - 53px);
    min-height: 0;
  }
  aside {
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    min-height: 0;
    overflow: auto;
    padding: 12px;
  }
  .tree-error {
    color: var(--color-danger);
    font-size: var(--text-caption);
  }
  .workbench {
    min-height: 0;
    display: grid;
    grid-template-rows: 1fr auto auto auto;
    gap: 8px;
    padding: 12px;
  }
  .history-controls {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  @media (max-width: 760px) {
    .workbench-shell {
      display: block;
      height: auto;
    }
    aside {
      border-bottom: 1px solid var(--color-border);
      border-right: 0;
      max-height: 34vh;
    }
    .workbench {
      height: 66vh;
    }
  }
  .controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .action-feedback {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    margin: 0;
  }
  .action-feedback.action-error {
    color: var(--color-danger);
  }
  .preview-backdrop { align-items: center; background: color-mix(in srgb, var(--color-canvas) 72%, transparent); display: flex; inset: 0; justify-content: center; padding: 20px; position: fixed; z-index: 20; }
  .artifact-preview { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--rounded-lg); box-shadow: var(--shadow-lg); display: grid; gap: 12px; max-height: min(80vh, 760px); max-width: min(900px, 92vw); overflow: auto; padding: 16px; width: 100%; }
  .artifact-preview header { align-items: start; display: flex; justify-content: space-between; }
  .artifact-preview header div { display: grid; gap: 3px; }
  .artifact-preview pre { font-family: var(--font-mono); margin: 0; overflow: auto; white-space: pre-wrap; }
  .artifact-preview button { background: transparent; border: 1px solid var(--color-border); border-radius: var(--rounded-sm); color: var(--color-ink); cursor: pointer; padding: 5px 8px; }
</style>
