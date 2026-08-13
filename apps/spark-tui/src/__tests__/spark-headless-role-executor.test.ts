import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "vitest";

import {
  ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE,
  ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON,
  type ToolConfig,
} from "@zendev-lab/spark-core";
import {
  loadSparkHeadlessSessionModule,
  type SparkHeadlessTokenUsageObservation,
} from "@zendev-lab/spark-host/headless-loader";
import { SparkHostRuntime } from "../host/runtime.ts";
import {
  preloadSparkHeadlessSessionRuntime,
  runSparkHeadlessRoleInstruction,
  runSparkHeadlessSession,
  type SparkHeadlessRoleInstructionInput,
} from "../headless-role-executor.ts";
import type { SparkRunOutcome } from "../host/index.ts";

test("daemon headless loader resolves the real worker module and provider dependencies", async () => {
  const headless = await loadSparkHeadlessSessionModule();

  assert.equal(typeof headless.createSparkHeadlessRoleExecutor, "function");
  assert.equal(typeof headless.createSparkHeadlessSessionExecutor, "function");
  assert.equal(typeof headless.createSparkHeadlessSessionCompactor, "function");
  assert.equal(typeof headless.preloadSparkHeadlessSessionRuntime, "function");
  await preloadSparkHeadlessSessionRuntime();
});

test("runSparkHeadlessSession retains the control root for nested daemon-native roles", async () => {
  let captured:
    | {
        sparkHome?: string;
        controlSparkHome?: string;
        configPath?: string;
        authPath?: string;
      }
    | undefined;
  await runSparkHeadlessSession(
    { cwd: process.cwd(), sessionId: "session-control-root", prompt: "run" },
    {
      sparkHome: "/private/pi-agent",
      controlSparkHome: "/control/spark",
      createServices: async (options) => {
        captured = options;
        return eventfulHeadlessServices(0) as never;
      },
    },
  );

  assert.deepEqual(captured, {
    cwd: process.cwd(),
    workspaceId: undefined,
    sparkStateRoot: undefined,
    sparkHome: "/private/pi-agent",
    controlSparkHome: "/control/spark",
    configPath: "/control/spark/config.json",
    authPath: "/control/spark/auth.json",
    sessionSurface: undefined,
    sessionSource: undefined,
    sessionLease: undefined,
    channelBinding: undefined,
    invocationId: undefined,
    taskExecutionScope: undefined,
    tokenUsage: undefined,
    stateBindingSessionId: undefined,
    loop: undefined,
    sessionQuestionChain: undefined,
    allowedTools: undefined,
    roleRunner: undefined,
    allowedToolEffects: undefined,
    sessionMode: undefined,
    hasUI: false,
    streamTimeoutMs: 0,
    approvalMethod: "auto",
  });
});

test("runSparkHeadlessSession streams events without retaining a duplicate event array", async () => {
  let streamedCount = 0;
  const streamed = await runSparkHeadlessSession(
    {
      cwd: process.cwd(),
      sessionId: "session-streamed-events",
      prompt: "stream",
      onEvent: () => {
        streamedCount += 1;
      },
    },
    { createServices: async () => eventfulHeadlessServices(10_000) as never },
  );

  assert.equal(streamedCount, 10_000);
  assert.equal(streamed.eventsStreamed, true);
  assert.deepEqual(streamed.jsonEvents, []);

  const buffered = await runSparkHeadlessSession(
    { cwd: process.cwd(), sessionId: "session-buffered-events", prompt: "buffer" },
    { createServices: async () => eventfulHeadlessServices(3) as never },
  );
  assert.equal(buffered.eventsStreamed, undefined);
  assert.equal(buffered.jsonEvents.length, 3);
});

