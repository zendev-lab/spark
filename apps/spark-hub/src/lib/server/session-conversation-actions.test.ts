import { beforeEach, describe, expect, it, vi } from "vitest";
import { sparkSlashActionBarCatalog } from "@zendev-lab/spark-protocol";

const mocks = vi.hoisted(() => ({
  archiveManagedSessionForHub: vi.fn(),
  cancelConversationTurnForHub: vi.fn(),
  createManagedSessionForHub: vi.fn(),
  getManagedSessionForHub: vi.fn(),
  getProjectedManagedSessionForHub: vi.fn(),
  listManagedSessionsForHub: vi.fn(),
  loadModelControlForHub: vi.fn(),
  loadProjectedModelControlForHub: vi.fn(),
  requireWorkspaceByRouteId: vi.fn(),
  setSessionModelForHub: vi.fn(),
  setSessionThinkingLevelForHub: vi.fn(),
  submitConversationTurnForHub: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  archiveManagedSessionForHub: mocks.archiveManagedSessionForHub,
  createManagedSessionForHub: mocks.createManagedSessionForHub,
  getManagedSessionForHub: mocks.getManagedSessionForHub,
  getProjectedManagedSessionForHub: mocks.getProjectedManagedSessionForHub,
  listManagedSessionsForHub: mocks.listManagedSessionsForHub,
}));

vi.mock("$lib/i18n", () => ({
  localeCookieName: "spark_hub_locale",
  resolveRequestLocale: () => "en",
  getRequestDictionary: () => ({
    sessions: {
      archiveFailed: "Could not archive the session.",
      archiveChannelBound:
        "Message-platform conversations remain managed by their channel and cannot be archived here.",
      archiveSessionRequired: "Select a session to archive.",
      assignArchived: "This session is archived and cannot accept more work.",
      assignFailed: "Could not queue the assignment.",
      assignGoalRequired: "Enter a goal for the assignment.",
      assignQueued: "Assignment queued for the owning Spark daemon.",
      assignSessionRequired: "Select a session before assigning.",
      cancelSessionRequired: "Select a conversation before stopping a turn.",
      cancelTurnArchived: "This conversation is archived and has no active turn to stop.",
      cancelTurnFailed: "Could not stop the active turn.",
      cancelTurnRequired: "Select an active turn to stop.",
      cancelTurnSucceeded: "Cancellation requested for the active turn.",
      cancelTurnDequeued: "Queued turn removed from the queue.",
      createFailed: "Could not create the session.",
      createWorkspaceRequired: "Choose a workspace.",
      effectiveModelMissing: "The Spark daemon did not return an effective conversation model.",
      selectModelRequired: "Select a conversation and model.",
      selectThinkingRequired: "Select a conversation and thinking level.",
      workbench: {
        attachmentCountError: "Attach up to 8 files at a time.",
        attachmentFile: "File",
        attachmentImage: "Image",
        attachmentSizeError: "{name} is larger than 6 MB.",
        attachmentTotalSizeError: "Attachments are larger than 12 MB in total.",
        modelFailed: "Could not switch models.",
        modelUpdated: "Model updated. It will be used for future messages.",
        slashActions: {
          fallbackTitle: "Spark controls",
          fallbackAction: "Unavailable action",
          serverRejected:
            "Use the {title} controls shown above the composer. This slash command was not sent to the model.",
          unsupportedRejected:
            "Slash command /{command} is unknown or not supported in Hub. It was not sent to the model; prefix it with an extra slash (//) to send it as text.",
          titles: { model: "Model controls" },
          descriptions: {},
          actions: {},
          reasons: {},
        },
        thinkingFailed: "Could not update the thinking level.",
        thinkingUpdated: "Thinking level updated. It will be used for future messages.",
      },
    },
  }),
}));

