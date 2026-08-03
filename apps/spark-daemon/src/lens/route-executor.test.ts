import { DatabaseSync } from "node:sqlite";

import {
  capabilityRoute,
  type LensProvider,
  type ProviderId,
  type ProviderVersion,
  type WorkspaceRevision,
} from "@zendev-lab/spark-lens";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonLensRouteExecutor } from "./route-executor.ts";
import { DaemonLensRuntime } from "./runtime.ts";
import { DaemonLensStateStore } from "./state-store.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";

const revision = {
  schemaVersion: 1,
  workspaceRoot: "/tmp/lens-route",
  headOid: "abc",
  trackedDiffDigest: "tracked",
  stagedDiffDigest: "staged",
  untrackedContentDigest: "untracked",
  profileDigest: "profile",
  digest: "revision",
  observedAt: "2026-07-31T00:00:00.000Z",
} satisfies WorkspaceRevision;

describe("DaemonLensRouteExecutor", () => {
  const runtimes: DaemonLensRuntime[] = [];
  const databases: DatabaseSync[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.close()));
    for (const db of databases.splice(0)) db.close();
  });

  test("uses fallback only after a non-affirmative owner result", async () => {
    const runtime = createRuntime();
    const owner = provider("owner", undefined);
    const fallback = provider("fallback", { targets: ["src/index.ts"] });
    runtime.register(owner);
    runtime.register(fallback);
    const executor = new DaemonLensRouteExecutor(runtime);

    const execution = await executor.execute({
      requestId: "navigate",
      route: capabilityRoute.fallback("navigate", owner.spec.id, [fallback.spec.id]),
      request: { capability: "navigate", input: {}, revision },
      timeoutMs: 1_000,
    });

    expect(execution.results.map((result) => result.status)).toEqual(["silent", "ok"]);
    expect(execution.selectedProviderId).toBe(fallback.spec.id);
  });

  function createRuntime(): DaemonLensRuntime {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateSparkDaemonDatabase(db);
    const runtime = new DaemonLensRuntime({
      stateStore: new DaemonLensStateStore(db),
    });
    runtimes.push(runtime);
    return runtime;
  }
});

function provider(id: string, result: unknown): LensProvider {
  const providerId = id as ProviderId;
  return {
    spec: {
      id: providerId,
      kind: "lsp",
      languages: ["typescript"],
      capabilities: [],
    },
    async open(workspace) {
      return {
        providerId,
        providerVersion: "1.0.0" as ProviderVersion,
        workspaceRoot: workspace.workspaceRoot,
        async request() {
          return result;
        },
        async health() {
          return { status: "healthy", checkedAt: new Date().toISOString() };
        },
        async close() {},
      };
    },
  };
}