test("runSparkHeadlessSession waits for accepted async event delivery before success", async () => {
  let releaseDelivery!: () => void;
  const delivery = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  let resolved = false;
  const running = runSparkHeadlessSession(
    {
      cwd: process.cwd(),
      sessionId: "session-async-event-delivery",
      prompt: "finish",
      onEvent: () => delivery,
    },
    { createServices: async () => eventfulHeadlessServices(1) as never },
  ).then((result) => {
    resolved = true;
    return result;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  releaseDelivery();
  await running;
  assert.equal(resolved, true);
});

test("runSparkHeadlessSession drains event delivery failures and preserves the primary error", async () => {
  const deliveryError = new Error("terminal projection failed");
  let shutdownCalls = 0;
  const syncFailure = eventfulHeadlessServices(1);
  syncFailure.runtime.shutdown = async () => {
    shutdownCalls += 1;
  };
  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-event-delivery-failed",
        prompt: "finish",
        onEvent: () => {
          throw deliveryError;
        },
      },
      { createServices: async () => syncFailure as never },
    ),
    (error) => error === deliveryError,
  );

  const primaryError = new Error("session execution failed");
  let releaseDelivery!: () => void;
  const delivery = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  const primaryFailure = eventfulHeadlessServices(1);
  const originalOnEvent = primaryFailure.agentLoop.onEvent;
  let listener: ((event: never) => void) | undefined;
  primaryFailure.agentLoop.onEvent = (next: (event: never) => void) => {
    listener = next;
    return originalOnEvent(next);
  };
  primaryFailure.agentLoop.submitWithOutcome = async () => {
    listener?.({ type: "runtime_message", item: { terminal: true } } as never);
    throw primaryError;
  };
  primaryFailure.runtime.shutdown = async () => {
    shutdownCalls += 1;
  };
  let rejected = false;
  const running = runSparkHeadlessSession(
    {
      cwd: process.cwd(),
      sessionId: "session-primary-failure-drain",
      prompt: "fail",
      onEvent: () => delivery,
    },
    { createServices: async () => primaryFailure as never },
  ).catch((error: unknown) => {
    rejected = true;
    throw error;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rejected, false);
  releaseDelivery();
  await assert.rejects(running, (error) => error === primaryError);
  assert.equal(shutdownCalls, 2);
});

test("headless sessions release extension resources after success and failure", async () => {
  const shutdownReasons: string[] = [];
  const completedBase = headlessServices(async () => successfulOutcome("done"));
  const completedRuntime = new SparkHostRuntime({ cwd: process.cwd() });
  completedRuntime.on("session_shutdown", (event: unknown) => {
    shutdownReasons.push((event as { reason: string }).reason);
  });
  const completed = {
    ...completedBase,
    runtime: completedRuntime,
  };
  await runSparkHeadlessSession(
    { cwd: process.cwd(), sessionId: "session-shutdown-success", prompt: "finish" },
    { createServices: async () => completed as never },
  );

  const failedBase = failedModelCallHeadlessServices();
  const failedRuntime = new SparkHostRuntime({ cwd: process.cwd() });
  failedRuntime.on("session_shutdown", (event: unknown) => {
    shutdownReasons.push((event as { reason: string }).reason);
  });
  const failed = {
    ...failedBase,
    runtime: failedRuntime,
  };
  await assert.rejects(
    runSparkHeadlessSession(
      { cwd: process.cwd(), sessionId: "session-shutdown-failure", prompt: "fail" },
      { createServices: async () => failed as never },
    ),
    /provider stream failed/u,
  );

  assert.deepEqual(shutdownReasons, ["headless session completed", "headless session completed"]);
});

test("runSparkHeadlessSession records actual responses but not tool errors", async () => {
  const observations: SparkHeadlessTokenUsageObservation[] = [];
  const services = turnCompleteHeadlessServices();
  await runSparkHeadlessSession(
    {
      cwd: process.cwd(),
      sessionId: "session-token-usage",
      prompt: "use a tool then finish",
      tokenUsage: {
        scope: { kind: "repro", reproId: "repro-token-usage" },
        executionId: "inv-token-usage",
        kind: "root_session",
        persistence: "persistent",
        record: (observation) => observations.push(observation),
      },
    },
    { createServices: async () => services as never },
  );

  assert.equal(observations.length, 2);
  assert.deepEqual(
    observations.map((observation) => ({
      scope: observation.scope,
      executionId: observation.executionId,
      kind: observation.kind,
      persistence: observation.persistence,
      type: (observation.event as { type?: unknown }).type,
      responseId: (observation.event as { message?: { responseId?: unknown } }).message?.responseId,
    })),
    [
      {
        scope: { kind: "repro", reproId: "repro-token-usage" },
        executionId: "inv-token-usage",
        kind: "root_session",
        persistence: "persistent",
        type: "turn_complete",
        responseId: "response-tool",
      },
      {
        scope: { kind: "repro", reproId: "repro-token-usage" },
        executionId: "inv-token-usage",
        kind: "root_session",
        persistence: "persistent",
        type: "turn_complete",
        responseId: "response-final",
      },
    ],
  );
});

test("runSparkHeadlessSession records one missing receipt when a manifested model call fails", async () => {
  const observations: SparkHeadlessTokenUsageObservation[] = [];
  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-token-usage-failed-model-call",
        prompt: "fail in the provider stream",
        tokenUsage: {
          scope: { kind: "repro", reproId: "repro-token-usage" },
          executionId: "inv-token-usage-failed",
          kind: "root_session",
          persistence: "persistent",
          record: (observation) => observations.push(observation),
        },
      },
      { createServices: async () => failedModelCallHeadlessServices() as never },
    ),
    /provider stream failed/u,
  );

  assert.equal(observations.length, 1);
  const observation = observations[0]!;
  const event = observation.event as {
    type: string;
    reason: string;
    message: Record<string, unknown>;
  };
  assert.deepEqual(
    {
      scope: observation.scope,
      executionId: observation.executionId,
      kind: observation.kind,
      persistence: observation.persistence,
      type: event.type,
      reason: event.reason,
      provider: event.message.provider,
      model: event.message.model,
      responseId: event.message.responseId,
      usage: event.message.usage,
    },
    {
      scope: { kind: "repro", reproId: "repro-token-usage" },
      executionId: "inv-token-usage-failed",
      kind: "root_session",
      persistence: "persistent",
      type: "turn_complete",
      reason: "error",
      provider: "test-provider",
      model: "test-model",
      responseId: "spark-model-call:session-fp:1:test-provider:test-model",
      usage: undefined,
    },
  );
  assert.equal(typeof event.message.timestamp, "number");
});

