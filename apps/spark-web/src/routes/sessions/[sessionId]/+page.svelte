<script lang="ts">
  import { tick } from "svelte";
  import { goto } from "$app/navigation";
  import { Button, Icon, Select, type SelectGroup } from "@zendev-lab/spark-ui";
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
    SPARK_TURN_ATTACHMENT_MAX_BYTES,
    SPARK_TURN_ATTACHMENT_MAX_COUNT,
    SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES,
    type SparkSessionSnapshotPage,
    type SparkSessionProjection,
    type SparkActionView,
    type SparkThinkingLevel,
  } from "@zendev-lab/spark-protocol";
  import { conversationMessageFromView } from "$lib/conversation";
  import { attachWebSessionEvents } from "$lib/live-events";
  import { explicitMemoryRefs, sparkWebTurnMessageMetadata } from "$lib/memory-feedback";
  import {
    parsePendingHumanInteractions,
    type PendingHumanInteraction,
  } from "$lib/pending-human-interactions";
  import { webRpc } from "$lib/web-rpc";

  let { data } = $props();
  let copy = $derived(data.messages.web.session);
  let workbenchCopy = $derived(data.messages.shared.workbench);
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
  let pendingAttachments = $state<
    Array<{
      kind: "image" | "file";
      name: string;
      mediaType: string;
      size: number;
      data: string;
    }>
  >([]);
  let attachmentError = $state<string | null>(null);
  let submitting = $state(false);
  let actionFeedback = $state<{ tone: "status" | "error"; message: string } | null>(null);
  let artifactPreview = $state<{
    ref: string;
    title: string;
    format: string;
    content: string;
  } | null>(null);
  let artifactPreviewElement = $state<HTMLElement>();
  let artifactPreviewReturnFocus: HTMLElement | null = null;
  let askError = $state<string | null>(null);
  let askWaits = $state<PendingHumanInteraction[]>([]);
  let askRefreshToken = 0;
  let artifactPreviewRequestToken = 0;
  let modelValue = $state("");
  let ownerModelValue = $state<string | null>(null);
  let modelCommitRequestToken = 0;
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchResults = $state<
    Array<{ messageId: string; ref: string; role: string; excerpt: string }>
  >([]);
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let searchRequestToken = 0;
  let revealSearchRequestToken = 0;
  let shareHref = $state<string | null>(null);
  let sharing = $state(false);
  let memoryFeedbackBusy = $state("");
  let memoryFeedbackRequestToken = 0;
  let actionFeedbackRequestToken = 0;
  let activeOwnerSessionId: string | undefined;
  let detachSessionEvents: (() => void) | undefined;
  const notifiedAskIds = new Set<string>();

  function ownsActionFeedback(ownerSessionId: string, requestToken: number): boolean {
    return (
      data.window.snapshot.sessionId === ownerSessionId &&
      requestToken === actionFeedbackRequestToken
    );
  }

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
      .map((item) => {
        const titles = data.messages.shared.workbench.slashActions.titles as Record<
          string,
          string
        >;
        return {
          id: item.name,
          command: `/${item.name}`,
          title: `/${item.name}`,
          description: titles[item.actionBar.id] ?? item.actionBar.title,
        };
      });
  });
  let slashActionBar = $derived.by(() => {
    const view = sparkSlashActionBarForInput(prompt);
    if (!view) return undefined;
    const messages = data.messages.shared.workbench.slashActions;
    const titles = messages.titles as Record<string, string>;
    const descriptions = messages.descriptions as Record<string, string>;
    const actions = messages.actions as Record<string, string>;
    return {
      ...view,
      title: titles[view.id] ?? view.title,
      description: descriptions[view.id] ?? view.description,
      actions: view.actions.map((action) => ({
        ...action,
        label: actions[action.id] ?? action.label,
      })),
    };
  });
  let thinkingGroups = $derived.by((): SelectGroup[] => {
    const actions = data.messages.shared.workbench.slashActions.actions as Record<string, string>;
    return [
      {
        id: "thinking-levels",
        options: sparkThinkingLevelOptions.map((level) => ({
          value: level,
          label: actions[`thinking-${level}`] ?? level,
        })),
      },
    ];
  });
  let messages = $derived(snapshot.messages.map(conversationMessageFromView));
  let activity = $derived(resolveSessionActivityState({ session: snapshot, projectedTurns: [] }));
  let currentSession = $derived(treeSessions.find((session) => session.sessionId === snapshot.sessionId));
  let currentWorkspaceId = $derived(currentSession?.scope.kind === "workspace" ? currentSession.scope.workspaceId : undefined);
  let partLabels: ConversationPartLabels = $derived({
    reasoning: workbenchCopy.reasoning,
    reasoningStreaming: workbenchCopy.reasoningStreaming,
    chain: workbenchCopy.chain,
    chainStreaming: workbenchCopy.chainStreaming,
    chainEmpty: workbenchCopy.chainEmpty,
    chainFailed: workbenchCopy.chainFailed,
    tool: workbenchCopy.tool,
    task: workbenchCopy.task,
    approval: workbenchCopy.approval,
    unknown: workbenchCopy.unknownPart,
    collapse: workbenchCopy.collapse,
    expand: workbenchCopy.expand,
    budgetExhausted: workbenchCopy.budgetExhausted,
    budgetExhaustedHint: workbenchCopy.budgetExhaustedHint,
    runtimeControl: workbenchCopy.runtimeControl,
    runtimeTick: workbenchCopy.runtimeTick,
    runtimeRequest: workbenchCopy.runtimeRequest,
    runtimeResult: workbenchCopy.runtimeResult,
  });
  let statusLabels = $derived({
    bar: workbenchCopy.runtimeStatusBar,
    workingDirectory: workbenchCopy.workingDirectory,
    branch: workbenchCopy.gitBranch,
    inputTokens: workbenchCopy.inputTokens,
    outputTokens: workbenchCopy.outputTokens,
    cacheReadTokens: workbenchCopy.cacheReadTokens,
    cacheWriteTokens: workbenchCopy.cacheWriteTokens,
    cacheHit: workbenchCopy.cacheHit,
    cost: workbenchCopy.cost,
    context: workbenchCopy.contextUsage,
  });
  const statusLabel = (status: string) => data.messages.shared.status[status] ?? status;

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
      const pending = parsePendingHumanInteractions(listed);
      for (const wait of pending) {
        if (notifiedAskIds.has(wait.interactionRequestId)) continue;
        notifiedAskIds.add(wait.interactionRequestId);
        void notifyWhenHidden(
          "Spark is waiting for you",
          wait.title,
          `ask-${wait.interactionRequestId}`,
          sessionId,
        );
      }
      askWaits = pending;
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
    if (activeOwnerSessionId === sessionId) return;
    activeOwnerSessionId = sessionId;
    detachSessionEvents?.();
    windowOverride = null;
    treeSessionsOverride = null;
    busySessionId = undefined;
    treeError = null;
    loadingEarlier = false;
    historyError = null;
    prompt = "";
    pendingAttachments = [];
    attachmentError = null;
    submitting = false;
    actionFeedback = null;
    artifactPreview = null;
    artifactPreviewRequestToken += 1;
    searchOpen = false;
    searchQuery = "";
    searchResults = [];
    searching = false;
    searchError = null;
    searchRequestToken += 1;
    revealSearchRequestToken += 1;
    memoryFeedbackRequestToken += 1;
    actionFeedbackRequestToken += 1;
    modelCommitRequestToken += 1;
    memoryFeedbackBusy = "";
    shareHref = null;
    sharing = false;
    notifiedAskIds.clear();
    askWaits = [];
    askError = null;
    void refreshAsks(sessionId);
    detachSessionEvents = attachWebSessionEvents(sessionId, (latest) => {
      if (latest.snapshot.sessionId !== sessionId) return;
      const wasBusy = ["queued", "running", "streaming"].includes(snapshot.status);
      adoptLiveSnapshot(latest);
      if (
        wasBusy &&
        !["queued", "running", "streaming"].includes(latest.snapshot.status)
      ) {
        void notifyWhenHidden(
          "Spark turn completed",
          currentSession?.name ?? sessionId,
          `turn-${sessionId}`,
          sessionId,
        );
      }
      void refreshAsks(sessionId);
    });
  });

  $effect(() => () => detachSessionEvents?.());

  $effect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (artifactPreview) {
        event.preventDefault();
        void closeArtifactPreview();
      } else if (searchOpen) {
        searchOpen = false;
      }
    };
    addEventListener("keydown", keydown);
    return () => removeEventListener("keydown", keydown);
  });

  $effect(() => {
    const ownerSessionId = data.window.snapshot.sessionId;
    const messageId = data.requestedMessageId;
    if (messageId) void revealSearchMatch(messageId, ownerSessionId);
    else revealSearchRequestToken += 1;
  });

  async function submitPrompt(event?: Event) {
    event?.preventDefault();
    const text = prompt.trim();
    if ((!text && pendingAttachments.length === 0) || submitting) return;
    const ownerSessionId = snapshot.sessionId;
    const feedbackRequestToken = ++actionFeedbackRequestToken;
    const attachments = pendingAttachments;
    submitting = true;
    try {
      actionFeedback = null;
      if (text.startsWith("/")) {
        if (pendingAttachments.length > 0) {
          throw new Error("Slash commands cannot include attachments.");
        }
        await applySlash(text, ownerSessionId, feedbackRequestToken);
      } else {
        await webRpc("turn.submit", {
          sessionId: ownerSessionId,
          prompt: text,
          ...(attachments.length > 0 ? { attachments } : {}),
          messageMetadata: sparkWebTurnMessageMetadata(),
        });
      }
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      prompt = "";
      pendingAttachments = [];
      attachmentError = null;
    } catch (error) {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      if (ownsActionFeedback(ownerSessionId, feedbackRequestToken)) {
        actionFeedback = {
          tone: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      if (data.window.snapshot.sessionId === ownerSessionId) submitting = false;
    }
  }

  function memoryRefsInMessage(item: ConversationMessageView): string[] {
    if (item.actor !== "spark") return [];
    return explicitMemoryRefs(
      item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
  }

  async function submitMemoryFeedback(
    memoryRef: string,
    outcome: "positive" | "negative",
  ) {
    const feedbackKey = `${memoryRef}:${outcome}`;
    if (memoryFeedbackBusy) return;
    const ownerSessionId = snapshot.sessionId;
    const requestToken = ++memoryFeedbackRequestToken;
    const feedbackRequestToken = ++actionFeedbackRequestToken;
    memoryFeedbackBusy = feedbackKey;
    actionFeedback = { tone: "status", message: copy.memoryFeedbackSending };
    try {
      await webRpc("turn.submit", {
        sessionId: ownerSessionId,
        prompt: `memory feedback ${outcome} ${memoryRef}`,
        messageMetadata: sparkWebTurnMessageMetadata(),
      });
      if (
        data.window.snapshot.sessionId !== ownerSessionId ||
        requestToken !== memoryFeedbackRequestToken
      ) {
        return;
      }
      if (ownsActionFeedback(ownerSessionId, feedbackRequestToken)) {
        actionFeedback = { tone: "status", message: copy.memoryFeedbackSent };
      }
    } catch (caught) {
      if (
        data.window.snapshot.sessionId !== ownerSessionId ||
        requestToken !== memoryFeedbackRequestToken
      ) {
        return;
      }
      if (ownsActionFeedback(ownerSessionId, feedbackRequestToken)) {
        actionFeedback = {
          tone: "error",
          message: caught instanceof Error ? caught.message : String(caught),
        };
      }
    } finally {
      if (
        data.window.snapshot.sessionId === ownerSessionId &&
        requestToken === memoryFeedbackRequestToken &&
        memoryFeedbackBusy === feedbackKey
      ) {
        memoryFeedbackBusy = "";
      }
    }
  }

  async function applySlash(
    text: string,
    ownerSessionId: string,
    feedbackRequestToken: number,
  ) {
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
      if (ownsActionFeedback(ownerSessionId, feedbackRequestToken)) {
        actionFeedback = {
          tone: "status",
          message: `Compaction queued as ${result.invocationId}.`,
        };
      }
      return;
    }
    if (name === "plan" || name === "execute" || name === "fleet") {
      // One-shot directives are parsed by the daemon on the ordinary
      // turn-submission channel; no separate RPC exists for them.
      await webRpc("turn.submit", {
        sessionId: ownerSessionId,
        prompt: text,
        messageMetadata: sparkWebTurnMessageMetadata(),
      });
      return;
    }
    if (argument) {
      throw new Error(`/${name} does not accept free-form arguments in Spark Web.`);
    }
    const view = sparkSlashActionBarForInput(text);
    const action = view ? sparkActionBarDefaultAction(view) : undefined;
    if (!action) throw new Error(`Unsupported Spark Web command: /${name}`);
    await handleSlashAction(action, ownerSessionId, feedbackRequestToken);
  }

  async function handleSlashAction(
    action: SparkActionView,
    ownerSessionId: string,
    feedbackRequestToken: number,
  ) {
    const ownerSnapshot = snapshot;
    const ownerActivity = activity;
    const ownerTreeSessions = treeSessions;
    const feedback = (message: string) => {
      if (!ownsActionFeedback(ownerSessionId, feedbackRequestToken)) return;
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
      case "directive.run": {
        const directive = action.payload.directive;
        if (directive !== "plan" && directive !== "execute" && directive !== "fleet") {
          throw new Error(copy.directiveUnsupported);
        }
        await webRpc("turn.submit", {
          sessionId: ownerSessionId,
          prompt: `/${directive}`,
          messageMetadata: sparkWebTurnMessageMetadata(),
        });
        feedback(`${copy.directiveIssued} /${directive}.`);
        return;
      }
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
    const feedbackRequestToken = ++actionFeedbackRequestToken;
    void handleSlashAction(action, ownerSessionId, feedbackRequestToken).catch((error) => {
      if (!ownsActionFeedback(ownerSessionId, feedbackRequestToken)) return;
      actionFeedback = {
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    });
  }

  async function cancelQueuedTurn(invocationId: string) {
    const ownerSessionId = snapshot.sessionId;
    const feedbackRequestToken = ++actionFeedbackRequestToken;
    try {
      actionFeedback = null;
      await webRpc("turn.cancel", {
        invocationId,
        reason: "Removed from Spark Web queue",
      });
    } catch (error) {
      if (!ownsActionFeedback(ownerSessionId, feedbackRequestToken)) return;
      actionFeedback = {
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function addAttachments(event: Event) {
    const ownerSessionId = snapshot.sessionId;
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length === 0) return;
    attachmentError = null;
    try {
      if (pendingAttachments.length + files.length > SPARK_TURN_ATTACHMENT_MAX_COUNT) {
        throw new Error(`A turn supports at most ${SPARK_TURN_ATTACHMENT_MAX_COUNT} attachments.`);
      }
      const added = [];
      for (const file of files) {
        if (file.size > SPARK_TURN_ATTACHMENT_MAX_BYTES) {
          throw new Error(`${file.name} exceeds the 6 MiB per-file limit.`);
        }
        added.push({
          kind: file.type.startsWith("image/") ? ("image" as const) : ("file" as const),
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        });
      }
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      const currentAttachments = pendingAttachments;
      if (currentAttachments.length + added.length > SPARK_TURN_ATTACHMENT_MAX_COUNT) {
        throw new Error(`A turn supports at most ${SPARK_TURN_ATTACHMENT_MAX_COUNT} attachments.`);
      }
      const totalBytes = [...currentAttachments, ...added].reduce(
        (total, item) => total + item.size,
        0,
      );
      if (totalBytes > SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES) {
        throw new Error("Turn attachments exceed the 12 MiB total limit.");
      }
      pendingAttachments = [...currentAttachments, ...added];
    } catch (error) {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      attachmentError = error instanceof Error ? error.message : String(error);
    }
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function searchHistory(event?: Event) {
    event?.preventDefault();
    const query = searchQuery.trim();
    if (!query || searching) return;
    const ownerSessionId = snapshot.sessionId;
    const requestToken = ++searchRequestToken;
    searching = true;
    searchError = null;
    try {
      const result = await webRpc("session.search", {
        sessionId: ownerSessionId,
        query,
        limit: 100,
      });
      if (
        requestToken !== searchRequestToken ||
        data.window.snapshot.sessionId !== ownerSessionId
      ) {
        return;
      }
      searchResults = result.matches;
    } catch (error) {
      if (
        requestToken !== searchRequestToken ||
        data.window.snapshot.sessionId !== ownerSessionId
      ) {
        return;
      }
      searchError = error instanceof Error ? error.message : String(error);
    } finally {
      if (
        requestToken === searchRequestToken &&
        data.window.snapshot.sessionId === ownerSessionId
      ) {
        searching = false;
      }
    }
  }

  async function revealSearchMatch(messageId: string, ownerSessionId = snapshot.sessionId) {
    const requestToken = ++revealSearchRequestToken;
    const ownsReveal = () =>
      requestToken === revealSearchRequestToken &&
      data.window.snapshot.sessionId === ownerSessionId;
    let current = window;
    try {
      while (
        !current.snapshot.messages.some((message) => message.id === messageId) &&
        current.history.nextBeforeMessageId
      ) {
        const page = await webRpc("session.snapshot-page", {
          sessionId: ownerSessionId,
          messageLimit: 100,
          beforeMessageId: current.history.nextBeforeMessageId,
        });
        if (!ownsReveal()) return;
        current = mergeEarlierSparkSessionSnapshotWindow(current, page);
      }
      if (!ownsReveal()) return;
      windowOverride = current;
      await tick();
      if (!ownsReveal()) return;
      document.getElementById(messageId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      if (!ownsReveal()) return;
      searchError = error instanceof Error ? error.message : String(error);
    }
  }

  async function createLocalShare() {
    if (sharing) return;
    const ownerSessionId = snapshot.sessionId;
    const feedbackRequestToken = ++actionFeedbackRequestToken;
    sharing = true;
    actionFeedback = null;
    try {
      const response = await fetch(
        `/api/v1/sessions/${encodeURIComponent(ownerSessionId)}/share`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`Local Share failed: ${response.status}`);
      const result = (await response.json()) as { href: string };
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      shareHref = result.href;
      if (ownsActionFeedback(ownerSessionId, feedbackRequestToken)) {
        actionFeedback = {
          tone: "status",
          message: "Created a random read-only Share for this Spark Web process.",
        };
      }
    } catch (error) {
      if (!ownsActionFeedback(ownerSessionId, feedbackRequestToken)) return;
      actionFeedback = {
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (data.window.snapshot.sessionId === ownerSessionId) sharing = false;
    }
  }

  async function notifyWhenHidden(
    title: string,
    body: string,
    tag: string,
    sessionId = snapshot.sessionId,
  ) {
    if (
      !document.hidden ||
      !("Notification" in globalThis) ||
      Notification.permission !== "granted" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({
      type: "spark.notification",
      notification: {
        title,
        body,
        tag,
        url: `/sessions/${encodeURIComponent(sessionId)}`,
      },
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
    const feedbackRequestToken = ++actionFeedbackRequestToken;
    actionFeedback = null;
    void operation().catch((error) => {
      if (data.window.snapshot.sessionId !== ownerSessionId) return;
      onError?.();
      if (!ownsActionFeedback(ownerSessionId, feedbackRequestToken)) return;
      actionFeedback = {
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    });
  }

  function commitModelValue(value: string) {
    const ownerSessionId = snapshot.sessionId;
    const requestToken = ++modelCommitRequestToken;
    invokeSessionControl(
      ownerSessionId,
      () => setModelValue(value, ownerSessionId),
      () => {
        if (requestToken !== modelCommitRequestToken) return;
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
    const ownerSessionId = snapshot.sessionId;
    const feedbackRequestToken = ++actionFeedbackRequestToken;
    const workspaceId = currentWorkspaceId;
    const requestToken = ++artifactPreviewRequestToken;
    if (!workspaceId) {
      if (ownsActionFeedback(ownerSessionId, feedbackRequestToken)) {
        actionFeedback = { tone: "error", message: "Artifact preview requires a workspace-scoped Session." };
      }
      return;
    }
    const artifact = snapshot.artifacts.find((entry) => entry.ref === artifactRef);
    artifactPreviewReturnFocus =
      globalThis.document?.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : null;
    actionFeedback = null;
    artifactPreview = null;
    try {
      const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactRef)}`);
      if (!response.ok) throw new Error(`Artifact preview failed: ${response.status}`);
      const content = await response.text();
      if (
        requestToken !== artifactPreviewRequestToken ||
        data.window.snapshot.sessionId !== ownerSessionId
      ) {
        return;
      }
      artifactPreview = {
        ref: artifactRef,
        title: artifact?.title ?? artifactRef,
        format: artifact?.format ?? "text",
        content,
      };
      await tick();
      artifactPreviewElement?.focus();
    } catch (error) {
      if (
        requestToken !== artifactPreviewRequestToken ||
        data.window.snapshot.sessionId !== ownerSessionId
      ) {
        return;
      }
      if (ownsActionFeedback(ownerSessionId, feedbackRequestToken)) {
        actionFeedback = { tone: "error", message: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  async function closeArtifactPreview() {
    artifactPreview = null;
    await tick();
    artifactPreviewReturnFocus?.focus();
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

{#snippet queueActions(item: { id: string })}
  <button type="button" class="queue-remove" onclick={() => void cancelQueuedTurn(item.id)}>
    {copy.removeQueued}
  </button>
{/snippet}

<div class="workbench-shell">
  <aside>
    <SessionTree
      sessions={treeSessions}
      selectedSessionId={snapshot.sessionId}
      includeArchived={true}
      {busySessionId}
      labels={copy.tree}
      hrefFor={(sessionId) => `/sessions/${sessionId}`}
      onArchive={(session) => mutateSessionTree(session as SparkSessionProjection, "archive")}
      onRestore={(session) => mutateSessionTree(session as SparkSessionProjection, "restore")}
      onClose={(session) => mutateSessionTree(session as SparkSessionProjection, "close")}
    />
    {#if treeError}<p class="tree-error" role="alert">{treeError}</p>{/if}
  </aside>
  <section class="workbench">
  <div class="session-actions" aria-label={copy.actions}>
    <button type="button" onclick={() => (searchOpen = !searchOpen)}>{copy.searchHistory}</button>
    <details>
      <summary>{copy.export}</summary>
      <div class="export-menu">
        {#each ["jsonl", "json", "text", "html"] as format}
          <a href={`/api/v1/sessions/${encodeURIComponent(snapshot.sessionId)}/export?format=${format}`}>{format.toUpperCase()}</a>
        {/each}
      </div>
    </details>
    <button type="button" onclick={() => void createLocalShare()} disabled={sharing}>
      {sharing ? copy.sharing : copy.localShare}
    </button>
    {#if shareHref}<a href={shareHref} target="_blank" rel="noreferrer">{copy.openShare}</a>{/if}
  </div>
  {#if searchOpen}
    <section class="history-search" aria-label={copy.historySearchRegion}>
      <form onsubmit={(event) => void searchHistory(event)}>
        <label for="session-history-search">{copy.historySearchLabel}</label>
        <div><input id="session-history-search" type="search" bind:value={searchQuery} required /><button type="submit" disabled={searching}>{searching ? data.messages.web.shell.searching : data.messages.web.shell.search}</button></div>
      </form>
      {#if searchError}<p role="alert">{searchError}</p>{/if}
      {#if searchResults.length > 0}
        <ul>
          {#each searchResults as result (result.ref)}
            <li><button type="button" onclick={() => void revealSearchMatch(result.messageId)}><strong>{result.role}</strong><span>{result.excerpt}</span></button></li>
          {/each}
        </ul>
      {:else if searchQuery && !searching}
        <p>{copy.noSearchMatches}</p>
      {/if}
    </section>
  {/if}
  {#if window.history.hasEarlierMessages}
    <div class="history-controls">
      <button type="button" onclick={() => void loadEarlier()} disabled={loadingEarlier}>
        {loadingEarlier ? copy.loadingEarlier : `${copy.loadEarlier} (${window.history.earlierMessages})`}
      </button>
      {#if historyError}<span role="alert">{historyError}</span>{/if}
    </div>
  {/if}
  <ConversationViewport label={copy.transcript} followKey={snapshot.updatedAt} jumpToLatestLabel={copy.jumpToLatest}>
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
        {#if memoryRefsInMessage(item).length > 0}
          <div class="memory-feedback">
            {#each memoryRefsInMessage(item) as memoryRef (memoryRef)}
              <code>{memoryRef}</code>
              <button type="button" aria-label={`${copy.memoryHelpful}: ${memoryRef}`} title={copy.memoryHelpful} disabled={Boolean(memoryFeedbackBusy)} onclick={() => void submitMemoryFeedback(memoryRef, "positive")}>👍</button>
              <button type="button" aria-label={`${copy.memoryUnhelpful}: ${memoryRef}`} title={copy.memoryUnhelpful} disabled={Boolean(memoryFeedbackBusy)} onclick={() => void submitMemoryFeedback(memoryRef, "negative")}>👎</button>
            {/each}
          </div>
        {/if}
      </MessageShell>
    {/each}
  </ConversationViewport>

  <SessionQueue
    items={activity.pendingTurns.map((turn) => ({ id: turn.invocationId, text: turn.prompt }))}
    labels={{ region: copy.queue, queued: copy.queued, next: copy.running }}
    hasRunningTurn={activity.phase === "running"}
    actions={queueActions}
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
          labels={copy.human}
          onRespond={(response) => answerAsk(wait.interactionRequestId, response)}
        />
      {/each}
    </section>
  {/if}

  <form onsubmit={(event) => void submitPrompt(event)}>
    <Composer
      id="spark-web-composer"
      bind:value={prompt}
      placeholder={copy.prompt}
      submitLabel={copy.send}
      submittingLabel={copy.sending}
      ariaLabel={copy.promptLabel}
      multilineHint={copy.sendHint}
      submitting={submitting}
    >
      {#snippet attachments()}
        <div class="attachment-list">
          {#each pendingAttachments as attachment, index (`${attachment.name}:${attachment.size}:${index}`)}
            <span>
              {attachment.name} · {Math.ceil(attachment.size / 1024)} KiB
              <button type="button" aria-label={`${copy.removeAttachment} ${attachment.name}`} onclick={() => (pendingAttachments = pendingAttachments.filter((_, itemIndex) => itemIndex !== index))}>×</button>
            </span>
          {/each}
          {#if attachmentError}<span class="attachment-error" role="alert">{attachmentError}</span>{/if}
        </div>
      {/snippet}
      {#snippet actions()}
        <label class="attach-button">
          <span>{copy.addFiles}</span>
          <input type="file" multiple onchange={(event) => void addAttachments(event)} />
        </label>
      {/snippet}
      {#snippet header()}
        <div class="controls">
          <ModelSelector
            id="spark-web-model"
            groups={modelGroups}
            bind:value={modelValue}
            label={copy.model}
            title={copy.model}
            description={copy.chooseModel}
            placeholder={copy.selectModel}
            searchPlaceholder={copy.searchModels}
            emptyLabel={copy.noModels}
            closeLabel={copy.close}
            clearSearchLabel={copy.clear}
            selectedLabel={copy.selected}
            onCommit={commitModelValue}
          />
          <Button
            type="button"
            variant="danger"
            size="compact"
            onclick={stopCurrentTurn}
            disabled={!activity.runningTurnId}
          >
            <Icon name="stop" size={13} />
            {copy.stop}
          </Button>
          <Button type="button" variant="secondary" size="compact" onclick={retryCurrentTurn}>
            <Icon name="retry" size={13} />
            {copy.retry}
          </Button>
          <div class="thinking-control">
            <span>{copy.thinking}</span>
            <Select
              id="spark-web-thinking"
              value={snapshot.thinkingLevel ?? "high"}
              groups={thinkingGroups}
              label={copy.thinking}
              compact
              onValueChange={(value) => {
                if ((sparkThinkingLevelOptions as readonly string[]).includes(value)) {
                  changeThinkingLevel(value as SparkThinkingLevel);
                }
              }}
            />
          </div>
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
    labels={copy.work}
    onOpenArtifact={currentWorkspaceId ? openArtifact : undefined}
  />
</div>

{#if artifactPreview}
  <div class="preview-backdrop" role="presentation">
    <div bind:this={artifactPreviewElement} class="artifact-preview" role="dialog" aria-modal="true" tabindex="-1" aria-label={`Artifact preview: ${artifactPreview.title}`}>
      <header>
        <div><strong>{artifactPreview.title}</strong><code>{artifactPreview.ref}</code></div>
        <button type="button" onclick={() => void closeArtifactPreview()}>{copy.close}</button>
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
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }
  .session-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .session-actions button,
  .session-actions summary,
  .session-actions a,
  .queue-remove,
  .attach-button {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-sm);
    color: var(--color-ink);
    cursor: pointer;
    font: inherit;
    padding: 5px 8px;
    text-decoration: none;
  }
  .session-actions details {
    position: relative;
  }
  .session-actions summary {
    list-style: none;
  }
  .export-menu {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-sm);
    box-shadow: var(--shadow-card-raised);
    display: grid;
    gap: 4px;
    padding: 6px;
    position: absolute;
    z-index: 4;
  }
  .history-search {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    display: grid;
    gap: 8px;
    max-height: 34vh;
    overflow: auto;
    padding: 10px;
  }
  .history-search form,
  .history-search form div {
    display: flex;
    gap: 8px;
  }
  .history-search form {
    flex-direction: column;
  }
  .history-search input {
    flex: 1;
    min-width: 0;
  }
  .history-search ul {
    display: grid;
    gap: 4px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .history-search li button {
    background: transparent;
    border: 0;
    color: var(--color-ink);
    cursor: pointer;
    display: grid;
    gap: 2px;
    padding: 6px;
    text-align: start;
    width: 100%;
  }
  .history-controls {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .memory-feedback {
    align-items: center;
    color: var(--color-ink-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .memory-feedback code {
    font-size: 11px;
  }
  .memory-feedback button {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-sm);
    cursor: pointer;
    padding: 3px 5px;
  }
  .memory-feedback button:disabled {
    cursor: wait;
    opacity: 0.55;
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
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .thinking-control {
    align-items: center;
    color: var(--color-ink-muted);
    display: flex;
    font-size: var(--text-caption);
    gap: 6px;
  }
  .thinking-control > span {
    white-space: nowrap;
  }
  .attachment-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .attachment-list > span {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 999px;
    display: inline-flex;
    gap: 4px;
    padding: 3px 8px;
  }
  .attachment-list button {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
  }
  .attachment-error {
    color: var(--color-danger);
  }
  .attach-button input {
    block-size: 1px;
    inline-size: 1px;
    opacity: 0;
    position: absolute;
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
