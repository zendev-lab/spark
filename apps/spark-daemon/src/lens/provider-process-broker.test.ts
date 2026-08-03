import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";

import type { ProviderId, ProviderLaunchSpec, ProviderTrustGrant } from "@zendev-lab/spark-lens";
import { afterEach, describe, expect, test } from "vitest";

import {
  DaemonLensProcessBroker,
  providerProcessKey,
  type ManagedProviderProcess,
  type ProviderProcessIdentity,
} from "./provider-process-broker.ts";
import { DaemonLensStateStore } from "./state-store.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";

const providerId = "typescript-7-native" as ProviderId;

describe("DaemonLensProcessBroker", () => {
  const databases: DatabaseSync[] = [];
  const brokers: DaemonLensProcessBroker[] = [];

  afterEach(async () => {
    await Promise.all(brokers.splice(0).map(async (broker) => await broker.close()));
    for (const db of databases.splice(0)) db.close();
  });

  test("shares one process for four concurrent agents in the same worktree", async () => {
    let launches = 0;
    const broker = createBroker({
      async launcher() {
        launches += 1;
        return fakeProcess(100 + launches);
      },
    });
    const identity = processIdentity("/worktrees/a");

    const leases = await Promise.all(
      Array.from(
        { length: 4 },
        async () =>
          await broker.acquire({
            identity,
            launch: launchSpec(),
            trustGrant: trustGrant(),
          }),
      ),
    );

    expect(launches).toBe(1);
    expect(new Set(leases.map((lease) => lease.process.pid))).toEqual(new Set([101]));
    expect(broker.activeProcessCount()).toBe(1);
  });

  test("strictly isolates provider processes between worktrees", async () => {
    let launches = 0;
    const broker = createBroker({
      async launcher() {
        launches += 1;
        return fakeProcess(200 + launches);
      },
    });

    const [left, right] = await Promise.all([
      broker.acquire({
        identity: processIdentity("/worktrees/a"),
        launch: launchSpec("/worktrees/a"),
        trustGrant: trustGrant(),
      }),
      broker.acquire({
        identity: processIdentity("/worktrees/b"),
        launch: launchSpec("/worktrees/b"),
        trustGrant: trustGrant(),
      }),
    ]);

    expect(launches).toBe(2);
    expect(left.process.pid).not.toBe(right.process.pid);
  });

  test("denies untrusted project-local executables", async () => {
    const broker = createBroker({
      async launcher() {
        return fakeProcess(300);
      },
    });
    await expect(
      broker.acquire({
        identity: processIdentity("/worktrees/a"),
        launch: launchSpec(),
      }),
    ).rejects.toThrow(/grant_missing/);
    expect(broker.activeProcessCount()).toBe(0);
  });

  test("recovers only orphan processes whose wrapper marker is verified", async () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateSparkDaemonDatabase(db);
    const stateStore = new DaemonLensStateStore(db);
    const identity = processIdentity("/worktrees/a");
    const processKey = providerProcessKey(identity);
    stateStore.saveProviderProcess({
      processKey,
      providerId,
      worktreeRoot: identity.worktreeRoot,
      projectRoot: identity.projectRoot,
      configDigest: identity.configDigest,
      executableDigest: "exe",
      daemonInstanceId: "old-daemon",
      processMarker: "SPARK_LENS_PROVIDER_WRAPPER:owned",
      pid: 401,
      status: "running",
      startedAt: "2026-07-31T00:00:00.000Z",
      lastHeartbeatAt: "2026-07-31T00:00:00.000Z",
    });
    const terminated: number[] = [];
    const broker = new DaemonLensProcessBroker({
      stateStore,
      daemonInstanceId: "new-daemon",
      async inspectOwnedProcess(pid, marker) {
        return pid === 401 && marker.endsWith(":owned");
      },
      async terminateOrphan(pid) {
        terminated.push(pid);
      },
    });
    brokers.push(broker);

    await expect(broker.recoverOrphans()).resolves.toBe(1);
    expect(terminated).toEqual([401]);
    expect(stateStore.listProviderProcesses()[0]?.status).toBe("recovered");
  });

  function createBroker(
    options: Pick<ConstructorParameters<typeof DaemonLensProcessBroker>[0], "launcher">,
  ): DaemonLensProcessBroker {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateSparkDaemonDatabase(db);
    const broker = new DaemonLensProcessBroker({
      stateStore: new DaemonLensStateStore(db),
      heartbeatMs: 10_000,
      ...options,
    });
    brokers.push(broker);
    return broker;
  }
});

function processIdentity(worktreeRoot: string): ProviderProcessIdentity {
  return {
    providerId,
    worktreeRoot,
    projectRoot: worktreeRoot,
    configDigest: "config",
  };
}

function launchSpec(cwd = "/worktrees/a"): ProviderLaunchSpec {
  return {
    providerId,
    executable: "/project/node_modules/.bin/tsc",
    args: ["--lsp", "--stdio"],
    cwd,
    source: "project_local",
    executableDigest: "exe",
    configDigest: "config",
  };
}

function trustGrant(): ProviderTrustGrant {
  return {
    providerId,
    source: "project_local",
    executableDigest: "exe",
    configDigest: "config",
  };
}

function fakeProcess(pid: number): ManagedProviderProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  return {
    pid,
    stdin,
    stdout,
    stderr,
    exited,
    async terminate() {
      resolveExit({ code: 0, signal: null });
    },
  };
}