test("runSparkHeadlessSession times out a never-resolving agent turn", async () => {
  const unsubscribed: string[] = [];
  let abortedReason: string | undefined;
  let capturedServiceOptions:
    | {
        sessionSurface?: "local" | "channel";
        sessionLease?: {
          workspaceId: string;
          clientId: string;
          sessionId: string;
          leaseFence: string;
        };
        channelBinding?: { adapter: "feishu" | "infoflow" | "qqbot"; externalKey: string };
        allowedTools?: readonly string[];
        sparkStateRoot?: string;
        approvalMethod?: "skip" | "human" | "auto";
        streamTimeoutMs?: number;
        toolTimeoutMs?: number;
        interactionTimeoutMs?: number;
      }
    | undefined;
  const record = {
    header: { id: "session-timeout" },
    path: "/tmp/session-timeout.jsonl",
    entries: [],
  };
  const services = {
    agentLoop: {
      onEvent: () => () => unsubscribed.push("agentLoop"),
      setViewSessionId: () => undefined,
      replacePromptItems: () => undefined,
      getPromptItems: () => [],
      submitWithOutcome: async () => await new Promise<never>(() => undefined),
      abort: (reason?: string) => {
        abortedReason = reason;
      },
    },
    runtime: {
      onDaemonEvent: () => () => unsubscribed.push("runtime"),
      setSessionId: () => undefined,
      makeContext: () => ({}),
      shutdown: async () => undefined,
    },
    sessionStore: {
      createSession: () => record,
      findById: async () => undefined,
      loadByRef: async () => record,
      forkSession: () => record,
      appendMessage: () => undefined,
      save: async () => undefined,
    },
    diagnostics: [],
  };

  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-timeout",
        prompt: "hang",
        timeoutMs: 10,
        sessionSurface: "channel",
        sessionLease: {
          workspaceId: "workspace-1",
          clientId: "client-1",
          sessionId: "session:session-timeout",
          leaseFence: "fence-1",
        },
        channelBinding: { adapter: "qqbot", externalKey: "qqbot:c2c:user-1" },
        allowedTools: ["session"],
      },
      {
        controlSparkHome: "/tmp/control-spark-home",
        createServices: async (options) => {
          capturedServiceOptions = options;
          return services as never;
        },
      },
    ),
    /Spark headless session timed out after 10ms/u,
  );

  assert.equal(abortedReason, "Spark headless session timed out after 10ms");
  assert.equal(capturedServiceOptions?.sessionSurface, "channel");
  assert.deepEqual(capturedServiceOptions?.sessionLease, {
    workspaceId: "workspace-1",
    clientId: "client-1",
    sessionId: "session:session-timeout",
    leaseFence: "fence-1",
  });
  assert.deepEqual(capturedServiceOptions?.channelBinding, {
    adapter: "qqbot",
    externalKey: "qqbot:c2c:user-1",
  });
  assert.deepEqual(capturedServiceOptions?.allowedTools, ["session"]);
  assert.equal(capturedServiceOptions?.sparkStateRoot, undefined);
  assert.equal(capturedServiceOptions?.approvalMethod, "auto");
  assert.equal(capturedServiceOptions?.streamTimeoutMs, 0);
  assert.equal(capturedServiceOptions?.toolTimeoutMs, undefined);
  assert.equal(capturedServiceOptions?.interactionTimeoutMs, undefined);
  assert.deepEqual(unsubscribed.sort(), ["agentLoop", "runtime"]);
});

for (const terminal of [
  {
    stopReason: "error" as const,
    errorMessage: "provider unavailable",
    expected: /provider unavailable/u,
  },
  {
    stopReason: "aborted" as const,
    errorMessage: "provider stream ended",
    expected: /provider stream ended/u,
  },
]) {
  test(`runSparkHeadlessSession rejects assistant stopReason=${terminal.stopReason}`, async () => {
    const assistant = terminalAssistant(terminal.stopReason, terminal.errorMessage);

    await assert.rejects(
      runSparkHeadlessSession(
        { cwd: process.cwd(), sessionId: `session-${terminal.stopReason}`, prompt: "hello" },
        {
          createServices: async () =>
            headlessServices(async () => terminalOutcome(assistant)) as never,
        },
      ),
      terminal.expected,
    );
  });
}