vi.mock("$lib/server/model-control", () => ({
  loadModelControlForHub: mocks.loadModelControlForHub,
  loadProjectedModelControlForHub: mocks.loadProjectedModelControlForHub,
  modelValue: (model: { providerName: string; modelId: string }) =>
    `${model.providerName}/${model.modelId}`,
  parseModelValue: (value: string) => {
    const [providerName, modelId] = value.split("/", 2);
    if (!providerName || !modelId) throw new Error("invalid model");
    return { providerName, modelId };
  },
  parseThinkingLevelValue: (value: string) => value,
  setSessionModelForHub: mocks.setSessionModelForHub,
  setSessionThinkingLevelForHub: mocks.setSessionThinkingLevelForHub,
}));

vi.mock("@zendev-lab/spark-hub-coordination/agents-product", () => ({
  titleFromPrompt: (prompt: string) => {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
  },
}));

vi.mock("$lib/server/conversation-control", () => ({
  cancelConversationTurnForHub: mocks.cancelConversationTurnForHub,
  submitConversationTurnForHub: mocks.submitConversationTurnForHub,
}));

vi.mock("$lib/server/form-data", () => ({
  formText: (formData: FormData, key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  },
}));

vi.mock("$lib/server/db", () => ({ getDatabase: () => ({}) }));
vi.mock("$lib/server/workspace-routing", () => ({
  requireWorkspaceByRouteId: mocks.requireWorkspaceByRouteId,
}));

vi.mock("$lib/server/submission-idempotency", () => ({
  createHubSubmissionId: () => "generated-browser-submission",
  hubSubmissionIdempotencyKey: (submissionId: string, phase: string) =>
    `idem_${phase === "session.create" ? "1" : "2"}${submissionId.length.toString(16).padStart(31, "0")}`,
}));

import { actions, loadSessionsPage as load } from "./session-page-routes";
import { conversationStartSessionId } from "./conversation-submission";

const session = {
  sessionId: "sess_conversation",
  scope: { kind: "workspace" as const, workspaceId: "ws_demo" },
  workspaceId: "ws_demo",
  title: "Initial message",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createManagedSessionForHub.mockResolvedValue(session);
  mocks.getManagedSessionForHub.mockResolvedValue(session);
  mocks.getProjectedManagedSessionForHub.mockReturnValue(session);
  mocks.archiveManagedSessionForHub.mockResolvedValue({
    ...session,
    status: "archived",
  });
  mocks.loadModelControlForHub.mockResolvedValue({
    available: true,
    snapshot: { providers: [], diagnostics: [] },
  });
  mocks.loadProjectedModelControlForHub.mockResolvedValue({
    available: true,
    snapshot: { providers: [], diagnostics: [] },
  });
  mocks.requireWorkspaceByRouteId.mockImplementation((_db, routeId: string) => ({
    id: routeId === "demo" ? "ws_demo" : routeId === "other" ? "ws_other" : routeId,
    slug: routeId,
    name: routeId,
  }));
  mocks.setSessionModelForHub.mockResolvedValue(session);
  mocks.setSessionThinkingLevelForHub.mockResolvedValue(session);
  mocks.cancelConversationTurnForHub.mockResolvedValue({
    turnId: "inv_conversation",
    status: "running",
    cancelRequested: true,
  });
  mocks.submitConversationTurnForHub.mockResolvedValue({ turnId: "turn_conversation" });
  mocks.listManagedSessionsForHub.mockResolvedValue({ available: true, sessions: [] });
});

