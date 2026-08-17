import { DatabaseSync } from "node:sqlite";
import {
  humanRequestCreatedEnvelopeSchema,
  parseSparkInteractionRequest,
  type SparkInteractionRequest,
} from "@zendev-lab/spark-protocol";
import { SparkHostRuntime } from "@zendev-lab/spark-host";
import { describe, expect, it, vi } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import {
  SparkDaemonHumanInteractionBroker,
  type SparkDaemonHumanInteractionOpened,
  type SparkDaemonHumanInteractionRoute,
} from "./human-interactions.ts";
import { SparkDaemonHumanWaitRegistry } from "./human-waits.ts";

const RUNTIME_ID = `rt_${"1".repeat(32)}`;
const WORKSPACE_BINDING_ID = `rtwb_${"2".repeat(32)}`;
const LOCAL_WORKSPACE_BINDING_ID = `rtwb_${"3".repeat(32)}`;
const WORKSPACE_ID = `ws_${"4".repeat(32)}`;
const PROJECT_ID = `proj_${"5".repeat(32)}`;
const WORKSPACE_PATH = "/workspace/spark";
const NOW = "2026-07-14T00:00:00.000Z";
const SERVER_URL = "http://127.0.0.1:5173/";

interface SeedHumanRouteOptions {
  serverId?: string;
  serverUrl?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  workspacePath?: string;
  localWorkspaceKey?: string;
  displayName?: string;
  slug?: string;
}

