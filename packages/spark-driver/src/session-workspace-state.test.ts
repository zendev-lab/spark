import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, vi } from "vitest";

import { JsonStoreFormatError } from "./json-store.ts";
import { sessionIndexStorePath, sessionStateStorePath } from "./session-directory-store.ts";
import {
  loadSparkSessionWorkspaceState,
  normalizeSparkSessionWorkspaceState,
  sparkSessionWorkspaceState,
  setSparkSessionDriverAuthority,
  SPARK_SESSION_WORKSPACE_STATE_VERSION,
  updateSparkSessionWorkspaceState,
} from "./session-workspace-state.ts";

const indexWriteControl = vi.hoisted(() => ({
  beforeWrite: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./json-store.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./json-store.ts")>();
  return {
    ...original,
    async writeJsonFileAtomic(filePath: string, value: unknown) {
      if (/[/\\]sessions[/\\]index\.json$/u.test(filePath)) {
        await indexWriteControl.beforeWrite?.();
      }
      await original.writeJsonFileAtomic(filePath, value);
    },
  };
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-workspace-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("legacy session workspace state migrates to v5 and drops the retired mode field", async () => {
  await withTempDir(async (dir) => {
    const ctx = { sessionId: "sess_migrate" };
    const path = sessionStateStorePath(dir, ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"version":1,"phase":"implement","projectRef":"proj:one"}\n', "utf8");

    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      projectRef: "proj:one",
    });
    const rewritten = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(rewritten.version, SPARK_SESSION_WORKSPACE_STATE_VERSION);
    assert.equal("mode" in rewritten, false);
    assert.equal("phase" in rewritten, false);

    await writeFile(path, '{"version":4,"mode":"fleet","driverAuthority":"granted"}\n', "utf8");
    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      driverAuthority: "granted",
    });
  });
});

test("mode migration is idempotent and never interprets historical mode values", async () => {
  await withTempDir(async (dir) => {
    const ctx = { sessionId: "sess_idempotent" };
    const path = sessionStateStorePath(dir, ctx);
    await mkdir(dirname(path), { recursive: true });
    // An unrecognized legacy mode value is dropped unread instead of failing.
    await writeFile(path, '{"version":3,"mode":"obsolete","projectRef":"proj:two"}\n', "utf8");
    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      projectRef: "proj:two",
    });
    const once = await readFile(path, "utf8");
    // Re-loading the migrated file leaves the persisted bytes untouched.
    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      projectRef: "proj:two",
    });
    assert.equal(await readFile(path, "utf8"), once);
  });
});

test("v5 driverAuthority round-trips", async () => {
  await withTempDir(async (dir) => {
    const ctx = { sessionId: "sess_authority" };
    await setSparkSessionDriverAuthority(dir, ctx, "granted");
    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      driverAuthority: "granted",
    });
  });
});

test("a concurrent driver-authority change preserves a project mutation", async () => {
  await withTempDir(async (dir) => {
    const ctx = { sessionId: "sess_concurrent" };
    let releaseProject!: () => void;
    let projectMutationStarted!: () => void;
    const started = new Promise<void>((resolve) => (projectMutationStarted = resolve));
    const release = new Promise<void>((resolve) => (releaseProject = resolve));
    const projectMutation = updateSparkSessionWorkspaceState(dir, ctx, async (current) => {
      projectMutationStarted();
      await release;
      return sparkSessionWorkspaceState({
        ...(current?.driverAuthority ? { driverAuthority: current.driverAuthority } : {}),
        projectRef: "proj:concurrent",
      });
    });
    await started;
    const authorityMutation = setSparkSessionDriverAuthority(dir, ctx, "granted");

    releaseProject();
    await Promise.all([projectMutation, authorityMutation]);

    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      projectRef: "proj:concurrent",
      driverAuthority: "granted",
    });
  });
});

test("concurrent Session mutations leave the shared index complete", async () => {
  await withTempDir(async (dir) => {
    let firstIndexWrite = true;
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstWriteStarted = resolve));
    const release = new Promise<void>((resolve) => (releaseFirstWrite = resolve));
    indexWriteControl.beforeWrite = async () => {
      if (!firstIndexWrite) return;
      firstIndexWrite = false;
      firstWriteStarted();
      await release;
    };

    try {
      const firstMutation = updateSparkSessionWorkspaceState(dir, { sessionId: "session_a" }, () =>
        sparkSessionWorkspaceState({ projectRef: "proj:a" }),
      );
      await started;
      const secondMutation = updateSparkSessionWorkspaceState(dir, { sessionId: "session_b" }, () =>
        sparkSessionWorkspaceState({ projectRef: "proj:b" }),
      );
      await vi.waitFor(async () => {
        assert.match(
          await readFile(sessionStateStorePath(dir, { sessionId: "session_b" }), "utf8"),
          /proj:b/u,
        );
      });

      releaseFirstWrite();
      await Promise.all([firstMutation, secondMutation]);

      const index = JSON.parse(await readFile(sessionIndexStorePath(dir), "utf8")) as {
        sessions: Array<{ currentProjectRef?: string }>;
      };
      assert.deepEqual(
        new Set(index.sessions.map((entry) => entry.currentProjectRef)),
        new Set(["proj:a", "proj:b"]),
      );
    } finally {
      indexWriteControl.beforeWrite = undefined;
      releaseFirstWrite?.();
    }
  });
});

test("unknown workspace versions and invalid driverAuthority fail closed", () => {
  assert.throws(
    () => normalizeSparkSessionWorkspaceState({ version: 6, projectRef: "proj:x" }, "state.json"),
    (error: unknown) =>
      error instanceof JsonStoreFormatError &&
      /version must be 1, 2, 3, 4, or 5/.test(error.message),
  );
  assert.throws(
    () =>
      normalizeSparkSessionWorkspaceState(
        { version: SPARK_SESSION_WORKSPACE_STATE_VERSION, driverAuthority: "always" },
        "state.json",
      ),
    (error: unknown) =>
      error instanceof JsonStoreFormatError &&
      /driverAuthority must be granted or denied/.test(error.message),
  );
});
