import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkHeadlessSessionRunInput } from "./product/host/headless-loader.ts";
import { resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import type { SparkDaemonLoopTickTask } from "./core/types.ts";
import {
  commitLoopInvocationAdmission,
  quiesceLoopsForClosingSession,
} from "./loop-session-lifecycle.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { SessionSupervisor } from "./session-supervisor.ts";
import { createSparkDaemonTaskExecutor } from "./spark/session-run.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { SparkLoopStore } from "./store/loops.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("Loop and Session lifecycle integration", () => {
  it("turns a closing owner rejection into a terminal Loop without an Invocation", async () => {
    const harness = await createHarness("closing-owner");
    harness.loops.start({
      loopId: "closing-owner-loop",
      ownerSessionId: harness.session.sessionId,
      cwd: harness.root,
      prompt: "must not run",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    await harness.registry.markClosing({ sessionId: harness.session.sessionId });
    const admit = vi.fn((materialize: () => ReturnType<SparkInvocationStore["submit"]>) =>
      materialize(),
    );

    const advanced = await harness.loops.materializeDue(
      "2026-08-13T00:00:00.000Z",
      undefined,
      async (ownerSessionId, materialize) =>
        await commitLoopInvocationAdmission(harness.registry, ownerSessionId, () =>
          admit(materialize),
        ),
    );

    expect(advanced?.invocation).toBeUndefined();
    expect(advanced?.loop).toMatchObject({ status: "stopped" });
    expect(admit).not.toHaveBeenCalled();
    expect(harness.invocations.list()).toHaveLength(0);
  });

  it("stops an admitted owner Loop and identifies its uninstantiated execution route", async () => {
    const harness = await createHarness("admitted-owner");
    harness.loops.start({
      loopId: "admitted-owner-loop",
      ownerSessionId: harness.session.sessionId,
      sessionLifetime: "driver_tick",
      cwd: harness.root,
      prompt: "private Loop payload",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    const advanced = await harness.loops.materializeDue("2026-08-13T00:00:00.000Z");
    const invocation = advanced?.invocation;
    if (!invocation?.sessionId) throw new Error("test Loop invocation has no Session route");

    const quiesced = quiesceLoopsForClosingSession(
      harness.loops,
      harness.invocations,
      harness.session,
      "owning Session closed",
    );

    expect(quiesced.invocationSessionIds).toEqual([invocation.sessionId]);
    expect(quiesced.stoppedLoops).toEqual([
      expect.objectContaining({ loopId: "admitted-owner-loop", status: "stopped" }),
    ]);
    expect(harness.invocations.require(invocation.invocationId)).toMatchObject({
      status: "cancelled",
    });
  });

  it("finds superseded driver-tick routes from durable Invocation history", async () => {
    const harness = await createHarness("superseded-owner");
    harness.loops.start({
      loopId: "superseded-owner-loop",
      ownerSessionId: harness.session.sessionId,
      sessionLifetime: "driver_tick",
      cwd: harness.root,
      prompt: "private historical payload",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    const invocation = (await harness.loops.materializeDue("2026-08-13T00:00:00.000Z"))?.invocation;
    if (!invocation?.sessionId) throw new Error("test Loop invocation has no Session route");
    harness.loops.restart("superseded-owner-loop", "new generation", "2026-08-13T00:00:01.000Z");
    expect(harness.loops.require("superseded-owner-loop").lastInvocationId).toBeUndefined();

    const quiesced = quiesceLoopsForClosingSession(
      harness.loops,
      harness.invocations,
      harness.session,
      "owner closed",
    );

    expect(quiesced.invocationSessionIds).toEqual([invocation.sessionId]);
    expect(harness.invocations.require(invocation.invocationId)).toMatchObject({
      status: "cancelled",
    });
  });

  it("does not stop the next Loop generation when an old driver-tick child closes", async () => {
    const harness = await createHarness("driver-owner");
    harness.loops.start({
      loopId: "driver-generation-loop",
      ownerSessionId: harness.session.sessionId,
      sessionLifetime: "driver_tick",
      cwd: harness.root,
      prompt: "continue",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    const advanced = await harness.loops.materializeDue("2026-08-13T00:00:00.000Z");
    const invocation = advanced?.invocation;
    const task = invocation?.task as SparkDaemonLoopTickTask | undefined;
    if (!invocation?.sessionId || task?.type !== "loop.tick") {
      throw new Error("test Loop tick was not materialized");
    }
    const child = await harness.registry.createSupervised({
      sessionId: invocation.sessionId,
      scope: harness.session.scope,
      lineage: {
        kind: "child",
        parentSessionId: harness.session.sessionId,
        origin: {
          kind: "driver_tick",
          driverId: "driver-generation-loop",
          generation: 1,
          tickInvocationId: invocation.invocationId,
        },
      },
      visibility: "internal",
      retention: "discard_on_close",
      purpose: "driver_tick",
    });
    harness.invocations.claimNext("tick-worker", "2026-08-13T00:00:00.000Z");
    harness.loops.schedule({
      loopId: "driver-generation-loop",
      generation: 1,
      delayMs: 1_000,
      reason: "next generation",
    });
    harness.loops.completeTick(invocation, task, {
      status: "succeeded",
      now: "2026-08-13T00:00:01.000Z",
    });

    const quiesced = quiesceLoopsForClosingSession(
      harness.loops,
      harness.invocations,
      child,
      "old driver child closed",
    );

    expect(quiesced).toEqual({ invocationSessionIds: [], stoppedLoops: [] });
    expect(harness.loops.require("driver-generation-loop")).toMatchObject({
      status: "scheduled",
      generation: 2,
      reason: "next generation",
    });
  });

  it("stops a later Loop generation when its stable driver Session closes", async () => {
    const harness = await createHarness("stable-driver-owner");
    harness.loops.start({
      loopId: "stable-driver-loop",
      ownerSessionId: harness.session.sessionId,
      sessionLifetime: "driver",
      cwd: harness.root,
      prompt: "continue",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    const generationOne = harness.loops.require("stable-driver-loop");
    const driver = await harness.registry.createSupervised({
      sessionId: generationOne.driverSessionId,
      scope: harness.session.scope,
      lineage: {
        kind: "child",
        parentSessionId: harness.session.sessionId,
        origin: {
          kind: "driver",
          driverId: generationOne.loopId,
          generation: generationOne.generation,
        },
      },
      visibility: "internal",
      retention: "discard_on_close",
      purpose: "driver",
    });
    harness.loops.restart("stable-driver-loop", "next generation", "2026-08-13T00:00:01.000Z");
    expect(harness.loops.require("stable-driver-loop")).toMatchObject({
      generation: 2,
      driverSessionId: driver.sessionId,
    });

    const quiesced = quiesceLoopsForClosingSession(
      harness.loops,
      harness.invocations,
      driver,
      "stable driver closed",
    );

    expect(quiesced.stoppedLoops).toEqual([
      expect.objectContaining({ loopId: "stable-driver-loop", status: "stopped" }),
    ]);
    expect(harness.loops.require("stable-driver-loop")).toMatchObject({
      status: "stopped",
      generation: 3,
    });
    await expect(harness.loops.materializeDue("2026-08-13T00:00:02.000Z")).resolves.toBeUndefined();
    expect(harness.invocations.list()).toHaveLength(0);
  });

  it("executes consecutive generations in one stable driver Session", async () => {
    const harness = await createHarness("stable-driver-execution-owner");
    const supervisor = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      originExists: async () => true,
    });
    const executeSession = vi.fn(async (input: SparkHeadlessSessionRunInput) => ({
      sessionId: input.sessionId,
      assistantText: "tick complete",
    }));
    const executor = createSparkDaemonTaskExecutor({
      paths: resolveSparkPaths({ app: "daemon", env: { HOME: harness.root } }),
      sessionSupervisor: supervisor,
      loopControl: { schedule: vi.fn(), stop: vi.fn() },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });
    harness.loops.start({
      loopId: "stable-driver-execution-loop",
      ownerSessionId: harness.session.sessionId,
      sessionLifetime: "driver",
      cwd: harness.root,
      prompt: "continue",
      dueAt: "2026-08-13T00:00:00.000Z",
    });

    const first = await harness.loops.materializeDue("2026-08-13T00:00:00.000Z");
    const firstInvocation = first?.invocation;
    const firstTask = firstInvocation?.task as SparkDaemonLoopTickTask | undefined;
    if (!firstInvocation || firstTask?.type !== "loop.tick") {
      throw new Error("first stable driver tick was not materialized");
    }
    harness.invocations.claimNext("stable-driver-worker", "2026-08-13T00:00:00.000Z");
    await executor(firstTask, {
      invocationId: firstInvocation.invocationId,
      invocationAttempt: {
        epoch: 1,
        daemonGeneration: 1,
        correlationId: `attempt:${firstInvocation.invocationId}:1`,
      },
      signal: new AbortController().signal,
    });
    harness.loops.schedule(
      {
        loopId: firstTask.loopId,
        generation: firstTask.generation,
        delayMs: 1_000,
        reason: "continue with the same driver",
      },
      "2026-08-13T00:00:00.000Z",
    );
    harness.loops.completeTick(firstInvocation, firstTask, {
      status: "succeeded",
      now: "2026-08-13T00:00:01.000Z",
    });

    const second = await harness.loops.materializeDue("2026-08-13T00:00:01.000Z");
    const secondInvocation = second?.invocation;
    const secondTask = secondInvocation?.task as SparkDaemonLoopTickTask | undefined;
    if (!secondInvocation || secondTask?.type !== "loop.tick") {
      throw new Error("second stable driver tick was not materialized");
    }
    harness.invocations.claimNext("stable-driver-worker", "2026-08-13T00:00:01.000Z");
    await executor(secondTask, {
      invocationId: secondInvocation.invocationId,
      invocationAttempt: {
        epoch: 1,
        daemonGeneration: 1,
        correlationId: `attempt:${secondInvocation.invocationId}:1`,
      },
      signal: new AbortController().signal,
    });

    expect([firstTask.generation, secondTask.generation]).toEqual([1, 2]);
    expect(secondTask.sessionId).toBe(firstTask.sessionId);
    expect(executeSession).toHaveBeenCalledTimes(2);
    await expect(harness.registry.get(firstTask.sessionId)).resolves.toMatchObject({
      lifecycle: "open",
      lineage: {
        kind: "child",
        parentSessionId: harness.session.sessionId,
        origin: {
          kind: "driver",
          driverId: firstTask.loopId,
          generation: 1,
        },
      },
    });
  });

  it("does not stop a Loop that moved to another owner Session", async () => {
    const harness = await createHarness("first-loop-owner");
    harness.loops.start({
      loopId: "moved-driver-loop",
      ownerSessionId: harness.session.sessionId,
      sessionLifetime: "driver",
      cwd: harness.root,
      prompt: "first owner",
    });
    const first = harness.loops.require("moved-driver-loop");
    const oldDriver = await harness.registry.createSupervised({
      sessionId: first.driverSessionId,
      scope: harness.session.scope,
      lineage: {
        kind: "child",
        parentSessionId: harness.session.sessionId,
        origin: {
          kind: "driver",
          driverId: first.loopId,
          generation: first.generation,
        },
      },
      visibility: "internal",
      retention: "discard_on_close",
      purpose: "driver",
    });
    const secondOwner = await harness.registry.create({
      sessionId: "second-loop-owner",
      scope: { kind: "workspace", workspaceId: "ws-loop-lifecycle" },
      supervisorSessionId: harness.administrator.sessionId,
    });
    harness.loops.start({
      loopId: "moved-driver-loop",
      ownerSessionId: secondOwner.sessionId,
      sessionLifetime: "driver",
      cwd: harness.root,
      prompt: "second owner",
    });

    const quiesced = quiesceLoopsForClosingSession(
      harness.loops,
      harness.invocations,
      oldDriver,
      "old owner closed",
    );

    expect(quiesced).toEqual({ invocationSessionIds: [], stoppedLoops: [] });
    expect(harness.loops.require("moved-driver-loop")).toMatchObject({
      status: "scheduled",
      ownerSessionId: secondOwner.sessionId,
    });
  });
});

async function createHarness(sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), "spark-loop-session-lifecycle-"));
  roots.push(root);
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  const loops = new SparkLoopStore(db, invocations);
  const registry = createDaemonSessionRegistry(root, { resolveWorkspaceCwd: () => root });
  const administrator = await registry.ensureWorkspaceAdministrator("ws-loop-lifecycle");
  const session = await registry.create({
    sessionId,
    scope: { kind: "workspace", workspaceId: "ws-loop-lifecycle" },
    supervisorSessionId: administrator.sessionId,
  });
  return { root, invocations, loops, registry, administrator, session };
}