test("runSparkHeadlessSession classifies provider stream read errors as transient", async () => {
  const assistant = terminalAssistant("error", "stream_read_error");

  await assert.rejects(
    runSparkHeadlessSession(
      { cwd: process.cwd(), sessionId: "session-stream-read-error", prompt: "hello" },
      {
        createServices: async () =>
          headlessServices(async () => terminalOutcome(assistant)) as never,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "EXECUTION_TRANSIENT");
      assert.match(error.message, /stream_read_error/u);
      return true;
    },
  );
}, 15_000);

test("runSparkHeadlessSession preserves an exhausted empty-response code as transient", async () => {
  await assert.rejects(
    runSparkHeadlessSession(
      { cwd: process.cwd(), sessionId: "session-empty-response", prompt: "hello" },
      {
        createServices: async () =>
          headlessServices(async () => ({
            status: "failed",
            assistant: successfulOutcome("").assistant,
            roundtrips: 4,
            errorMessage: "model completed without a displayable response",
            errorCode: "MODEL_EMPTY_RESPONSE",
          })) as never,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "EXECUTION_TRANSIENT");
      assert.match(error.message, /without a displayable response/u);
      return true;
    },
  );
}, 15_000);

test("runSparkHeadlessSession preserves an active caller cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("operator cancelled");
  let createServicesCalls = 0;
  let submitCalls = 0;
  controller.abort(reason);

  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-cancelled",
        prompt: "hello",
        signal: controller.signal,
      },
      {
        createServices: async () => {
          createServicesCalls += 1;
          return headlessServices(async () => {
            submitCalls += 1;
            return terminalOutcome(terminalAssistant("aborted", "provider aborted"));
          }) as never;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.equal(createServicesCalls, 0);
  assert.equal(submitCalls, 0);
});

test("runSparkHeadlessSession never submits when cancellation wins during bootstrap", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during service bootstrap");
  let submitCalls = 0;
  let shutdownCalls = 0;

  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-bootstrap-cancelled",
        prompt: "must not execute",
        signal: controller.signal,
      },
      {
        createServices: async () => {
          controller.abort(reason);
          const services = headlessServices(async () => {
            submitCalls += 1;
            return terminalOutcome(terminalAssistant("aborted", "too late"));
          });
          services.runtime.shutdown = async () => {
            shutdownCalls += 1;
          };
          return services as never;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.equal(submitCalls, 0);
  assert.equal(shutdownCalls, 1);
});

test("runSparkHeadlessSession shuts down after provider resolution failure", async () => {
  const providerFailure = new Error("model provider missing");
  let shutdownCalls = 0;
  const services = headlessServices(async () => successfulOutcome("must not run"));
  services.runtime.shutdown = async () => {
    shutdownCalls += 1;
  };
  Object.assign(services, {
    providerRegistry: {
      buildModel: () => {
        throw providerFailure;
      },
      setActive: () => undefined,
    },
    config: {},
  });

  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-provider-resolution-failed",
        prompt: "must not execute",
        model: "missing/provider",
      },
      { createServices: async () => services as never },
    ),
    (error) => error === providerFailure,
  );
  assert.equal(shutdownCalls, 1);
});

test("runSparkHeadlessSession preserves its primary error when shutdown also fails", async () => {
  const services = failedModelCallHeadlessServices();
  services.runtime.shutdown = async () => {
    throw new Error("shutdown listener failed");
  };

  await assert.rejects(
    runSparkHeadlessSession(
      { cwd: process.cwd(), sessionId: "session-primary-error", prompt: "fail" },
      { createServices: async () => services as never },
    ),
    /provider stream failed/u,
  );
});

test("runSparkHeadlessRoleInstruction shuts down after setup abort", async () => {
  const controller = new AbortController();
  const reason = new Error("role cancelled during bootstrap");
  const services = headlessRoleServices(async () => successfulOutcome("must not run"));
  let shutdownCalls = 0;
  services.runtime.shutdown = async () => {
    shutdownCalls += 1;
  };
  const input = roleInstructionInput("setup-abort-shutdown");
  input.signal = controller.signal;

  await assert.rejects(
    runSparkHeadlessRoleInstruction(input, {
      createServices: async () => {
        controller.abort(reason);
        return services as never;
      },
    }),
    (error) => error === reason,
  );
  assert.equal(shutdownCalls, 1);
});