describe("session conversation actions", () => {
  it("preseeds a non-empty first-message nonce for enhanced and plain HTML submits", async () => {
    const result = await load({
      parent: async () => ({
        activeWorkspace: { id: "ws_demo" },
        sessions: [],
        sessionsAvailable: true,
        sessionControlAvailable: true,
      }),
    } as never);

    expect(result).toMatchObject({
      selectedSessionId: null,
      startSubmissionIdSeed: expect.stringMatching(/^idem_/),
    });
  });

  it("prefers the projected model catalog while the workspace lease is online", async () => {
    const parent = vi.fn().mockResolvedValue({
      activeWorkspace: { id: "ws_demo", slug: "demo", name: "Demo" },
      sessions: [session],
      sessionsAvailable: true,
      sessionControlAvailable: true,
    });

    await expect(load({ parent } as never)).resolves.toMatchObject({
      sessions: [session],
      sessionControlAvailable: true,
    });
    expect(mocks.loadProjectedModelControlForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
    });
    expect(mocks.loadModelControlForHub).not.toHaveBeenCalled();
  });

  it("falls back to the live model catalog when the projection is empty", async () => {
    const parent = vi.fn().mockResolvedValue({
      activeWorkspace: { id: "ws_demo", slug: "demo", name: "Demo" },
      sessions: [session],
      sessionsAvailable: true,
      sessionControlAvailable: true,
    });
    mocks.loadProjectedModelControlForHub.mockResolvedValue({
      available: false,
      snapshot: { providers: [], diagnostics: [] },
    });

    await load({ parent } as never);
    expect(mocks.loadProjectedModelControlForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
    });
    expect(mocks.loadModelControlForHub).toHaveBeenCalledWith({ workspaceId: "ws_demo" });
  });

  it("uses the active workspace model projection while its leased runtime is offline", async () => {
    const parent = vi.fn().mockResolvedValue({
      activeWorkspace: { id: "ws_demo", slug: "demo", name: "Demo" },
      sessions: [session],
      sessionsAvailable: true,
      sessionControlAvailable: false,
    });

    await load({ parent } as never);
    expect(mocks.loadModelControlForHub).not.toHaveBeenCalled();
    expect(mocks.loadProjectedModelControlForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
    });
  });

  it("creates an untitled session, keeps the first prompt as assignment title, and redirects", async () => {
    const action = requireAction("startConversation");

    await expect(
      action(actionEvent({ workspaceId: "ws_demo", message: "  Inspect the daemon path.  " })),
    ).rejects.toMatchObject({
      status: 303,
      location: "/sessions/sess_conversation",
    });

    expect(mocks.createManagedSessionForHub).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      workspaceId: "ws_demo",
      sessionId: expect.stringMatching(/^sess_/),
      idempotencyKey: expect.stringMatching(/^idem_[a-f0-9]{32}$/u),
    });
    expect(mocks.submitConversationTurnForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: "sess_conversation",
      prompt: "Inspect the daemon path.",
      title: "Inspect the daemon path.",
      submissionId: expect.any(String),
    });
    expect(mocks.archiveManagedSessionForHub).not.toHaveBeenCalled();
  });

  it("binds a new conversation to the selected GitChange subdirectory", async () => {
    await expect(
      requireAction("startConversation")(
        actionEvent({
          workspaceId: "ws_demo",
          cwdArtifactRef: "artifact:git:change",
          cwd: "packages/app",
          message: "Inspect this worktree package.",
          submissionId: "cwd-selection",
        }),
      ),
    ).rejects.toMatchObject({ status: 303 });

    expect(mocks.createManagedSessionForHub).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_demo",
        cwdArtifactRef: "artifact:git:change",
        cwd: "packages/app",
        sessionId: conversationStartSessionId(
          "ws_demo",
          "cwd-selection",
          JSON.stringify(["artifact:git:change", "packages/app"]),
        ),
      }),
    );
  });

  it("reuses a deterministic session and turn when the first-message response is retried", async () => {
    const submissionId = "idem_start_018f";
    const deterministicSessionId = conversationStartSessionId("ws_demo", submissionId)!;
    const deterministicSession = { ...session, sessionId: deterministicSessionId };
    mocks.createManagedSessionForHub.mockRejectedValueOnce(
      new Error(`session already exists: ${deterministicSessionId}`),
    );
    mocks.getManagedSessionForHub.mockResolvedValueOnce(deterministicSession);

    await expect(
      requireAction("startConversation")(
        actionEvent({
          workspaceId: "ws_demo",
          message: "Retry this first message once.",
          submissionId,
        }),
      ),
    ).rejects.toMatchObject({
      status: 303,
      location: `/sessions/${deterministicSessionId}`,
    });

    expect(mocks.createManagedSessionForHub).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      workspaceId: "ws_demo",
      sessionId: deterministicSessionId,
      idempotencyKey: expect.stringMatching(/^idem_[a-f0-9]{32}$/u),
    });
    expect(mocks.getManagedSessionForHub).toHaveBeenCalledWith(deterministicSessionId);
    expect(mocks.submitConversationTurnForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: deterministicSessionId,
      prompt: "Retry this first message once.",
      title: "Retry this first message once.",
      submissionId,
    });
  });

  it("requires a workspace target and ignores any legacy daemon scope hint", async () => {
    const result = await requireAction("startConversation")(
      actionEvent({ scopeKind: "daemon", message: "Inspect daemon health." }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "startConversation",
        success: false,
      },
    });
    expect(mocks.createManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.submitConversationTurnForHub).not.toHaveBeenCalled();
  });

  it("preserves the first message and archives the new session when queueing fails", async () => {
    mocks.submitConversationTurnForHub.mockRejectedValue(
      new Error("workspace lease route is offline"),
    );

    const result = await requireAction("startConversation")(
      actionEvent({ workspaceId: "ws_demo", message: "Keep this text" }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "startConversation",
        success: false,
        error: "workspace lease route is offline",
        values: { workspaceId: "ws_demo", message: "Keep this text" },
      },
    });
    expect(mocks.archiveManagedSessionForHub).toHaveBeenCalledWith("sess_conversation");
  });

  it("keeps a deterministic first-message session recoverable when queueing fails", async () => {
    mocks.submitConversationTurnForHub.mockRejectedValue(
      new Error("workspace lease route is offline"),
    );

    const result = await requireAction("startConversation")(
      actionEvent({
        workspaceId: "ws_demo",
        message: "Retry after reconnect",
        submissionId: "idem_start_retry",
      }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "startConversation",
        values: {
          workspaceId: "ws_demo",
          message: "Retry after reconnect",
          submissionId: "idem_start_retry",
        },
      },
    });
    expect(mocks.archiveManagedSessionForHub).not.toHaveBeenCalled();
  });

  it("does not create a session before both workspace and first message are present", async () => {
    const result = await requireAction("startConversation")(
      actionEvent({ workspaceId: "ws_demo", message: "   " }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "startConversation",
        success: false,
        values: { workspaceId: "ws_demo", message: "" },
      },
    });
    expect(mocks.createManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.submitConversationTurnForHub).not.toHaveBeenCalled();
  });

  it("keeps known Hub slash commands out of new and existing model turns", async () => {
    const rejectedInputs = [
      ...Object.keys(sparkSlashActionBarCatalog).map((command) => `/${command}`),
      "/model baidu-oneapi/gpt-5.6-sol",
      "/goal status",
      "/clear",
      "/compact",
      "/new",
      "/runs",
    ];
    for (const slashInput of rejectedInputs) {
      const startResult = await requireAction("startConversation")(
        actionEvent({ workspaceId: "ws_demo", message: slashInput }),
      );

      expect(startResult).toMatchObject({
        status: 400,
        data: {
          intent: "startConversation",
          success: false,
          message: expect.stringContaining("was not sent to the model"),
          values: { workspaceId: "ws_demo", message: slashInput },
        },
      });
    }

    const sendResult = await requireAction("sendMessage")(
      actionEvent({ sessionId: "sess_conversation", message: "/goal restart" }),
    );

    expect(sendResult).toMatchObject({
      status: 400,
      data: {
        intent: "sendMessage",
        success: false,
        message: expect.stringContaining("was not sent to the model"),
        values: { sessionId: "sess_conversation", message: "/goal restart" },
      },
    });
    expect(mocks.createManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.getManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.submitConversationTurnForHub).not.toHaveBeenCalled();
  });

  it("allows an explicitly escaped slash message to reach the model", async () => {
    const result = await requireAction("sendMessage")(
      actionEvent({ sessionId: "sess_conversation", message: "//clear" }),
    );

    expect(result).toMatchObject({
      intent: "sendMessage",
      success: true,
      values: { sessionId: "sess_conversation", message: "" },
    });
    expect(mocks.submitConversationTurnForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: "sess_conversation",
      prompt: "//clear",
      title: "//clear",
      submissionId: expect.any(String),
    });
  });

  it("queues each later message against the existing session", async () => {
    mocks.getManagedSessionForHub.mockRejectedValueOnce(
      new Error(
        "Runtime command is still pending; it remains durable and may complete after reconnect.",
      ),
    );
    const result = await requireAction("sendMessage")(
      actionEvent({ sessionId: "sess_conversation", message: "Now run the focused tests." }),
    );

    expect(result).toEqual({
      intent: "sendMessage",
      success: true,
      message: "Assignment queued for the owning Spark daemon.",
      queuedTurnId: "turn_conversation",
      values: {
        sessionId: "sess_conversation",
        message: "",
        submissionId: expect.any(String),
      },
    });
    expect(mocks.submitConversationTurnForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: "sess_conversation",
      prompt: "Now run the focused tests.",
      title: "Now run the focused tests.",
      submissionId: expect.any(String),
    });
    expect(mocks.getProjectedManagedSessionForHub).toHaveBeenCalledWith("sess_conversation");
    expect(mocks.getManagedSessionForHub).not.toHaveBeenCalled();
  });

  it("accepts an image-only follow-up and forwards its bytes to the daemon turn", async () => {
    const result = await requireAction("sendMessage")(
      actionEvent({
        sessionId: "sess_conversation",
        attachments: [new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })],
      }),
    );

    expect(result).toMatchObject({
      intent: "sendMessage",
      success: true,
      values: { sessionId: "sess_conversation", message: "" },
    });
    expect(mocks.submitConversationTurnForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: "sess_conversation",
      prompt: "[Image: shot.png]",
      title: "[Image: shot.png]",
      attachments: [
        {
          kind: "image",
          name: "shot.png",
          mediaType: "image/png",
          size: 3,
          data: "AQID",
        },
      ],
      submissionId: expect.any(String),
    });
  });

  it("passes the hidden browser submission nonce through the send action", async () => {
    const result = await requireAction("sendMessage")(
      actionEvent({
        sessionId: "sess_conversation",
        message: "Retry the same HTTP submit only once.",
        submissionId: "submit_018f",
      }),
    );

    expect(result).toMatchObject({
      intent: "sendMessage",
      success: true,
      values: { sessionId: "sess_conversation", message: "" },
    });
    expect(mocks.submitConversationTurnForHub).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: "sess_conversation",
      prompt: "Retry the same HTTP submit only once.",
      title: "Retry the same HTTP submit only once.",
      submissionId: "submit_018f",
    });
  });

  it("rejects daemon-global conversations at the workspace-scoped Web boundary", async () => {
    mocks.getProjectedManagedSessionForHub.mockReturnValueOnce({
      ...session,
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "daemon-local" },
      workspaceId: undefined,
    });

    await expect(
      requireAction("sendMessage")(
        actionEvent({ sessionId: "sess_global", message: "Continue globally." }),
      ),
    ).resolves.toMatchObject({
      status: 400,
      data: {
        intent: "sendMessage",
        success: false,
        values: {
          sessionId: "sess_global",
          message: "Continue globally.",
          submissionId: expect.any(String),
        },
      },
    });
    expect(mocks.submitConversationTurnForHub).not.toHaveBeenCalled();
  });

  it("rejects every session mutation action for daemon-global conversations", async () => {
    const globalSession = {
      ...session,
      sessionId: "sess_global",
      scope: { kind: "daemon" as const, daemonId: "daemon-local" },
      workspaceId: undefined,
    };
    mocks.getProjectedManagedSessionForHub.mockReturnValue(globalSession);
    mocks.getManagedSessionForHub.mockResolvedValue(globalSession);

    for (const [name, values] of [
      ["cancelTurn", { sessionId: "sess_global", turnId: "turn_global" }],
      ["selectModel", { sessionId: "sess_global", model: "baidu-oneapi/gpt-5.6-sol" }],
      ["selectThinking", { sessionId: "sess_global", thinkingLevel: "high" }],
      ["archiveSession", { sessionId: "sess_global" }],
    ] as const) {
      await expect(requireAction(name)(actionEvent(values))).resolves.toMatchObject({
        status: 400,
      });
    }

    expect(mocks.cancelConversationTurnForHub).not.toHaveBeenCalled();
    expect(mocks.setSessionModelForHub).not.toHaveBeenCalled();
    expect(mocks.setSessionThinkingLevelForHub).not.toHaveBeenCalled();
    expect(mocks.archiveManagedSessionForHub).not.toHaveBeenCalled();
  });

  it("rejects canonical actions when the URL workspace differs from form or session ownership", async () => {
    await expect(
      requireAction("startConversation")(
        actionEvent({ workspaceId: "ws_demo", message: "Do not cross the boundary." }, "other"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requireAction("sendMessage")(
        actionEvent(
          { sessionId: "sess_conversation", message: "Do not cross the boundary." },
          "other",
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });

    for (const [name, values] of [
      ["cancelTurn", { sessionId: "sess_conversation", turnId: "turn_demo" }],
      ["selectModel", { sessionId: "sess_conversation", model: "provider/model" }],
      ["selectThinking", { sessionId: "sess_conversation", thinkingLevel: "high" }],
      ["archiveSession", { sessionId: "sess_conversation" }],
    ] as const) {
      const result = await Promise.resolve(requireAction(name)(actionEvent(values, "other"))).catch(
        (error) => error,
      );
      expect(result).toMatchObject({ status: expect.any(Number) });
    }

    expect(mocks.createManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.submitConversationTurnForHub).not.toHaveBeenCalled();
    expect(mocks.cancelConversationTurnForHub).not.toHaveBeenCalled();
    expect(mocks.setSessionModelForHub).not.toHaveBeenCalled();
    expect(mocks.setSessionThinkingLevelForHub).not.toHaveBeenCalled();
    expect(mocks.archiveManagedSessionForHub).not.toHaveBeenCalled();
  });

  it("keeps both start phases stable when the same browser form is delivered twice", async () => {
    const action = requireAction("startConversation");
    const values = {
      workspaceId: "ws_demo",
      message: "Submit exactly once.",
      submissionId: "browser-start-submission",
    };

    await expect(action(actionEvent(values))).rejects.toMatchObject({ status: 303 });
    await expect(action(actionEvent(values))).rejects.toMatchObject({ status: 303 });

    const firstCreateKey = mocks.createManagedSessionForHub.mock.calls[0]?.[0].idempotencyKey;
    expect(firstCreateKey).toMatch(/^idem_[a-f0-9]{32}$/u);
    expect(mocks.createManagedSessionForHub.mock.calls[1]?.[0].idempotencyKey).toBe(firstCreateKey);
    expect(mocks.submitConversationTurnForHub.mock.calls[0]?.[0].submissionId).toBe(
      values.submissionId,
    );
    expect(mocks.submitConversationTurnForHub.mock.calls[1]?.[0].submissionId).toBe(
      values.submissionId,
    );
  });

  it("persists a conversation model through the daemon control plane", async () => {
    mocks.setSessionModelForHub.mockResolvedValue({
      ...session,
      model: {
        providerName: "baidu-oneapi",
        modelId: "gpt-5.6-sol",
        providerLabel: "Baidu OneAPI",
        modelLabel: "GPT-5.6 Sol",
      },
    });

    const result = await requireAction("selectModel")(
      actionEvent({ sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" }),
    );

    expect(result).toEqual({
      intent: "selectModel",
      success: true,
      message: "Model updated. It will be used for future messages.",
      model: "baidu-oneapi/gpt-5.6-sol",
      values: { sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" },
    });
    expect(mocks.setSessionModelForHub).toHaveBeenCalledWith("sess_conversation", {
      providerName: "baidu-oneapi",
      modelId: "gpt-5.6-sol",
    });
  });

  it("does not report a model switch before the daemon confirms the effective model", async () => {
    const result = await requireAction("selectModel")(
      actionEvent({ sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "selectModel",
        success: false,
        message: "The Spark daemon did not return an effective conversation model.",
        values: { sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" },
      },
    });
  });

  it("preserves a later message when submission fails", async () => {
    mocks.submitConversationTurnForHub.mockRejectedValue(new Error("queue unavailable"));

    const result = await requireAction("sendMessage")(
      actionEvent({ sessionId: "sess_conversation", message: "Please retry this" }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "sendMessage",
        success: false,
        error: "queue unavailable",
        values: { sessionId: "sess_conversation", message: "Please retry this" },
      },
    });
  });

  it("cancels an active turn only after validating its session", async () => {
    const result = await requireAction("cancelTurn")(
      actionEvent({ sessionId: "sess_conversation", turnId: "inv_conversation" }),
    );

    expect(result).toEqual({
      intent: "cancelTurn",
      success: true,
      cancelled: true,
      message: "Cancellation requested for the active turn.",
      invocationStatus: "running",
      cancelledTurnId: "inv_conversation",
      values: { sessionId: "sess_conversation", turnId: "inv_conversation" },
    });
    expect(mocks.getProjectedManagedSessionForHub).toHaveBeenCalledWith("sess_conversation");
    expect(mocks.getManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.cancelConversationTurnForHub).toHaveBeenCalledWith({
      sessionId: "sess_conversation",
      turnId: "inv_conversation",
    });
  });

  it("removes a queued turn through the same daemon cancellation contract", async () => {
    mocks.cancelConversationTurnForHub.mockResolvedValueOnce({
      turnId: "inv_queued",
      status: "cancelled",
      cancelRequested: true,
    });

    const result = await requireAction("cancelTurn")(
      actionEvent({
        sessionId: "sess_conversation",
        turnId: "inv_queued",
        cancelIntent: "dequeue",
      }),
    );

    expect(result).toEqual({
      intent: "removeQueuedTurn",
      success: true,
      cancelled: true,
      message: "Queued turn removed from the queue.",
      invocationStatus: "cancelled",
      cancelledTurnId: "inv_queued",
      values: { sessionId: "sess_conversation", turnId: "inv_queued" },
    });
    expect(mocks.getProjectedManagedSessionForHub).toHaveBeenCalledWith("sess_conversation");
    expect(mocks.getManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.cancelConversationTurnForHub).toHaveBeenCalledWith({
      sessionId: "sess_conversation",
      turnId: "inv_queued",
    });
  });

  it("reports a cancellation request when a queued turn starts during removal", async () => {
    mocks.cancelConversationTurnForHub.mockResolvedValueOnce({
      turnId: "inv_raced",
      status: "running",
      cancelRequested: true,
    });

    const result = await requireAction("cancelTurn")(
      actionEvent({
        sessionId: "sess_conversation",
        turnId: "inv_raced",
        cancelIntent: "dequeue",
      }),
    );

    expect(result).toMatchObject({
      intent: "removeQueuedTurn",
      success: true,
      message: "Cancellation requested for the active turn.",
      invocationStatus: "running",
    });
  });

  it("accepts an invocation that has already converged to cancelled", async () => {
    mocks.cancelConversationTurnForHub.mockResolvedValueOnce({
      turnId: "inv_cancelled",
      status: "cancelled",
      cancelRequested: false,
    });

    const result = await requireAction("cancelTurn")(
      actionEvent({ sessionId: "sess_conversation", turnId: "inv_cancelled" }),
    );

    expect(result).toMatchObject({
      intent: "cancelTurn",
      success: true,
      message: "Cancellation requested for the active turn.",
      invocationStatus: "cancelled",
    });
  });

  it("treats a terminal invocation as an idempotent stop convergence", async () => {
    mocks.cancelConversationTurnForHub.mockResolvedValueOnce({
      turnId: "inv_stale",
      status: "succeeded",
      cancelRequested: false,
    });

    const result = await requireAction("cancelTurn")(
      actionEvent({ sessionId: "sess_conversation", turnId: "inv_stale" }),
    );

    expect(result).toEqual({
      intent: "cancelTurn",
      success: true,
      cancelled: false,
      converged: true,
      invocationStatus: "succeeded",
      cancelledTurnId: "inv_stale",
      values: { sessionId: "sess_conversation", turnId: "inv_stale" },
    });
  });

  it("rejects a missing or archived session before requesting cancellation", async () => {
    mocks.getProjectedManagedSessionForHub
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ ...session, status: "archived" });

    await expect(
      requireAction("cancelTurn")(
        actionEvent({ sessionId: "sess_missing", turnId: "turn_conversation" }),
      ),
    ).resolves.toMatchObject({
      status: 400,
      data: {
        intent: "cancelTurn",
        error: "Select a conversation before stopping a turn.",
      },
    });
    await expect(
      requireAction("cancelTurn")(
        actionEvent({ sessionId: "sess_conversation", turnId: "turn_conversation" }),
      ),
    ).resolves.toMatchObject({
      status: 400,
      data: {
        intent: "cancelTurn",
        error: "This conversation is archived and has no active turn to stop.",
      },
    });

    expect(mocks.cancelConversationTurnForHub).not.toHaveBeenCalled();
  });

  it("requires both a session and active turn id", async () => {
    await expect(
      requireAction("cancelTurn")(actionEvent({ sessionId: "", turnId: "turn_conversation" })),
    ).resolves.toMatchObject({
      status: 400,
      data: { error: "Select a conversation before stopping a turn." },
    });
    await expect(
      requireAction("cancelTurn")(actionEvent({ sessionId: "sess_conversation", turnId: "" })),
    ).resolves.toMatchObject({
      status: 400,
      data: { error: "Select an active turn to stop." },
    });

    expect(mocks.getManagedSessionForHub).not.toHaveBeenCalled();
    expect(mocks.cancelConversationTurnForHub).not.toHaveBeenCalled();
  });

  it("refuses to archive a message-platform conversation", async () => {
    mocks.getManagedSessionForHub.mockResolvedValueOnce({
      ...session,
      bindings: [
        {
          kind: "channel",
          adapter: "infoflow",
          externalKey: "infoflow:group:10838226",
        },
      ],
    });

    const result = await requireAction("archiveSession")(
      actionEvent({ sessionId: "sess_conversation" }),
    );

    expect(result).toMatchObject({
      status: 409,
      data: {
        intent: "archiveSession",
        message:
          "Message-platform conversations remain managed by their channel and cannot be archived here.",
      },
    });
    expect(mocks.archiveManagedSessionForHub).not.toHaveBeenCalled();
  });
});

function requireAction(name: keyof typeof actions) {
  const action = actions[name];
  if (!action) throw new Error(`Missing action: ${name}`);
  return action;
}

function actionEvent(values: Record<string, string | File | File[]>, workspaceId?: string) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) formData.append(key, item);
    } else {
      formData.set(key, value);
    }
  }
  return {
    cookies: { get: () => undefined },
    locals: { sessionToken: "session-token" },
    params: workspaceId ? { workspaceId } : {},
    request: new Request("http://localhost/sessions", {
      method: "POST",
      body: formData,
    }),
  } as never;
}