function seedHumanRoute(db: DatabaseSync, options: SeedHumanRouteOptions = {}): void {
  const serverId = options.serverId ?? "rnsrv-test";
  const serverUrl = options.serverUrl ?? SERVER_URL;
  const workspaceBindingId = options.workspaceBindingId ?? WORKSPACE_BINDING_ID;
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  const workspacePath = options.workspacePath ?? WORKSPACE_PATH;
  const localWorkspaceKey = options.localWorkspaceKey ?? "server-spark";
  const displayName = options.displayName ?? "Spark";
  const slug = options.slug ?? "spark";
  db.prepare(
    `INSERT INTO daemon_servers (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run(serverId, serverUrl, NOW);
  db.prepare(
    `INSERT INTO workspaces
      (id, server_url, local_workspace_key, display_name, local_path, status,
       capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(workspaceBindingId, serverUrl, localWorkspaceKey, displayName, workspacePath, NOW, NOW);
  db.prepare(
    `INSERT INTO daemon_workspaces
      (id, server_id, server_workspace_id, name, slug, local_path, registered_at,
       last_known_status, last_status_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
  ).run(workspaceBindingId, serverId, workspaceId, displayName, slug, workspacePath, NOW, NOW);
}

function primaryRuntimeId(route: SparkDaemonHumanInteractionRoute): string | undefined {
  return route.serverUrl === SERVER_URL ? RUNTIME_ID : undefined;
}

function askRequest(
  requestId: string,
  delivery: "blocking" | "async",
  timeoutMs?: number,
  evidenceRequest?: Extract<SparkInteractionRequest, { kind: "askFlow" }>["evidenceRequest"],
  toSessionId?: string,
): Extract<SparkInteractionRequest, { kind: "askFlow" }> {
  return parseSparkInteractionRequest({
    requestId,
    kind: "askFlow",
    title: "Choose a direction",
    prompt: "How should Spark continue?",
    delivery,
    ...(evidenceRequest ? { evidenceRequest } : {}),
    ...(toSessionId ? { toSessionId } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    mode: "decision",
    source: "daemon",
    questions: [
      {
        id: "decision",
        prompt: "Continue?",
        type: "single",
        required: true,
        options: [
          {
            value: "yes",
            label: "Continue",
            description: "Resume execution",
            preview: "Proceed with the current plan.",
          },
          { value: "no", label: "Stop" },
        ],
      },
    ],
    metadata: { source: "test" },
  }) as Extract<SparkInteractionRequest, { kind: "askFlow" }>;
}

function interactionContext() {
  return {
    sessionId: "session-1",
    invocationId: "invocation-1",
    workspaceBindingId: WORKSPACE_BINDING_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    toolCallId: "tool-call-1",
    channel: {
      workspaceId: WORKSPACE_ID,
      adapterId: "qq-main",
      recipient: "c2c:user-1",
      actorId: "user-1",
      messageId: "message-1",
    },
  };
}

describe("SparkDaemonHumanInteractionBroker", () => {
  it("opens an async ask durably and immediately returns its human request handle", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const onOutboxReady = vi.fn(async () => undefined);
    const opened: SparkDaemonHumanInteractionOpened[] = [];
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
      onOutboxReady,
      onRequestOpened: async (input) => {
        opened.push(input);
      },
    });

    try {
      const evidenceRequest = {
        schema: "spark.evidence-request/v1" as const,
        askRef: `ask:${"e".repeat(64)}`,
        ownerSessionId: "session-1",
        goalOrReproId: "repro:async",
        modeScope: "repro" as const,
        planRevision: 4,
        ownerStepOrUnresolvedId: "step:decision",
        stepDefinitionDigest: "decision-digest",
        requestHash: "e".repeat(64),
        ownerQuestionId: "decision",
        expectedAnswerKind: "single" as const,
      };
      const response = await broker.interact(
        askRequest("ask_async:" + "e".repeat(64), "async", undefined, evidenceRequest),
        {
          ...interactionContext(),
        },
      );

      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: `ask_async:${"e".repeat(64)}`,
        status: "pending",
        nextAction: "resume",
        metadata: { delivery: "async", evidenceRequest },
      });
      expect(response.kind === "askFlow" ? response.humanRequestId : undefined).toEqual(
        expect.any(String),
      );
      if (response.kind !== "askFlow" || !response.humanRequestId) {
        throw new Error("expected an async ask response with humanRequestId");
      }

      expect(waits.hasActive(response.humanRequestId)).toBe(false);
      expect(waits.get(response.humanRequestId)).toMatchObject({
        interactionRequestId: `ask_async:${"e".repeat(64)}`,
        delivery: "async",
        status: "pending",
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
        evidenceRequest,
      });
      expect(onOutboxReady).toHaveBeenCalledTimes(1);
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({
          kind: "human.request.created",
          envelope: expect.objectContaining({
            type: "human.request.created",
            runtimeId: RUNTIME_ID,
            workspaceBindingId: WORKSPACE_BINDING_ID,
            workspaceId: WORKSPACE_ID,
            humanRequestId: response.humanRequestId,
            payload: expect.objectContaining({
              delivery: "async",
              interactionRequestId: `ask_async:${"e".repeat(64)}`,
              evidenceRequest,
            }),
          }),
        }),
      ]);
      const envelope = waits.listPendingOutbox()[0]?.envelope;
      expect(envelope).toBeDefined();
      const parsedEnvelope = humanRequestCreatedEnvelopeSchema.parse(envelope);
      expect(parsedEnvelope.invocationId).toMatch(/^inv_[a-f0-9]{32}$/u);
      expect(parsedEnvelope.payload.questions[0]?.options?.[0]?.preview).toBe(
        "Proceed with the current plan.",
      );

      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        wait: { humanRequestId: response.humanRequestId, delivery: "async" },
        request: { requestId: `ask_async:${"e".repeat(64)}`, kind: "askFlow" },
        channel: { adapterId: "qq-main", recipient: "c2c:user-1" },
      });
      expect(opened[0]?.callbackOptions).toHaveLength(2);
      const firstCallback = opened[0]?.callbackOptions[0];
      expect(firstCallback?.token).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(firstCallback?.token).not.toContain("ask_async");
      expect(waits.findCallback(firstCallback?.token ?? "")).toMatchObject({
        wait: { humanRequestId: response.humanRequestId },
        questionId: "decision",
        value: "yes",
        label: "Continue",
      });

      const restartedWaits = new SparkDaemonHumanWaitRegistry(db);
      const restartedBroker = new SparkDaemonHumanInteractionBroker({
        db,
        waits: restartedWaits,
        getRuntimeId: primaryRuntimeId,
      });
      const restartedWait = restartedWaits.get(response.humanRequestId);
      if (!restartedWait) throw new Error("pending async evidence request did not survive restart");
      const accepted = await restartedBroker.respond(restartedWait, {
        humanResponseId: "hres-async-evidence",
        status: "answered",
        provenance: "direct_user",
        answers: { decision: "yes" },
        responseArtifactRefs: [],
      });
      const replayed = await restartedBroker.respond(restartedWait, {
        humanResponseId: "hres-async-evidence",
        status: "answered",
        provenance: "direct_user",
        answers: { decision: "tampered" },
        responseArtifactRefs: [],
      });
      expect(accepted).toMatchObject({
        outcome: "accepted",
        returnedToTool: false,
        answerEvent: {
          binding: evidenceRequest,
          answers: { decision: { questionId: "decision", values: ["yes"] } },
          provenance: "direct_user",
        },
      });
      expect(replayed).toMatchObject({
        outcome: "replayed",
        answerEvent: {
          answers: { decision: { questionId: "decision", values: ["yes"] } },
        },
      });
      expect(restartedWaits.listEvidenceAnswerEvents(response.humanRequestId)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("replays a settled ask after restart by stable toolCallId, not interaction flow text", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const opened = vi.fn(async () => undefined);
    const firstWaits = new SparkDaemonHumanWaitRegistry(db);
    const firstBroker = new SparkDaemonHumanInteractionBroker({
      db,
      waits: firstWaits,
      getRuntimeId: primaryRuntimeId,
      onRequestOpened: opened,
    });

    try {
      const initial = await firstBroker.interact(
        {
          ...askRequest("interaction-before-restart", "async"),
          toolCallId: "tool-call-repro-repair",
        },
        interactionContext(),
      );
      if (initial.kind !== "askFlow" || !initial.humanRequestId) {
        throw new Error("expected an async ask response with humanRequestId");
      }
      const wait = firstWaits.get(initial.humanRequestId);
      if (!wait) throw new Error("expected the durable async wait");
      await firstBroker.respond(wait, {
        status: "answered",
        provenance: "direct_user",
        answers: { decision: "yes" },
        responseArtifactRefs: [],
      });

      const restartedWaits = new SparkDaemonHumanWaitRegistry(db);
      const restartedBroker = new SparkDaemonHumanInteractionBroker({
        db,
        waits: restartedWaits,
        getRuntimeId: primaryRuntimeId,
        onRequestOpened: opened,
      });
      const resumed = await restartedBroker.interact(
        {
          ...askRequest("interaction-after-restart", "blocking", 500),
          toolCallId: "tool-call-repro-repair",
        },
        {
          ...interactionContext(),
          invocationId: "invocation-2",
        },
      );

      expect(resumed).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-after-restart",
        humanRequestId: initial.humanRequestId,
        status: "answered",
        answers: { decision: "yes" },
        nextAction: "resume",
        metadata: { delivery: "blocking", humanResponseId: expect.stringMatching(/^hres_/u) },
      });
      expect(opened).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_human_waits").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  it("keeps a blocking ask pending until delivery resolves its attached continuation", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      let settled = false;
      const pendingResponse = broker.interact(askRequest("interaction-blocking", "blocking", 500), {
        ...interactionContext(),
        sessionSource: "tui",
      });
      void pendingResponse.then(() => {
        settled = true;
      });

      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      await Promise.resolve();
      expect(settled).toBe(false);
      const wait = waits.listPending()[0];
      expect(wait).toMatchObject({
        interactionRequestId: "interaction-blocking",
        delivery: "blocking",
        status: "pending",
      });
      expect(waits.hasActive(wait!.humanRequestId)).toBe(true);

      await expect(
        broker.respond(wait!, {
          status: "answered",
          provenance: "direct_user",
          answers: {
            decision: {
              values: ["yes"],
              labels: ["Continue"],
            },
          },
          responseArtifactRefs: [],
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        returnedToTool: true,
        winnerResponseId: expect.stringMatching(/^hres_/u),
      });

      const answeredResponse = await pendingResponse;
      expect(answeredResponse).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-blocking",
        humanRequestId: wait!.humanRequestId,
        status: "answered",
        answers: {
          decision: {
            values: ["yes"],
            labels: ["Continue"],
          },
        },
        nextAction: "resume",
        metadata: {
          delivery: "blocking",
          humanResponseId: expect.stringMatching(/^hres_/u),
        },
      });
      expect(answeredResponse.metadata.timedOut).toBeUndefined();
      expect(waits.hasActive(wait!.humanRequestId)).toBe(false);
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({ kind: "human.request.created" }),
        expect.objectContaining({
          kind: "human.response.recorded",
          envelope: expect.objectContaining({
            type: "human.response.recorded",
            runtimeId: RUNTIME_ID,
            workspaceBindingId: WORKSPACE_BINDING_ID,
            workspaceId: WORKSPACE_ID,
            payload: expect.objectContaining({
              source: "daemon",
              status: "answered",
            }),
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("durably closes a blocking ask when its human wait times out", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      const response = await broker.interact(
        askRequest("interaction-human-timeout", "blocking", 10),
        interactionContext(),
      );

      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-human-timeout",
        status: "cancelled",
        nextAction: "cancel",
        metadata: {
          delivery: "blocking",
          timedOut: true,
          humanResponseId: expect.stringMatching(/^hres_/u),
        },
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({ kind: "human.request.created" }),
        expect.objectContaining({
          kind: "human.response.recorded",
          envelope: expect.objectContaining({
            payload: expect.objectContaining({ status: "cancelled" }),
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps a route-less TUI blocking ask locally answerable without a Hub outbox", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const onOutboxReady = vi.fn();
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
      onOutboxReady,
    });

    try {
      const pendingResponse = broker.interact(askRequest("interaction-local-tui", "blocking"), {
        sessionId: "session-local-tui",
        invocationId: "invocation-local-tui",
        sessionSource: "tui",
      });
      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      const wait = waits.listPending()[0]!;

      expect(wait.context).toMatchObject({
        sessionSource: "tui",
        hubProjected: false,
      });
      expect(waits.listPendingOutbox()).toEqual([]);
      expect(onOutboxReady).not.toHaveBeenCalled();

      await expect(
        broker.respond(wait, {
          status: "answered",
          provenance: "direct_user",
          answers: { decision: "yes" },
          responseArtifactRefs: [],
        }),
      ).resolves.toMatchObject({ outcome: "accepted", returnedToTool: true });
      await expect(pendingResponse).resolves.toMatchObject({
        kind: "askFlow",
        requestId: "interaction-local-tui",
        status: "answered",
        answers: { decision: "yes" },
      });
      expect(waits.listPendingOutbox()).toEqual([]);
      expect(onOutboxReady).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("settles a blocking wait from the daemon interaction event seen by the local TUI", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });
    const request = askRequest("interaction-event-to-local-answer", "blocking");
    let observedRequests = 0;
    let localAnswer: Promise<void> | undefined;
    const runtime = new SparkHostRuntime({
      cwd: WORKSPACE_PATH,
      hasUI: true,
      sessionSource: "tui",
      invocationId: "invocation-event-to-local-answer",
      ui: {
        interaction: async (interactionRequest) =>
          await broker.interact(parseSparkInteractionRequest(interactionRequest), {
            sessionId: "session-event-to-local-answer",
            invocationId: "invocation-event-to-local-answer",
            sessionSource: "tui",
          }),
      },
    });
    runtime.setSessionId("session-event-to-local-answer");
    runtime.onDaemonEvent((event) => {
      if (event.type !== "daemon.interaction.request") return;
      observedRequests += 1;
      localAnswer = Promise.resolve().then(async () => {
        const wait = waits.requireUniquePendingInteraction({
          interactionRequestId: event.request.requestId,
          sessionId: event.sessionId,
          invocationId: event.invocationId,
        });
        await broker.respond(wait, {
          status: "answered",
          provenance: "direct_user",
          answers: { decision: "yes" },
          responseArtifactRefs: [],
        });
      });
    });

    try {
      const response = await runtime.requestInteraction(request);
      await localAnswer;
      expect(observedRequests).toBe(1);
      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-event-to-local-answer",
        status: "answered",
        answers: { decision: "yes" },
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("still blocks a route-less non-TUI ask instead of creating an unanswerable wait", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });

    try {
      await expect(
        broker.interact(askRequest("interaction-route-less-web", "blocking"), {
          sessionId: "session-route-less-web",
          invocationId: "invocation-route-less-web",
          sessionSource: "web",
        }),
      ).resolves.toMatchObject({
        kind: "askFlow",
        requestId: "interaction-route-less-web",
        status: "blocked",
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("opens a route-less daemon blocking ask for bounded local answering", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });

    try {
      const pendingResponse = broker.interact(
        askRequest("interaction-route-less-daemon", "blocking", 1_000),
        {
          sessionId: "session-route-less-daemon",
          invocationId: "invocation-route-less-daemon",
          sessionSource: "daemon",
        },
      );
      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      const wait = waits.listPending()[0]!;
      expect(wait).toMatchObject({
        interactionRequestId: "interaction-route-less-daemon",
        sessionId: "session-route-less-daemon",
        delivery: "blocking",
      });

      await expect(
        broker.respond(wait, {
          status: "answered",
          provenance: "direct_user",
          answers: { decision: "yes" },
          responseArtifactRefs: [],
        }),
      ).resolves.toMatchObject({ outcome: "accepted", returnedToTool: true });
      await expect(pendingResponse).resolves.toMatchObject({
        requestId: "interaction-route-less-daemon",
        status: "answered",
        answers: { decision: "yes" },
      });
    } finally {
      db.close();
    }
  });

  it("cancels a route-less TUI blocking ask without inventing a Hub settlement", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });
    const abort = new AbortController();

    try {
      const pendingResponse = broker.interact(askRequest("interaction-local-abort", "blocking"), {
        sessionId: "session-local-abort",
        invocationId: "invocation-local-abort",
        sessionSource: "tui",
        signal: abort.signal,
      });
      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      abort.abort();

      await expect(pendingResponse).resolves.toMatchObject({
        requestId: "interaction-local-abort",
        status: "cancelled",
        nextAction: "cancel",
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("durably projects cancellation when a blocking daemon ask is aborted", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });
    const abort = new AbortController();

    try {
      const pendingResponse = broker.interact(askRequest("interaction-aborted", "blocking"), {
        ...interactionContext(),
        signal: abort.signal,
      });
      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      abort.abort();

      await expect(pendingResponse).resolves.toMatchObject({
        kind: "askFlow",
        requestId: "interaction-aborted",
        status: "cancelled",
        nextAction: "cancel",
      });
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({ kind: "human.request.created" }),
        expect.objectContaining({
          kind: "human.response.recorded",
          envelope: expect.objectContaining({
            type: "human.response.recorded",
            payload: expect.objectContaining({ source: "daemon", status: "cancelled" }),
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("maps a daemon-local workspace reference to its unique Hub route by local path", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    db.prepare(
      `INSERT INTO workspaces
        (id, server_url, local_workspace_key, display_name, local_path, status,
         capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, '', 'local-spark', 'Local Spark', ?, 'available', '{}', '{}', ?, ?)`,
    ).run(LOCAL_WORKSPACE_BINDING_ID, WORKSPACE_PATH, NOW, NOW);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      const response = await broker.interact(askRequest("interaction-local", "async"), {
        sessionId: "session-local",
        invocationId: "queue-file.json",
        workspaceId: LOCAL_WORKSPACE_BINDING_ID,
      });

      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-local",
        status: "pending",
      });
      if (response.kind !== "askFlow" || !response.humanRequestId) {
        throw new Error("expected a mapped async ask response");
      }
      expect(waits.get(response.humanRequestId)).toMatchObject({
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
      });
      humanRequestCreatedEnvelopeSchema.parse(waits.listPendingOutbox()[0]?.envelope);
    } finally {
      db.close();
    }
  });

  it("selects the runtime identity from each workspace's Hub server route", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const secondRuntimeId = `rt_${"6".repeat(32)}`;
    const secondBindingId = `rtwb_${"7".repeat(32)}`;
    const secondWorkspaceId = `ws_${"8".repeat(32)}`;
    const secondServerUrl = "https://hub.example.test/";
    seedHumanRoute(db, {
      serverId: "rnsrv-second",
      serverUrl: secondServerUrl,
      workspaceBindingId: secondBindingId,
      workspaceId: secondWorkspaceId,
      workspacePath: "/workspace/second",
      localWorkspaceKey: "server-second",
      displayName: "Second",
      slug: "second",
    });
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const getRuntimeId = vi.fn((route: SparkDaemonHumanInteractionRoute) => {
      if (route.serverUrl === SERVER_URL) return RUNTIME_ID;
      if (route.serverUrl === secondServerUrl) return secondRuntimeId;
      return undefined;
    });
    const broker = new SparkDaemonHumanInteractionBroker({ db, waits, getRuntimeId });

    try {
      await broker.interact(askRequest("interaction-primary-server", "async"), {
        sessionId: "session-primary-server",
        invocationId: "invocation-primary-server",
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
      });
      await broker.interact(askRequest("interaction-second-server", "async"), {
        sessionId: "session-second-server",
        invocationId: "invocation-second-server",
        workspaceBindingId: secondBindingId,
        workspaceId: secondWorkspaceId,
      });

      expect(getRuntimeId).toHaveBeenNthCalledWith(1, {
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
      });
      expect(getRuntimeId).toHaveBeenNthCalledWith(2, {
        workspaceBindingId: secondBindingId,
        workspaceId: secondWorkspaceId,
        serverUrl: secondServerUrl,
      });
      expect(
        waits.listPendingOutbox().map(({ envelope }) => ({
          runtimeId: envelope.runtimeId,
          workspaceBindingId: envelope.workspaceBindingId,
          workspaceId: envelope.workspaceId,
        })),
      ).toEqual([
        {
          runtimeId: RUNTIME_ID,
          workspaceBindingId: WORKSPACE_BINDING_ID,
          workspaceId: WORKSPACE_ID,
        },
        {
          runtimeId: secondRuntimeId,
          workspaceBindingId: secondBindingId,
          workspaceId: secondWorkspaceId,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("projects toolApproval as a blocking ask and maps approve answers back", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      const pendingResponse = broker.interact(
        parseSparkInteractionRequest({
          requestId: "tool-approval-1",
          kind: "toolApproval",
          title: "Approve tool: cue_exec",
          toolName: "cue_exec",
          toolCallId: "call-1",
          reason: "Shell command requires approval",
          approveLabel: "Approve",
          rejectLabel: "Reject",
          source: "daemon",
          metadata: { source: "test" },
        }),
        {
          ...interactionContext(),
          sessionSource: "tui",
        },
      );

      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      const wait = waits.listPending()[0]!;
      expect(wait).toMatchObject({
        interactionRequestId: "tool-approval-1",
        delivery: "blocking",
        kind: "ask_user",
        title: "Approve tool: cue_exec",
      });
      expect(wait.context).toMatchObject({
        interactionKind: "toolApproval",
        toolApproval: { toolName: "cue_exec", toolCallId: "call-1" },
      });

      await expect(
        broker.respond(wait, {
          status: "answered",
          provenance: "direct_user",
          answers: {
            approval: {
              values: ["approve"],
              labels: ["Approve"],
            },
          },
          responseArtifactRefs: [],
        }),
      ).resolves.toMatchObject({ outcome: "accepted", returnedToTool: true });

      await expect(pendingResponse).resolves.toMatchObject({
        kind: "toolApproval",
        requestId: "tool-approval-1",
        status: "answered",
        approved: true,
      });
    } finally {
      db.close();
    }
  });

  it("delivers a session-addressed ask without Hub Inbox projection", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const onOutboxReady = vi.fn(async () => undefined);
    const onRequestOpened = vi.fn(async () => undefined);
    const deliverSessionAsk = vi.fn(async () => undefined);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
      onOutboxReady,
      onRequestOpened,
      deliverSessionAsk,
    });

    try {
      const response = await broker.interact(
        askRequest("interaction-session-ask", "async", undefined, undefined, "sess_target"),
        interactionContext(),
      );
      expect(response).toMatchObject({
        kind: "askFlow",
        status: "pending",
        requestId: "interaction-session-ask",
      });
      expect(deliverSessionAsk).toHaveBeenCalledWith(
        expect.objectContaining({
          fromSessionId: "session-1",
          toSessionId: "sess_target",
          interactionRequestId: "interaction-session-ask",
        }),
      );
      expect(onOutboxReady).not.toHaveBeenCalled();
      expect(onRequestOpened).not.toHaveBeenCalled();
      expect(waits.listPendingOutbox()).toEqual([]);
      expect(waits.listPending()).toEqual([
        expect.objectContaining({
          interactionRequestId: "interaction-session-ask",
          respondent: { kind: "session", sessionId: "sess_target" },
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("fails closed for self-targeted session asks and missing delivery", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const withoutDeliverer = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });
    const withDeliverer = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
      deliverSessionAsk: async () => undefined,
    });

    try {
      await expect(
        withoutDeliverer.interact(
          askRequest("interaction-session-missing", "async", undefined, undefined, "sess_target"),
          { ...interactionContext(), sessionSource: "session" },
        ),
      ).resolves.toMatchObject({ status: "blocked" });
      expect(waits.listPending()).toHaveLength(0);

      await expect(
        withDeliverer.interact(
          askRequest("interaction-session-self", "async", undefined, undefined, "session-1"),
          { ...interactionContext(), sessionSource: "session" },
        ),
      ).resolves.toMatchObject({ status: "blocked" });
      expect(waits.listPending()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("cancels a pending session ask when delivery fails", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
      deliverSessionAsk: async () => {
        throw new Error("mailbox unavailable");
      },
    });

    try {
      await expect(
        broker.interact(
          askRequest("interaction-session-fail", "async", undefined, undefined, "sess_target"),
          { ...interactionContext(), sessionSource: "session" },
        ),
      ).resolves.toMatchObject({ status: "blocked" });
      expect(waits.listPending()).toHaveLength(0);
      const settled = db.prepare("SELECT status AS status FROM daemon_human_waits").all() as Array<{
        status: string;
      }>;
      expect(settled).toEqual([{ status: "cancelled" }]);
    } finally {
      db.close();
    }
  });
});