test("runSparkHeadlessRoleInstruction shuts down after provider resolution failure", async () => {
  const services = headlessRoleServices(async () => successfulOutcome("must not run"));
  let shutdownCalls = 0;
  services.runtime.shutdown = async () => {
    shutdownCalls += 1;
  };
  services.providerRegistry = {
    buildModel: () => {
      throw new Error("role provider missing");
    },
    setActive: () => undefined,
  };
  const input = roleInstructionInput("provider-resolution-shutdown");
  input.model = "missing/provider";

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "failed");
  assert.equal(result.outcome.code, "provider_resolution_failed");
  assert.equal(shutdownCalls, 1);
});

for (const roleTerminal of ["success", "failure"] as const) {
  test(`runSparkHeadlessRoleInstruction shuts down once after ${roleTerminal}`, async () => {
    const services = headlessRoleServices(async (tools) => {
      if (roleTerminal === "failure") throw new Error("role execution failed");
      await executeRoleOutcomeTool(tools, {
        kind: "completed",
        code: "worker_completed",
        reason: "Role completed",
      });
      return successfulOutcome("done");
    });
    let shutdownCalls = 0;
    services.runtime.shutdown = async () => {
      shutdownCalls += 1;
    };

    const result = await runSparkHeadlessRoleInstruction(roleInstructionInput(roleTerminal), {
      createServices: async () => services as never,
    });

    assert.equal(result.record.status, roleTerminal === "success" ? "succeeded" : "failed");
    assert.equal(shutdownCalls, 1);
  });
}

test("runSparkHeadlessRoleInstruction records caught native module incompatibility without raw diagnostics", async () => {
  const compatibility = new TypeError(
    "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  );
  const input = roleInstructionInput("native-compatibility");
  input.nativeCompatibilityRecovery = "reviewer";

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => {
      throw compatibility;
    },
  });

  assert.equal(result.record.status, "failed");
  assert.deepEqual(result.outcome, {
    kind: "failed",
    code: ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE,
    reason: ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON,
  });
  assert.deepEqual(result.record.outcome, result.outcome);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
  assert.deepEqual(result.jsonEvents, []);
  assert.doesNotMatch(JSON.stringify(result), /defaultSparkConfigPath/u);
});

test("runSparkHeadlessRoleInstruction does not relabel ordinary bootstrap failures", async () => {
  const ordinary = new Error("ordinary bootstrap failed");
  const input = roleInstructionInput("ordinary-bootstrap");

  await assert.rejects(
    runSparkHeadlessRoleInstruction(input, {
      createServices: async () => {
        throw ordinary;
      },
    }),
    (error) => error === ordinary,
  );
});

test("runSparkHeadlessRoleInstruction classifies the exact compatibility TypeError across realms", async () => {
  const compatibility = runInNewContext(
    `new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')")`,
  ) as TypeError;
  assert.equal(compatibility instanceof TypeError, false);
  const input = roleInstructionInput("cross-realm-native-compatibility");
  input.nativeCompatibilityRecovery = "reviewer";

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => {
      throw compatibility;
    },
  });

  assert.equal(result.record.status, "failed");
  assert.equal(result.outcome.code, ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE);
  assert.equal(result.outcome.reason, ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(result.jsonEvents, []);
});

test("runSparkHeadlessRoleInstruction rejects a forged cross-realm compatibility lookalike", async () => {
  const lookalike = {
    name: "TypeError",
    message: "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  };
  const input = roleInstructionInput("forged-native-compatibility");
  input.nativeCompatibilityRecovery = "reviewer";

  await assert.rejects(
    runSparkHeadlessRoleInstruction(input, {
      createServices: async () => {
        throw lookalike;
      },
    }),
    (error) => error === lookalike,
  );
});

test("runSparkHeadlessRoleInstruction preserves caller cancellation during incompatible bootstrap", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during incompatible bootstrap");
  const input = roleInstructionInput("aborted-incompatible-bootstrap");
  input.nativeCompatibilityRecovery = "reviewer";
  input.signal = controller.signal;

  await assert.rejects(
    runSparkHeadlessRoleInstruction(input, {
      createServices: async () => {
        controller.abort(reason);
        throw new TypeError(
          "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
        );
      },
    }),
    (error) => error === reason,
  );
});

test("runSparkHeadlessRoleInstruction records in-flight native module incompatibility without raw diagnostics", async () => {
  const compatibility = new TypeError(
    "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  );
  const services = headlessRoleServices(async () => {
    throw compatibility;
  });
  const input = roleInstructionInput("in-flight-native-compatibility");
  input.nativeCompatibilityRecovery = "reviewer";

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "failed");
  assert.equal(result.outcome.code, ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE);
  assert.equal(result.outcome.reason, ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_REASON);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.jsonEvents, []);
  assert.doesNotMatch(JSON.stringify(result), /defaultSparkConfigPath/u);
});

