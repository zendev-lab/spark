import { DatabaseSync } from "node:sqlite";

import type {
  LensProvider,
  LensProviderSession,
  ProviderId,
  ProviderVersion,
  WorkspaceRevision,
} from "@zendev-lab/spark-lens";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonLensRuntime } from "./runtime.ts";
import { DaemonLensStateStore } from "./state-store.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";

const providerId = "fixture" as ProviderId;
const providerVersion = "1.0.0" as ProviderVersion;
const revision = {
  schemaVersion: 1,
  workspaceRoot: "/tmp/lens-fixture",
  headOid: "abc",
  trackedDiffDigest: "tracked",
  stagedDiffDigest: "staged",
  untrackedContentDigest: "untracked",
  profileDigest: "profile",
  digest: "revision",
  observedAt: "2026-07-31T00:00:00.000Z",
} satisfies WorkspaceRevision;

describe("DaemonLensRuntime", () => {
  const databases: DatabaseSync[] = [];
  const runtimes: DaemonLensRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.close()));
    for (const db of databases.splice(0)) db.close();
  });

  test("owns provider sessions, cache, and SQLite result state", async () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateSparkDaemonDatabase(db);
    let opens = 0;
    const session: LensProviderSession = {
      providerId,
      providerVersion,
      workspaceRoot: revision.workspaceRoot,
      async request() {
        return { findings: [] };
      },
      async health() {
        return { status: "healthy", checkedAt: new Date().toISOString() };
      },
      async close() {},
    };
    const provider: LensProvider = {
      spec: {
        id: providerId,
        kind: "compiler",
        languages: ["typescript"],
        capabilities: [
          {
            capability: "diagnostics",
            quality: "stable",
            latency: "medium",
            supportsIncremental: false,
            mutation: "none",
          },
        ],
      },
      async open() {
        opens += 1;
        return session;
      },
    };
    const runtime = new DaemonLensRuntime({
      stateStore: new DaemonLensStateStore(db),
    });
    runtimes.push(runtime);
    runtime.register(provider);

    const request = { capability: "diagnostics" as const, input: {}, revision };
    const first = await runtime.run({
      requestId: "request-1",
      providerId,
      request,
      timeoutMs: 1_000,
    });
    const second = await runtime.run({
      requestId: "request-2",
      providerId,
      request,
      timeoutMs: 1_000,
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(opens).toBe(1);
    expect(runtime.cachedResult(providerId, request)).toMatchObject({
      providerId: "fixture",
      revisionDigest: "revision",
      status: "ok",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM lens_provider_results").get()).toEqual({
      count: 1,
    });
  });

  test("records provider silence as non-affirmative", async () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateSparkDaemonDatabase(db);
    const runtime = new DaemonLensRuntime({
      stateStore: new DaemonLensStateStore(db),
    });
    runtimes.push(runtime);
    runtime.register({
      spec: {
        id: providerId,
        kind: "compiler",
        languages: ["typescript"],
        capabilities: [],
      },
      async open() {
        return {
          providerId,
          providerVersion,
          workspaceRoot: revision.workspaceRoot,
          async request() {
            return undefined;
          },
          async health() {
            return { status: "healthy", checkedAt: new Date().toISOString() };
          },
          async close() {},
        };
      },
    });

    await expect(
      runtime.run({
        requestId: "silent",
        providerId,
        request: { capability: "diagnostics", input: {}, revision },
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "silent" });
  });
});
