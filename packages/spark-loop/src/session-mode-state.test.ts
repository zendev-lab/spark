import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { JsonStoreFormatError } from "./json-store.ts";
import { sessionStateStorePath } from "./session-directory-store.ts";
import {
  loadSparkSessionWorkspaceState,
  normalizeSparkSessionWorkspaceState,
  setSparkSessionDriverAuthority,
  setSparkSessionMode,
  SPARK_SESSION_WORKSPACE_STATE_VERSION,
} from "./session-mode-state.ts";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-workspace-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("v1 and v3 session workspace state migrate to v4", async () => {
  await withTempDir(async (dir) => {
    const ctx = { sessionId: "sess_migrate" };
    const path = sessionStateStorePath(dir, ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"version":1,"phase":"implement","projectRef":"proj:one"}\n', "utf8");

    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      projectRef: "proj:one",
      mode: "execute",
    });
    assert.match(await readFile(path, "utf8"), /"version": 4/u);

    await writeFile(path, '{"version":3,"mode":"fleet"}\n', "utf8");
    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      mode: "fleet",
    });
  });
});

test("v4 driverAuthority round-trips and survives mode writes", async () => {
  await withTempDir(async (dir) => {
    const ctx = { sessionId: "sess_authority" };
    await setSparkSessionDriverAuthority(dir, ctx, "granted");
    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      driverAuthority: "granted",
    });

    await setSparkSessionMode(dir, ctx, "execute");
    assert.deepEqual(await loadSparkSessionWorkspaceState(dir, ctx), {
      version: SPARK_SESSION_WORKSPACE_STATE_VERSION,
      mode: "execute",
      driverAuthority: "granted",
    });
  });
});

test("unknown workspace versions and invalid driverAuthority fail closed", () => {
  assert.throws(
    () => normalizeSparkSessionWorkspaceState({ version: 5, mode: "plan" }, "state.json"),
    (error: unknown) =>
      error instanceof JsonStoreFormatError && /version must be 1, 2, 3, or 4/.test(error.message),
  );
  assert.throws(
    () =>
      normalizeSparkSessionWorkspaceState({ version: 4, driverAuthority: "always" }, "state.json"),
    (error: unknown) =>
      error instanceof JsonStoreFormatError &&
      /driverAuthority must be granted or denied/.test(error.message),
  );
});