test("runSparkHeadlessRoleInstruction withholds reviewer events before compatibility recovery", async () => {
  const compatibility = new TypeError(
    "Cannot read properties of undefined (reading 'defaultSparkConfigPath')",
  );
  let listener: ((event: never) => void) | undefined;
  let streamedEvents = 0;
  const services = headlessRoleServices(async () => {
    listener?.({ type: "secret_runtime_error", secret: "must-not-stream" } as never);
    throw compatibility;
  });
  Object.assign(services.agentLoop, {
    onEvent: (next: (event: never) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  });
  const input = roleInstructionInput("buffered-native-compatibility");
  input.nativeCompatibilityRecovery = "reviewer";
  input.onEvent = () => {
    streamedEvents += 1;
  };

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.outcome.code, ROLE_NATIVE_EXECUTOR_COMPATIBILITY_FAILURE_CODE);
  assert.equal(streamedEvents, 0);
  assert.deepEqual(result.jsonEvents, []);
  assert.doesNotMatch(JSON.stringify(result), /must-not-stream/u);
});

test("runSparkHeadlessRoleInstruction gives cancellation precedence over compatibility classification", async () => {
  const controller = new AbortController();
  const services = headlessRoleServices(async () => {
    controller.abort("cancelled before compatibility failure");
    throw new TypeError("Cannot read properties of undefined (reading 'defaultSparkConfigPath')");
  });
  const input = roleInstructionInput("aborted-native-compatibility");
  input.nativeCompatibilityRecovery = "reviewer";
  input.signal = controller.signal;

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "cancelled");
  assert.equal(result.outcome.kind, "cancelled");
  assert.equal(result.outcome.code, "role_run_cancelled");
});

test("runSparkHeadlessRoleInstruction records completed and blocked structured outcomes", async () => {
  for (const expected of [
    {
      kind: "completed" as const,
      code: "worker_completed",
      reason: "Implementation and validation completed",
      expectedStatus: "succeeded" as const,
    },
    {
      kind: "blocked" as const,
      code: "missing_daemon_control",
      reason: "Independent daemon restart control is unavailable",
      expectedStatus: "failed" as const,
    },
  ]) {
    let sessionMode: "plan" | "execute" | "fleet" | undefined;
    const services = headlessRoleServices(async (tools) => {
      await executeRoleOutcomeTool(tools, expected);
      return successfulOutcome("structured outcome recorded");
    });

    const result = await runSparkHeadlessRoleInstruction(roleInstructionInput(expected.kind), {
      createServices: async (options) => {
        sessionMode = options?.sessionMode;
        return services as never;
      },
    });

    assert.equal(sessionMode, "execute");
    assert.deepEqual(result.outcome, {
      kind: expected.kind,
      code: expected.code,
      reason: expected.reason,
    });
    assert.equal(result.record.status, expected.expectedStatus);
    assert.deepEqual(services.runtime.getActiveTools(), ["read", "role_report_outcome"]);
  }
});

test("runSparkHeadlessSession keeps supervised Role outcome tools in execute mode", async () => {
  let sessionMode: "plan" | "execute" | "fleet" | undefined;
  let allowedTools: readonly string[] | undefined;
  let allowedToolEffects: readonly string[] | undefined;
  const services = headlessRoleServices(async (tools) => {
    await executeRoleOutcomeTool(tools, {
      kind: "completed",
      code: "review_completed",
      reason: "Review completed",
    });
    return successfulOutcome("reviewed");
  });

  await runSparkHeadlessSession(
    {
      cwd: process.cwd(),
      sessionId: "session:supervised-role",
      prompt: "Review the change",
      roleRunRef: "run:supervised-role",
      allowedTools: ["read"],
      allowedToolEffects: ["read", "network_read"],
    },
    {
      createServices: async (options) => {
        sessionMode = options?.sessionMode;
        allowedTools = options?.allowedTools;
        allowedToolEffects = options?.allowedToolEffects;
        return services as never;
      },
    },
  );

  assert.equal(sessionMode, "execute");
  assert.deepEqual(allowedTools, ["read", "role_report_outcome"]);
  assert.deepEqual(allowedToolEffects, ["read", "network_read", "control"]);
});

test("daemon headless role host exposes reviewer fallback roots to subject-review extensions", async () => {
  let captured:
    | {
        sparkHome?: string;
        roleNativeCompatibilityRecovery?: {
          sparkHome?: string;
          controlSparkHome?: string;
        };
      }
    | undefined;
  const services = headlessRoleServices(async (tools) => {
    await executeRoleOutcomeTool(tools, {
      kind: "completed",
      code: "worker_completed",
      reason: "done",
    });
    return successfulOutcome("done");
  });

  await runSparkHeadlessRoleInstruction(roleInstructionInput("reviewer-fallback-roots"), {
    sparkHome: "/daemon/session-state",
    controlSparkHome: "/daemon/provider-config",
    createServices: async (options) => {
      captured = options;
      return services as never;
    },
  });

  assert.equal(captured?.sparkHome, "/daemon/session-state");
  assert.deepEqual(captured?.roleNativeCompatibilityRecovery, {
    sparkHome: "/daemon/session-state",
    controlSparkHome: "/daemon/provider-config",
  });
});

test("runSparkHeadlessRoleInstruction rejects duplicate structured outcome reports", async () => {
  const services = headlessRoleServices(async (tools) => {
    await executeRoleOutcomeTool(tools, {
      kind: "completed",
      code: "worker_completed",
      reason: "First terminal report",
    });
    await assert.rejects(
      executeRoleOutcomeTool(tools, {
        kind: "blocked",
        code: "late_blocker",
        reason: "A second report must not replace the first",
      }),
      /may only be called once/u,
    );
    return successfulOutcome("duplicate rejected");
  });

  const result = await runSparkHeadlessRoleInstruction(roleInstructionInput("duplicate"), {
    createServices: async () => services as never,
  });

  assert.deepEqual(result.outcome, {
    kind: "completed",
    code: "worker_completed",
    reason: "First terminal report",
  });
  assert.equal(result.record.status, "succeeded");
});

test("runSparkHeadlessRoleInstruction fails closed when a scheduler worker omits its outcome", async () => {
  const services = headlessRoleServices(async () => successfulOutcome("natural model completion"));

  const result = await runSparkHeadlessRoleInstruction(roleInstructionInput("missing"), {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "failed");
  assert.equal(result.outcome.kind, "failed");
  assert.equal(result.outcome.code, "missing_structured_outcome");
  assert.match(result.outcome.reason, /without calling role_report_outcome/u);
});

test("runSparkHeadlessRoleInstruction records provider resolution failures structurally", async () => {
  const services = headlessRoleServices(async () => successfulOutcome("must not run"));
  services.providerRegistry = {
    buildModel() {
      throw new Error("configured provider is unavailable");
    },
    setActive: () => undefined,
  };
  const input = roleInstructionInput("provider");
  input.model = "missing/model";

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "failed");
  assert.equal(result.outcome.kind, "failed");
  assert.equal(result.outcome.code, "provider_resolution_failed");
  assert.match(result.outcome.reason, /configured provider is unavailable/u);
});

test("runSparkHeadlessRoleInstruction records an in-flight abort as cancelled", async () => {
  const controller = new AbortController();
  const services = headlessRoleServices(async () => {
    controller.abort("parent stopped the role");
    return terminalOutcome(terminalAssistant("aborted", "parent stopped the role"));
  });
  const input = roleInstructionInput("cancelled");
  input.signal = controller.signal;

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "cancelled");
  assert.equal(result.outcome.kind, "cancelled");
  assert.equal(result.outcome.code, "role_run_cancelled");
  assert.match(result.outcome.reason, /parent stopped the role/u);
});

function roleInstructionInput(suffix: string): SparkHeadlessRoleInstructionInput {
  return {
    role: {
      ref: "role:builtin-executor",
      id: "worker",
      revision: "test-revision",
      systemPrompt: "Implement the assigned task and report a structured terminal outcome.",
      allowedTools: ["read"],
    },
    instruction: {
      roleRef: "role:builtin-executor",
      instruction: "Complete the scheduler-owned task.",
    },
    record: {
      ref: `run:headless-${suffix}` as `run:${string}`,
      roleRef: "role:builtin-executor",
      roleRevision: "test-revision",
      instruction: "Complete the scheduler-owned task.",
      status: "queued",
    },
    cwd: process.cwd(),
    timeoutMs: 1_000,
    mode: "execute",
    requireStructuredOutcome: true,
  };
}

function headlessRoleServices(
  submitWithOutcome: (tools: Map<string, ToolConfig>) => Promise<SparkRunOutcome>,
) {
  const tools = new Map<string, ToolConfig>();
  let activeTools = ["read"];
  return {
    agentLoop: {
      onEvent: () => () => undefined,
      setViewSessionId: () => undefined,
      replacePromptItems: () => undefined,
      getPromptItems: () => [],
      submitWithOutcome: async () => await submitWithOutcome(tools),
      abort: () => undefined,
    },
    runtime: {
      onDaemonEvent: () => () => undefined,
      setSessionId: () => undefined,
      makeContext: () => ({}),
      shutdown: async () => undefined,
      registerTool: (tool: ToolConfig) => tools.set(tool.name, tool),
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools = [...names];
      },
    },
    providerRegistry: undefined as
      | {
          buildModel(providerName: string, modelId: string): unknown;
          setActive(selection: { providerName: string; modelId: string }): void;
        }
      | undefined,
    sessionStore: {
      createSession: () => ({ header: { id: "unused" }, path: "", entries: [] }),
      findById: async () => undefined,
      loadByRef: async () => ({ header: { id: "unused" }, path: "", entries: [] }),
      forkSession: () => ({ header: { id: "unused" }, path: "", entries: [] }),
      appendMessage: () => undefined,
      save: async () => undefined,
    },
    diagnostics: [],
  };
}

async function executeRoleOutcomeTool(
  tools: Map<string, ToolConfig>,
  params: { kind: "completed" | "blocked" | "failed" | "cancelled"; code: string; reason: string },
): Promise<void> {
  const tool = tools.get("role_report_outcome");
  assert.ok(tool);
  await tool.execute(
    `outcome-${params.code}`,
    params,
    new AbortController().signal,
    () => undefined,
    {} as never,
  );
}

function successfulOutcome(text: string): SparkRunOutcome {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions" as const,
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  return {
    status: "completed",
    assistant: message as SparkRunOutcome["assistant"],
    roundtrips: 0,
  };
}

function terminalAssistant(stopReason: "error" | "aborted", errorMessage: string) {
  return {
    role: "assistant" as const,
    content: [] as const,
    api: "openai-completions" as const,
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function terminalOutcome(assistant: ReturnType<typeof terminalAssistant>): SparkRunOutcome {
  return assistant.stopReason === "aborted"
    ? {
        status: "aborted",
        assistant: assistant as unknown as SparkRunOutcome["assistant"],
        roundtrips: 0,
        reason: assistant.errorMessage,
      }
    : {
        status: "failed",
        assistant: assistant as unknown as SparkRunOutcome["assistant"],
        roundtrips: 0,
        errorMessage: assistant.errorMessage,
      };
}

function eventfulHeadlessServices(eventCount: number) {
  let listener: ((event: never) => void) | undefined;
  const base = headlessServices(async () => {
    for (let index = 0; index < eventCount; index += 1) {
      listener?.({ type: "runtime_message", item: { index } } as never);
    }
    return successfulOutcome("done");
  });
  return {
    ...base,
    agentLoop: {
      ...base.agentLoop,
      onEvent: (next: (event: never) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  };
}

function turnCompleteHeadlessServices() {
  let listener: ((event: never) => void) | undefined;
  const final = successfulOutcome("done");
  const base = headlessServices(async () => {
    const assistant = final.assistant as NonNullable<SparkRunOutcome["assistant"]>;
    listener?.({
      type: "prompt_manifest",
      manifest: {
        sessionFingerprint: "tool-loop-session",
        model: { provider: "test-provider", id: "test-model" },
        roundtrip: { index: 1 },
      },
    } as never);
    listener?.({
      type: "tool_result",
      message: { role: "toolResult", isError: true, content: "tool failed" },
    } as never);
    listener?.({
      type: "turn_complete",
      assistant: { ...assistant, responseId: "response-tool", stopReason: "toolUse" },
      reason: "toolUse",
    } as never);
    listener?.({
      type: "turn_complete",
      assistant: { ...assistant, responseId: "response-final" },
      reason: "stop",
    } as never);
    return final;
  });
  return {
    ...base,
    agentLoop: {
      ...base.agentLoop,
      onEvent: (next: (event: never) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  };
}

function failedModelCallHeadlessServices() {
  let listener: ((event: never) => void) | undefined;
  const assistant = terminalAssistant("error", "provider stream failed");
  const base = headlessServices(async () => {
    listener?.({
      type: "prompt_manifest",
      manifest: {
        sessionFingerprint: "session-fp",
        model: { provider: "test-provider", id: "test-model" },
        roundtrip: { index: 1 },
      },
    } as never);
    listener?.({ type: "error", message: "provider stream failed" } as never);
    listener?.({
      type: "turn_complete",
      assistant: {
        ...assistant,
        responseId: "late-provider-response",
        usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      reason: "error",
    } as never);
    return terminalOutcome(assistant);
  });
  return {
    ...base,
    agentLoop: {
      ...base.agentLoop,
      onEvent: (next: (event: never) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  };
}

function headlessServices(submitWithOutcome: () => Promise<SparkRunOutcome>) {
  const record = {
    header: { id: "session-terminal" },
    path: "/tmp/session-terminal.jsonl",
    entries: [],
  };
  return {
    agentLoop: {
      onEvent: () => () => undefined,
      setViewSessionId: () => undefined,
      replacePromptItems: () => undefined,
      getPromptItems: () => [],
      submitWithOutcome,
      abort: () => undefined,
    },
    runtime: {
      onDaemonEvent: () => () => undefined,
      setSessionId: () => undefined,
      makeContext: () => ({}),
      shutdown: async () => undefined,
    },
    sessionStore: {
      createSession: () => record,
      findById: async () => undefined,
      loadByRef: async () => record,
      forkSession: () => record,
      appendMessage: () => undefined,
      save: async () => undefined,
    },
    diagnostics: [],
  };
}
